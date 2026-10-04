import * as diagnostics from 'node:diagnostics_channel'
import { debug } from '../debug'
import { type Execution, currentExecution } from '../execution'
import { micros, now } from '../records/common'
import { buildOutgoingRequest } from '../records/outgoing-request'
import { getRuntime, processContext } from '../runtime'

interface UndiciRequest {
  origin?: string | URL
  path?: string
  method?: string
  headers?: string | string[]
  /** undici keeps the request's content-length here rather than among the headers. */
  contentLength?: number | null
}

interface Pending {
  execution: Execution | undefined
  timestamp: number
  startedMicros: number
  headersMicros: number
  status: number
  responseSize: number
  done: boolean
}

const PENDING = 'undici'
const pending = new WeakMap<object, Pending>()

function contentLength(headers: unknown): number {
  try {
    if (typeof headers === 'string') {
      const match = /^content-length:\s*(\d+)/im.exec(headers)
      return match ? Number(match[1]) : 0
    }
    if (Array.isArray(headers)) {
      for (let index = 0; index + 1 < headers.length; index += 2) {
        if (String(headers[index]).toLowerCase() === 'content-length') return Number(String(headers[index + 1])) || 0
      }
    }
  } catch {
    // fall through
  }
  return 0
}

function isOwnCall(origin: string): boolean {
  const { config, sink } = getRuntime()
  const ingest = (sink as { auth?: { peek(): { ingestUrl: string } | null } } | null)?.auth?.peek()?.ingestUrl
  for (const candidate of [config.baseUrl, ingest]) {
    if (!candidate) continue
    try {
      if (new URL(candidate).origin === origin) return true
    } catch {
      // not a URL
    }
  }
  return false
}

function finish(request: UndiciRequest, entry: Pending, endedMicros: number): void {
  if (entry.done) return
  entry.done = true
  const origin = String(request.origin ?? '')
  let host = origin
  try {
    host = new URL(origin).host
  } catch {
    // keep the raw origin
  }
  const execution = entry.execution
  const record = buildOutgoingRequest(execution?.context() ?? processContext(), {
    timestamp: entry.timestamp,
    host,
    method: String(request.method ?? 'GET').toUpperCase(),
    url: `${origin}${request.path ?? ''}`,
    duration: endedMicros - entry.startedMicros,
    requestSize: typeof request.contentLength === 'number' ? request.contentLength : contentLength(request.headers),
    responseSize: entry.responseSize,
    statusCode: entry.status,
  })
  if (execution !== undefined) execution.add(record)
  else getRuntime().sink?.enqueue([record])
}

function guarded<T>(label: string, handler: (message: T) => void): (message: unknown) => void {
  return (message) => {
    try {
      handler(message as T)
    } catch (error) {
      debug(`${label} failed:`, error)
    }
  }
}

/**
 * Records outgoing requests from undici's diagnostics channels — which is what `fetch` uses everywhere in Node —
 * without patching `fetch`. A request that fails before any response is recorded with `status_code: 0`.
 */
export function installUndiciSensor(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('undici')) return
  runtime.installed.add('undici')

  diagnostics.subscribe(
    'undici:request:create',
    guarded<{ request: UndiciRequest }>('undici create', ({ request }) => {
      const { sink, config } = getRuntime()
      if (sink === null || config.ignoreOutgoingRequests) return
      if (isOwnCall(String(request.origin ?? ''))) return
      const execution = currentExecution()
      const entry: Pending = {
        execution,
        timestamp: now(),
        startedMicros: micros(),
        headersMicros: 0,
        status: 0,
        responseSize: 0,
        done: false,
      }
      pending.set(request, entry)

      if (execution !== undefined && !execution.ended) {
        // A response whose body is never read gets no `trailers` event: settle it when the execution ends.
        let open = execution.meta[PENDING] as Set<() => void> | undefined
        if (open === undefined) {
          const created = new Set<() => void>()
          open = created
          execution.meta[PENDING] = created
          execution.onBeforeEnd(() => {
            for (const settle of created) settle()
            created.clear()
          })
        }
        open.add(() => {
          if (entry.headersMicros > 0) finish(request, entry, entry.headersMicros)
        })
      }
    }),
  )

  diagnostics.subscribe(
    'undici:request:headers',
    guarded<{ request: UndiciRequest; response: { statusCode?: number; headers?: unknown } }>(
      'undici headers',
      ({ request, response }) => {
        const entry = pending.get(request)
        if (entry === undefined) return
        entry.status = response.statusCode ?? 0
        entry.responseSize = contentLength(response.headers)
        entry.headersMicros = micros()
      },
    ),
  )

  diagnostics.subscribe(
    'undici:request:trailers',
    guarded<{ request: UndiciRequest }>('undici trailers', ({ request }) => {
      const entry = pending.get(request)
      if (entry !== undefined) finish(request, entry, micros())
    }),
  )

  diagnostics.subscribe(
    'undici:request:error',
    guarded<{ request: UndiciRequest }>('undici error', ({ request }) => {
      const entry = pending.get(request)
      // After the headers arrived the status is real; before, it is a connection failure: 0.
      if (entry !== undefined) finish(request, entry, micros())
    }),
  )
}
