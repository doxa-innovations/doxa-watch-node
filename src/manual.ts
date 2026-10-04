import { randomUUID } from 'node:crypto'
import { captureError } from './capture'
import { debug } from './debug'
import { Execution, type ExecutionInit, currentExecution } from './execution'
import { type WireRecord, micros } from './records/common'
import { buildCommand, buildJobAttempt, buildScheduledTask } from './records/jobs'
import { register } from './register'
import { getRuntime } from './runtime'

export interface JobOptions {
  /** Queue name; `""` when omitted. */
  queue?: string
  /** Queue connection (`redis`, `database`, …); `""` when omitted. */
  connection?: string
  /** 1-based attempt number. Default 1. */
  attempt?: number
  /** The job's id in your queue, shared by all its attempts. Default: a fresh UUID. */
  jobId?: string
}

export interface ScheduledTaskOptions {
  /** Time zone the cron expression is read in. Default: the process's time zone. */
  timezone?: string
}

interface Outcome {
  failed: boolean
  /** Microseconds. */
  duration: number
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : String(message ?? '')
  }
  return String(error)
}

function tail(execution: Execution): { counters: Execution['counters']; peakMemoryUsage: number; exceptionPreview: string } {
  return { counters: execution.counters, peakMemoryUsage: process.memoryUsage.rss(), exceptionPreview: execution.exceptionPreview }
}

function processTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Runs `fn` inside a new execution and ends it with the parent record `build` returns, once `fn` has returned,
 * thrown, resolved or rejected. A thrown error is reported as an unhandled exception of that execution and
 * rethrown. With the SDK inert, `fn` simply runs.
 */
function supervise<T>(
  open: (parent: Execution | undefined) => ExecutionInit,
  fn: () => T,
  build: (execution: Execution, outcome: Outcome) => WireRecord,
  prepare?: (execution: Execution, parent: Execution | undefined) => void,
): T {
  let opened: Execution | undefined
  try {
    if (getRuntime().sink !== null) {
      const parent = currentExecution()
      opened = new Execution(open(parent))
      prepare?.(opened, parent)
    }
  } catch (error) {
    debug('opening an execution failed:', error)
  }
  if (opened === undefined) return fn()
  const execution = opened

  const settle = (failed: boolean, error?: unknown): void => {
    try {
      if (failed) {
        captureError(error, { handled: false, execution })
        // An error already reported further in (a job inside a command) is not recorded twice, but still named here.
        if (execution.exceptionPreview === '') execution.exceptionPreview = messageOf(error)
      }
      const duration = micros() - execution.startedMicros
      execution.end(() => [build(execution, { failed, duration })])
    } catch (failure) {
      debug('ending an execution failed:', failure)
    }
  }

  let result: T
  try {
    result = getRuntime().als.run(execution, fn)
  } catch (error) {
    settle(true, error)
    throw error
  }
  if (isThenable(result)) {
    return result.then(
      (value) => {
        settle(false)
        return value
      },
      (error: unknown) => {
        settle(true, error)
        throw error
      },
    ) as T
  }
  settle(false)
  return result
}

/**
 * Runs `fn` as one attempt of a job and reports it as a `job-attempt` record (`processed`, or `failed` when `fn`
 * throws or rejects — the error is reported and rethrown). Queries, fetches, logs and exceptions inside attach to the
 * attempt. Inside a request the attempt keeps the request's trace id. Returns what `fn` returns.
 */
export function job<T>(name: string, fn: () => T): T
export function job<T>(name: string, options: JobOptions | undefined | null, fn: () => T): T
export function job<T>(name: string, optionsOrFn: JobOptions | undefined | null | (() => T), maybeFn?: () => T): T {
  const fn = (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as () => T
  const options: JobOptions = (typeof optionsOrFn === 'function' ? undefined : optionsOrFn) ?? {}

  return supervise(
    (parent) => ({
      source: 'job',
      preview: String(name),
      // PROTOCOL §4.7: the dispatcher's trace id, with an execution id of its own.
      traceId: parent?.traceId,
      sampled: parent?.sampled ?? true,
    }),
    fn,
    (execution, outcome) => {
      const { config } = getRuntime()
      return buildJobAttempt({
        timestamp: execution.startedAt,
        deploy: config.deploy,
        server: config.server,
        traceId: execution.traceId,
        user: execution.userId(),
        jobId: typeof options.jobId === 'string' && options.jobId !== '' ? options.jobId : randomUUID(),
        attemptId: execution.id,
        attempt: options.attempt ?? 1,
        name: String(name),
        connection: String(options.connection ?? ''),
        queue: String(options.queue ?? ''),
        status: outcome.failed ? 'failed' : 'processed',
        duration: outcome.duration,
        ...tail(execution),
      })
    },
    (execution, parent) => {
      // PROTOCOL §5.4: a job belongs to the user of the execution that started it.
      if (parent?.user) execution.setUser(parent.user)
    },
  )
}

/**
 * Runs `fn` as one run of a scheduled task and reports it as a `scheduled-task` record (`processed` or `failed`).
 * `cron` is the task's 5-field expression. Every run is a trace of its own. Returns what `fn` returns.
 */
export function scheduledTask<T>(name: string, cron: string, fn: () => T, options: ScheduledTaskOptions = {}): T {
  const timezone = typeof options?.timezone === 'string' && options.timezone !== '' ? options.timezone : processTimezone()

  return supervise(
    // PROTOCOL §4.1: `execution_preview` is `""` for scheduled tasks.
    () => ({ source: 'schedule', preview: '', sampled: true }),
    fn,
    (execution, outcome) => {
      const { config } = getRuntime()
      return buildScheduledTask({
        timestamp: execution.startedAt,
        deploy: config.deploy,
        server: config.server,
        traceId: execution.traceId,
        name: String(name),
        cron: String(cron),
        timezone,
        status: outcome.failed ? 'failed' : 'processed',
        duration: outcome.duration,
        ...tail(execution),
      })
    },
  )
}

/**
 * Runs `fn` as a command — what a standalone script (`node scripts/import.js`) wraps its work in — and reports it as
 * a `command` record with exit code 0, or 1 when `fn` throws or rejects (the error is reported and rethrown).
 * Starts the collector when nothing registered yet, and sends everything before it returns.
 */
export async function command<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    if (!getRuntime().registered) register()
  } catch (error) {
    debug('watch.command could not register:', error)
  }

  try {
    return await supervise(
      () => ({ source: 'command', preview: String(name), sampled: true }),
      fn,
      (execution, outcome) => {
        const { config } = getRuntime()
        return buildCommand({
          timestamp: execution.startedAt,
          deploy: config.deploy,
          server: config.server,
          traceId: execution.traceId,
          name: String(name),
          command: [String(name), ...process.argv.slice(2)].join(' '),
          exitCode: outcome.failed ? 1 : 0,
          duration: outcome.duration,
          ...tail(execution),
        })
      },
    )
  } finally {
    try {
      const { sink, config } = getRuntime()
      // Bounded: a script must not hang on an unreachable Doxa Watch.
      await sink?.flush(config.connectTimeoutMs + config.requestTimeoutMs)
    } catch (error) {
      debug('watch.command could not flush:', error)
    }
  }
}
