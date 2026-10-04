import { type ParentTail, TINY_TEXT, type WireRecord, group, int, parentTail, truncate } from './common'

/** What every parent record built by the manual API starts from. */
interface ParentInput extends ParentTail {
  /** Start of the execution, epoch seconds. */
  timestamp: number
  deploy: string
  server: string
  traceId: string
  /** Microseconds. */
  duration: number
}

export type JobStatus = 'processed' | 'released' | 'failed'

export interface JobAttemptInput extends ParentInput {
  user: string
  /** Joins a `queued-job` record to its attempts. */
  jobId: string
  /** = `execution_id` of every child record of this attempt. */
  attemptId: string
  /** 1-based. */
  attempt: number
  name: string
  connection: string
  queue: string
  status: JobStatus
}

/** PROTOCOL §4.7. */
export function buildJobAttempt(input: JobAttemptInput): WireRecord {
  return {
    v: 1,
    t: 'job-attempt',
    timestamp: input.timestamp,
    deploy: truncate(input.deploy, TINY_TEXT),
    server: truncate(input.server, TINY_TEXT),
    _group: group(input.name),
    trace_id: input.traceId,
    user: truncate(input.user, TINY_TEXT),
    job_id: input.jobId,
    attempt_id: input.attemptId,
    attempt: Math.max(1, int(input.attempt)),
    name: input.name,
    connection: input.connection,
    queue: input.queue,
    status: input.status,
    duration: int(input.duration),
    ...parentTail(input),
  }
}

export type ScheduledTaskStatus = 'processed' | 'failed' | 'skipped'

export interface ScheduledTaskInput extends ParentInput {
  name: string
  /** 5-field expression. */
  cron: string
  timezone: string
  repeatSeconds?: number
  withoutOverlapping?: boolean
  onOneServer?: boolean
  runInBackground?: boolean
  evenInMaintenanceMode?: boolean
  status: ScheduledTaskStatus
}

/** PROTOCOL §4.5. */
export function buildScheduledTask(input: ScheduledTaskInput): WireRecord {
  const repeatSeconds = int(input.repeatSeconds)
  const identity = `${input.name},${input.cron},${input.timezone}`

  return {
    v: 1,
    t: 'scheduled-task',
    timestamp: input.timestamp,
    deploy: truncate(input.deploy, TINY_TEXT),
    server: truncate(input.server, TINY_TEXT),
    _group: group(repeatSeconds > 0 ? `${identity},${repeatSeconds}` : identity),
    trace_id: input.traceId,
    name: input.name,
    cron: input.cron,
    timezone: input.timezone,
    repeat_seconds: repeatSeconds,
    without_overlapping: input.withoutOverlapping === true,
    on_one_server: input.onOneServer === true,
    run_in_background: input.runInBackground === true,
    even_in_maintenance_mode: input.evenInMaintenanceMode === true,
    status: input.status,
    duration: input.status === 'skipped' ? 0 : int(input.duration),
    ...parentTail(input),
  }
}

export interface CommandInput extends ParentInput {
  /** `""` for the Node SDK: a command is a function, not a class. */
  class?: string
  name: string
  /** The command line: the name followed by the script's arguments. */
  command: string
  exitCode: number
}

/** PROTOCOL §4.4. The whole duration is the `action` stage. */
export function buildCommand(input: CommandInput): WireRecord {
  const duration = int(input.duration)
  const exitCode = Number.isInteger(input.exitCode) && input.exitCode >= 0 && input.exitCode <= 255 ? input.exitCode : 255

  return {
    v: 1,
    t: 'command',
    timestamp: input.timestamp,
    deploy: truncate(input.deploy, TINY_TEXT),
    server: truncate(input.server, TINY_TEXT),
    _group: group(input.name),
    trace_id: input.traceId,
    class: input.class ?? '',
    name: input.name,
    command: input.command,
    exit_code: exitCode,
    duration,
    bootstrap: 0,
    action: duration,
    terminating: 0,
    ...parentTail(input),
  }
}
