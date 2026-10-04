import * as http from 'node:http'
import * as https from 'node:https'
import type { RequestInfo } from '../config'
import { debug } from '../debug'
import { type Execution, runExecution } from '../execution'
import { micros } from '../records/common'
import { buildRequest, redactHeaders } from '../records/request'
import { buildUser } from '../records/user'
import { getRuntime } from '../runtime'

/** What a framework layer (the Next span processor, `onRequestError`) tells the request sensor about a request. */
export interface RequestState {
  /** The request as it came in (method, path, raw headers). */
  request: RequestInfo
  /** Route pattern, e.g. `/deals/[id]`; `""` until known. */
  routePath: string
  /** `page` | `route` | `action` | `middleware` | `""`. */
  routeKind: string
  /** Module path shown after the kind in `route_action`, e.g. `app/deals/[id]/page`. */
  routeModule: string
  /** Microseconds spent in middleware / in render spans. */
  middlewareMicros: number
  renderMicros: number
  /** Framework spans still open; the request record waits (briefly) for them after the response closed. */
  openSpans: number
  /** Set by the sensor once the response closed; the span processor calls it when `openSpans` reaches 0. */
  onIdle: (() => void) | null
}

const STATE = 'request'

export function requestState(execution: Execution | undefined): RequestState | undefined {
  return execution?.meta[STATE] as RequestState | undefined
}

const STATIC_ASSET =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|wasm|pdf|zip)$/i
const WELL_KNOWN = new Set(['/favicon.ico', '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/manifest.json'])
const HEALTH = new Set([
  '/health',
  '/healthz',
  '/healthcheck',
  '/health-check',
  '/api/health',
  '/api/healthz',
  '/api/healthcheck',
  '/_health',
  '/livez',
  '/readyz',
  '/ping',
  '/up',
])
/** The route the browser client reports to (`doxa-watch/next/tunnel`). */
export const TUNNEL_PATH = '/api/doxa-watch'

/** Static assets, `/_next/*`, health checks and the tunnel are never recorded (spec §3.4). */
export function isIgnoredPath(path: string): boolean {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path
  return (
    clean.startsWith('/_next/') ||
    clean === '/_next' ||
    clean === TUNNEL_PATH ||
    clean.startsWith(`${TUNNEL_PATH}/`) ||
    WELL_KNOWN.has(clean) ||
    HEALTH.has(clean.toLowerCase()) ||
    clean.startsWith('/.well-known/') ||
    STATIC_ASSET.test(clean)
  )
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function describeRequest(request: http.IncomingMessage): RequestInfo {
  const headers = request.headers
  const raw = request.url ?? '/'
  const query = raw.indexOf('?')
  const path = query === -1 ? raw : raw.slice(0, query)
  const forwardedFor = first(headers['x-forwarded-for']).split(',')[0]?.trim() ?? ''
  const encrypted = (request.socket as { encrypted?: boolean } | undefined)?.encrypted === true
  const scheme = first(headers['x-forwarded-proto']).split(',')[0]?.trim() || (encrypted ? 'https' : 'http')
  const host = first(headers['x-forwarded-host']).split(',')[0]?.trim() || first(headers.host) || 'localhost'

  return {
    method: (request.method ?? 'GET').toUpperCase(),
    path,
    url: `${scheme}://${host}${raw}`,
    headers,
    ip: forwardedFor || request.socket?.remoteAddress || '',
  }
}

const GRACE_MS = 500

function observe(info: RequestInfo, response: http.ServerResponse, execution: Execution): void {
  const { config } = getRuntime()
  const state: RequestState = {
    request: info,
    routePath: '',
    routeKind: '',
    routeModule: '',
    middlewareMicros: 0,
    renderMicros: 0,
    openSpans: 0,
    onIdle: null,
  }
  execution.meta[STATE] = state

  // Set once the response closed; the record is written when nothing it depends on is still pending.
  let closedAt = 0
  let userPending = false
  const settle = (): void => {
    if (closedAt > 0 && !userPending && state.openSpans <= 0) complete(closedAt)
  }

  if (config.resolveUser) {
    try {
      userPending = true
      void Promise.resolve(config.resolveUser(info))
        .then(
          (user) => {
            if (user && execution.user === null) execution.setUser(user)
          },
          (error) => debug('resolveUser failed:', error),
        )
        .then(() => {
          userPending = false
          settle()
        })
    } catch (error) {
      userPending = false
      debug('resolveUser failed:', error)
    }
  }

  // Kept here: the response lets go of its socket once it has finished.
  const socket = response.socket
  const bytesBefore = socket?.bytesWritten ?? 0
  let finished = false

  const complete = (closed: number): void => {
    if (finished) return
    finished = true
    state.onIdle = null
    try {
      execution.end(() => {
        const total = Math.max(closed - execution.startedMicros, 0)
        const beforeMiddleware = Math.min(state.middlewareMicros, total)
        const render = Math.min(state.renderMicros, total - beforeMiddleware)

        let headers = redactHeaders(info.headers, config.redactHeaders)
        let url = info.url
        let ip = info.ip
        if (config.redactRequest) {
          try {
            const input = { url, ip, headers }
            const result = config.redactRequest(input) ?? input
            url = String(result.url)
            ip = String(result.ip)
            headers = result.headers
          } catch (error) {
            debug('redactRequest failed:', error)
          }
        }

        const declared = Number(response.getHeader('content-length'))
        const headerBytes = ((response as unknown as { _header?: string })._header ?? '').length
        const written = (socket?.bytesWritten ?? bytesBefore) - bytesBefore - headerBytes
        const kind = state.routeKind
        const request = buildRequest({
          timestamp: execution.startedAt,
          deploy: config.deploy,
          server: config.server,
          traceId: execution.traceId,
          user: execution.userId(),
          method: info.method,
          url,
          routePath: state.routePath,
          routeAction: kind === '' ? '' : state.routeModule === '' ? kind : `${kind} ${state.routeModule}`,
          ip,
          statusCode: response.statusCode,
          requestSize: Number(first(info.headers['content-length'])) || 0,
          responseSize: Number.isFinite(declared) && declared > 0 ? declared : Math.max(written, 0),
          beforeMiddleware,
          action: total - beforeMiddleware - render,
          render,
          counters: execution.counters,
          peakMemoryUsage: process.memoryUsage.rss(),
          exceptionPreview: execution.exceptionPreview,
          headers,
        })
        // PROTOCOL §4.2: the user record is written just before the request record.
        return execution.user === null ? [request] : [buildUser(execution.user), request]
      })
    } catch (error) {
      debug('request record failed:', error)
    }
  }

  response.once('close', () => {
    closedAt = micros()
    // The framework's root span carries the route and may end a moment after the socket closed; `resolveUser` may
    // still be looking the session up. Both get a short grace period, then the record is written without them.
    state.onIdle = settle
    settle()
    if (!finished) setTimeout(() => complete(closedAt), GRACE_MS).unref()
  })
}

type Emit = (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean

function patch(prototype: { emit: Emit }): void {
  const original = prototype.emit
  prototype.emit = function emit(this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event !== 'request') return original.call(this, event, ...args)

    let info: RequestInfo | null = null
    try {
      const runtime = getRuntime()
      if (runtime.sink !== null) {
        const described = describeRequest(args[0] as http.IncomingMessage)
        if (!isIgnoredPath(described.path) && runtime.config.ignore?.(described) !== true) info = described
      }
    } catch (error) {
      debug('request sensor failed:', error)
      info = null
    }
    if (info === null) return original.call(this, event, ...args)

    const request = info
    return runExecution({ source: 'request', preview: `${request.method} ${request.path}` }, (execution) => {
      try {
        observe(request, args[1] as http.ServerResponse, execution)
      } catch (error) {
        debug('request sensor failed:', error)
      }
      return original.call(this, event, ...args)
    })
  }
}

/**
 * Opens an execution for every request any `http.Server` / `https.Server` in this process receives, by wrapping the
 * server's `request` event. Everything the app does while handling the request runs inside that execution.
 */
export function installHttpSensor(): void {
  const { installed } = getRuntime()
  if (installed.has('http')) return
  installed.add('http')
  patch(http.Server.prototype as unknown as { emit: Emit })
  patch(https.Server.prototype as unknown as { emit: Emit })
}
