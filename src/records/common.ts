import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

/**
 * A record exactly as it goes on the wire (PROTOCOL §4): a flat object, every key always present, never null.
 */
export type WireRecord = { v: number; t: string; timestamp: number } & Record<string, unknown>

export type ExecutionSource = 'request' | 'command' | 'job' | 'schedule' | 'browser'

export type ExecutionStage =
  | 'bootstrap'
  | 'before_middleware'
  | 'action'
  | 'render'
  | 'after_middleware'
  | 'sending'
  | 'terminating'
  | 'end'

/** The common fields a child record takes from the execution it was produced in (PROTOCOL §4.1). */
export interface RecordContext {
  deploy: string
  server: string
  traceId: string
  executionSource: ExecutionSource
  executionId: string
  executionPreview: string
  executionStage: ExecutionStage
  /** User id, `""` for guests. */
  user: string
}

export const TINY_TEXT = 255
export const TEXT = 65_535
export const MEDIUM_TEXT = 16_777_215

/** `_group`: 32 lowercase hex characters. The Node SDK hashes PROTOCOL's identity strings with MD5 (§9.2). */
export function group(identity: string): string {
  return createHash('md5').update(identity).digest('hex')
}

/** Truncates by bytes, not characters, without leaving half a character behind. */
export function truncate(value: unknown, bytes: number): string {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  if (text.length * 3 <= bytes) return text
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= bytes) return text
  let end = bytes
  // Step back to a character boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

/** Unix epoch seconds as a float with microsecond precision. */
export function now(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1_000_000
}

/** Monotonic microseconds, for durations. */
export function micros(): number {
  return Math.round(performance.now() * 1000)
}

/** Non-negative integer; anything else becomes 0. */
export function int(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/** JSON for a `string (JSON)` field, limited to `bytes`; the fallback mirrors the PHP collector's error object. */
export function jsonText(value: unknown, bytes: number, what: string): string {
  try {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString()
      if (item instanceof Error) return { class: item.name, message: item.message }
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`
      if (item !== null && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
    return truncate(text ?? '{}', bytes)
  } catch {
    return `{"_nightwatch_error":"Failed to serialize ${what}"}`
  }
}

/** `deploy`, `server`, `trace_id`, the four `execution_*` fields and `user`, in wire order. */
export function childFields(context: RecordContext, groupHash: string | null): Record<string, unknown> {
  return {
    deploy: truncate(context.deploy, TINY_TEXT),
    server: truncate(context.server, TINY_TEXT),
    ...(groupHash === null ? {} : { _group: groupHash }),
    trace_id: context.traceId,
    execution_source: context.executionSource,
    execution_id: context.executionId,
    execution_preview: truncate(context.executionPreview, TINY_TEXT),
    execution_stage: context.executionStage,
    user: truncate(context.user, TINY_TEXT),
  }
}

/** The shared execution counters of the four parent record types (PROTOCOL §4.1). */
export interface Counters {
  exceptions: number
  logs: number
  queries: number
  jobs_queued: number
  mail: number
  notifications: number
  outgoing_requests: number
  cache_events: number
}

export function emptyCounters(): Counters {
  return {
    exceptions: 0,
    logs: 0,
    queries: 0,
    jobs_queued: 0,
    mail: 0,
    notifications: 0,
    outgoing_requests: 0,
    cache_events: 0,
  }
}

/** Which counter a child record type increments. */
export const COUNTER_OF: Record<string, keyof Counters> = {
  exception: 'exceptions',
  log: 'logs',
  query: 'queries',
  'queued-job': 'jobs_queued',
  mail: 'mail',
  notification: 'notifications',
  'outgoing-request': 'outgoing_requests',
  'cache-event': 'cache_events',
}

export interface ParentTail {
  counters: Counters
  peakMemoryUsage: number
  exceptionPreview: string
  /** Already a JSON string; `"{}"` when empty. */
  context?: string
}

/** Counters, `peak_memory_usage`, `exception_preview`, `context` — the tail every parent record ends with, in wire order. */
export function parentTail(tail: ParentTail): Record<string, unknown> {
  const c = tail.counters
  return {
    exceptions: int(c.exceptions),
    logs: int(c.logs),
    queries: int(c.queries),
    lazy_loads: 0,
    jobs_queued: int(c.jobs_queued),
    mail: int(c.mail),
    notifications: int(c.notifications),
    outgoing_requests: int(c.outgoing_requests),
    files_read: 0,
    files_written: 0,
    cache_events: int(c.cache_events),
    hydrated_models: 0,
    peak_memory_usage: int(tail.peakMemoryUsage),
    exception_preview: truncate(tail.exceptionPreview, TINY_TEXT),
    context: tail.context ?? '{}',
  }
}
