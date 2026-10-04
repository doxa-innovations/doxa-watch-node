// doxa-watch/next/tunnel — the same-origin route the browser client reports to. The browser never holds the
// environment token: it posts small JSON batches here, and the records are built and sent from the server.
//
//   // app/api/doxa-watch/route.ts
//   export { POST } from 'doxa-watch/next/tunnel'
import { isAbsolute, resolve } from 'node:path'
import type { Config, RequestInfo, WatchUser } from '../../config'
import { debug } from '../../debug'
import type { RecordContext, WireRecord } from '../../records/common'
import { buildException } from '../../records/exception'
import { buildUser } from '../../records/user'
import { buildWebVital } from '../../records/web-vital'
import { getRuntime } from '../../runtime'
import { resolveStack } from '../../stacktrace/sourcemaps'
import { isSampled } from '../client/send'
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MINUTE, RateLimiter, isSameOrigin, readBody } from './limits'
import { parseUserAgent } from './user-agent'
import { type BrowserReport, parseReport } from './validate'

export { RateLimiter, isSameOrigin, MAX_BODY_BYTES, RATE_LIMIT_PER_MINUTE } from './limits'
export { parseUserAgent, type ParsedUserAgent } from './user-agent'
export { parseReport, type BrowserError, type BrowserReport, type BrowserVital } from './validate'

/** Where `doxa-watch postbuild` puts the browser source maps, relative to the project root. */
export const BROWSER_MAPS_DIR = '.next/doxa-watch/maps'

const RESOLVE_USER_BUDGET_MS = 2000

export interface TunnelOptions {
  /** Who is this visitor? Default: the `resolveUser` given to `register()`. It sees the tunnel request (cookies included). */
  resolveUser?: Config['resolveUser']
  /** Folder with the browser source maps; relative paths are taken from the project root. Default `.next/doxa-watch/maps`. */
  mapsDir?: string
  /** Posts accepted per client IP per minute. Default 60. */
  rateLimit?: number
  /** Largest accepted body in bytes. Default 65,536. */
  maxBodyBytes?: number
}

function done(): Response {
  // Always the same answer: a page (or anyone probing) learns nothing from it.
  return new Response(null, { status: 204 })
}

function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'unknown'
}

function describe(request: Request, ip: string): RequestInfo {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  let path = '/'
  let search = ''
  try {
    const url = new URL(request.url)
    path = url.pathname
    search = url.search
  } catch {
    // keep the defaults
  }
  const scheme = headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http'
  const host = headers['x-forwarded-host']?.split(',')[0]?.trim() || headers.host || 'localhost'
  return { method: 'POST', path, url: `${scheme}://${host}${path}${search}`, headers, ip: ip === 'unknown' ? '' : ip }
}

async function userOf(resolveUser: Config['resolveUser'], info: RequestInfo): Promise<WatchUser | null> {
  if (resolveUser === undefined) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const user = await Promise.race([
      Promise.resolve(resolveUser(info)),
      new Promise<null>((settle) => {
        timer = setTimeout(() => settle(null), RESOLVE_USER_BUDGET_MS)
        timer.unref?.()
      }),
    ])
    return user ? { ...user, id: String(user.id) } : null
  } catch (error) {
    debug('tunnel: resolveUser failed:', error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The records of one browser report: `exception`s, `web-vital`s, then the `user` record when there is a user. */
export function buildBrowserRecords(
  report: BrowserReport,
  options: { config: Config; userAgent: string | null; user: WatchUser | null; mapsDir?: string },
): { exceptions: WireRecord[]; vitals: WireRecord[] } {
  const { config, user } = options
  const agent = parseUserAgent(options.userAgent)
  const userId = user === null ? '' : String(user.id)
  const mapsDir = options.mapsDir ?? BROWSER_MAPS_DIR
  const mapDirs = [isAbsolute(mapsDir) ? mapsDir : resolve(config.projectRoot, mapsDir)]

  const exceptions: WireRecord[] = []
  for (const error of report.errors) {
    if (Math.random() >= config.exceptionSampleRate) continue
    // PROTOCOL §9.4: a browser execution is the page load; it has no parent record.
    const context: RecordContext = {
      deploy: config.deploy,
      server: config.server,
      traceId: report.id,
      executionSource: 'browser',
      executionId: report.id,
      executionPreview: `PAGE ${error.route}`,
      executionStage: 'action',
      user: userId,
    }
    exceptions.push(
      buildException(context, {
        class: error.name,
        message: error.message,
        code: error.code,
        stack: resolveStack(
          { stack: error.stack },
          { projectRoot: config.projectRoot, mapDirs, captureSource: config.captureExceptionSourceCode, remote: true },
        ),
        handled: error.handled,
        runtime: 'browser',
        runtimeVersion: agent.browser,
        framework: config.framework,
      }),
    )
  }

  const vitals: WireRecord[] = []
  // The per-page-load decision (the browser makes the same one when it was given the rate).
  if (isSampled(report.id, config.vitalsSampleRate)) {
    for (const vital of report.vitals) {
      vitals.push(
        buildWebVital({
          deploy: config.deploy,
          server: config.server,
          traceId: report.id,
          user: userId,
          routePath: vital.route,
          path: vital.path,
          name: vital.name,
          value: vital.value,
          rating: vital.rating,
          navigationType: vital.navigationType,
          device: agent.device,
          browser: agent.browser,
        }),
      )
    }
  }

  return { exceptions, vitals }
}

/**
 * Builds the `POST` handler of the tunnel route. Every outcome answers `204` with an empty body: a post that is
 * cross-origin, too large, over the rate limit or malformed is dropped and nothing is forwarded; so is everything
 * while the SDK is inert (no token). Never throws.
 */
export function createTunnel(options: TunnelOptions = {}): (request: Request) => Promise<Response> {
  const limiter = new RateLimiter(options.rateLimit ?? RATE_LIMIT_PER_MINUTE)
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES

  return async function POST(request: Request): Promise<Response> {
    try {
      const runtime = getRuntime()
      const sink = runtime.sink
      if (sink === null) return done()
      if (!isSameOrigin(request.headers)) return done()
      const ip = clientIp(request.headers)
      if (!limiter.allow(ip)) return done()
      const body = await readBody(request, maxBodyBytes)
      if (body === null) return done()
      const report = parseReport(body)
      if (report === null || report.errors.length + report.vitals.length === 0) return done()

      const { config } = runtime
      const user = await userOf(options.resolveUser ?? config.resolveUser, describe(request, ip))
      const { exceptions, vitals } = buildBrowserRecords(report, {
        config,
        userAgent: request.headers.get('user-agent'),
        user,
        mapsDir: options.mapsDir,
      })
      if (exceptions.length + vitals.length === 0) return done()

      // Exceptions go at once, like every exception; vitals wait for the next flush. The `user` record is written
      // last, as it is for a request (PROTOCOL §4.2).
      const tail = user === null ? [] : [buildUser(user)]
      if (exceptions.length > 0) sink.enqueue(exceptions, { immediate: true })
      if (vitals.length + tail.length > 0) sink.enqueue([...vitals, ...tail])
    } catch (error) {
      debug('tunnel failed:', error)
    }
    return done()
  }
}

/** The route handler: `export { POST } from 'doxa-watch/next/tunnel'`. */
export const POST: (request: Request) => Promise<Response> = createTunnel()
