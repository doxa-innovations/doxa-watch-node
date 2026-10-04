import { randomUUID } from 'node:crypto'
import type { WatchUser } from './config'
import { debug } from './debug'
import {
  COUNTER_OF,
  type Counters,
  type ExecutionSource,
  type ExecutionStage,
  type RecordContext,
  type WireRecord,
  emptyCounters,
  micros,
  now,
} from './records/common'
import { getRuntime, processContext } from './runtime'

/** Child records an execution keeps while its sampling decision can still change (PROTOCOL §1.5). */
export const EXECUTION_BUFFER = 500

export interface ExecutionInit {
  source: ExecutionSource
  /** Defaults to a fresh UUID. */
  id?: string
  /** Defaults to `id` (request, command, schedule); a job passes its dispatcher's trace id. */
  traceId?: string
  /** `"GET /users"`, a command name, a job name. */
  preview?: string
  /** Defaults to a roll of the dice with `sampleRate`. */
  sampled?: boolean
  /** Defaults to the configured request sample rate. */
  sampleRate?: number
  stage?: ExecutionStage
}

/**
 * The unit that owns child records, a sampling decision and a user: a request, a job attempt, a scheduled task or a
 * command (spec §3.3). Children buffer here and go to the transport when the execution ends — or nowhere when it was
 * not sampled.
 */
export class Execution {
  readonly id: string
  readonly traceId: string
  readonly source: ExecutionSource
  preview: string
  stage: ExecutionStage
  sampled: boolean
  ended = false
  user: WatchUser | null = null
  readonly counters: Counters = emptyCounters()
  /** Message of the last unhandled exception. */
  exceptionPreview = ''
  /** Epoch seconds. */
  readonly startedAt: number = now()
  /** Monotonic microseconds, for durations. */
  readonly startedMicros: number = micros()
  /** Scratch space for sensors (route information, pending outgoing requests, …), keyed by sensor. */
  readonly meta: Record<string, unknown> = {}
  private buffer: WireRecord[] = []
  private beforeEnd: (() => void)[] = []

  constructor(init: ExecutionInit) {
    const runtime = getRuntime()
    this.id = init.id ?? randomUUID()
    this.traceId = init.traceId ?? this.id
    this.source = init.source
    this.preview = init.preview ?? ''
    this.stage = init.stage ?? 'action'
    this.sampled = init.sampled ?? Math.random() < (init.sampleRate ?? runtime.config.requestSampleRate)
  }

  /** The common fields for a child record produced right now. */
  context(): RecordContext {
    const { config } = getRuntime()
    return {
      deploy: config.deploy,
      server: config.server,
      traceId: this.traceId,
      executionSource: this.source,
      executionId: this.id,
      executionPreview: this.preview,
      executionStage: this.stage,
      user: this.userId(),
    }
  }

  userId(): string {
    return this.user === null ? '' : String(this.user.id)
  }

  /** Adds a child record and counts it. Unsampled: a ring of the 500 most recent. Sampled: a full buffer is sent. */
  add(record: WireRecord): void {
    const counter = COUNTER_OF[record.t]
    if (counter !== undefined) this.counters[counter]++

    if (this.ended) {
      // A late child (an un-awaited fetch finishing after the response): still worth sending on its own.
      if (this.sampled) this.hand([record])
      return
    }

    this.buffer.push(record)
    if (this.buffer.length < EXECUTION_BUFFER) return
    if (this.sampled) {
      this.hand(this.buffer)
      this.buffer = []
    } else {
      this.buffer.shift()
    }
  }

  /**
   * An exception record: counted, given the second chance (PROTOCOL §5.1) when the execution was not sampled, and
   * sent immediately in its own batch entry. Returns whether it was sent.
   */
  report(record: WireRecord, options: { handled: boolean; message?: string }): boolean {
    this.counters.exceptions++
    if (!options.handled && options.message !== undefined) this.exceptionPreview = options.message
    if (!this.sampled && Math.random() < getRuntime().config.exceptionSampleRate) this.sample()
    if (!this.sampled) return false
    this.hand([record], true)
    return true
  }

  /** Turns sampling on for the whole execution, including the children buffered so far. */
  sample(): void {
    this.sampled = true
  }

  setUser(user: WatchUser | null): void {
    this.user = user
  }

  /** Runs just before the execution ends, while children can still be added (sensors flush pending work here). */
  onBeforeEnd(callback: () => void): void {
    this.beforeEnd.push(callback)
  }

  /**
   * Ends the execution: sampled → buffered children, then `parents` (the `user` record and the parent record, in
   * that order) go to the transport; not sampled → everything is discarded.
   */
  end(parents: WireRecord[] | (() => WireRecord[]) = []): void {
    if (this.ended) return
    for (const callback of this.beforeEnd) {
      try {
        callback()
      } catch (error) {
        debug('execution end callback failed:', error)
      }
    }
    this.ended = true
    const children = this.buffer
    this.buffer = []
    if (!this.sampled) return
    let tail: WireRecord[] = []
    try {
      tail = typeof parents === 'function' ? parents() : parents
    } catch (error) {
      debug('building the parent record failed:', error)
    }
    this.hand([...children, ...tail])
  }

  private hand(records: WireRecord[], immediate = false): void {
    if (records.length === 0) return
    // The user is resolved late (PROTOCOL §4.1): a login during the request still attributes earlier records.
    const user = this.userId()
    if (user !== '') {
      for (const record of records) {
        if (record.t !== 'user' && record.user === '') record.user = user
      }
    }
    getRuntime().sink?.enqueue(records, immediate ? { immediate: true } : undefined)
  }
}

/**
 * Opens an execution and runs `fn` inside it: everything `fn` starts (awaits, timers, callbacks) sees it through
 * `currentExecution()`. The caller ends it — `execution.end([...])` — once the parent record can be built.
 */
export function runExecution<T>(init: ExecutionInit, fn: (execution: Execution) => T): T {
  const execution = new Execution(init)
  return getRuntime().als.run(execution, () => fn(execution))
}

export function currentExecution(): Execution | undefined {
  return getRuntime().als.getStore()
}

/** Common fields for a child record produced here: the current execution's, or the per-process pseudo-command's. */
export function currentContext(): RecordContext {
  return currentExecution()?.context() ?? processContext()
}

/** Routes a child record: into the current execution, or straight to the transport when there is none. */
export function emit(record: WireRecord): void {
  const execution = currentExecution()
  if (execution !== undefined) {
    execution.add(record)
    return
  }
  getRuntime().sink?.enqueue([record])
}
