import type { LogLevel } from '../config'
import { type RecordContext, TEXT, type WireRecord, childFields, jsonText, now, truncate } from './common'

export interface LogInput {
  level: LogLevel
  message: string
  context?: Record<string, unknown>
  extra?: Record<string, unknown>
  timestamp?: number
}

/** PROTOCOL §4.14. No `_group`. */
export function buildLog(context: RecordContext, input: LogInput): WireRecord {
  return {
    v: 1,
    t: 'log',
    timestamp: input.timestamp ?? now(),
    ...childFields(context, null),
    level: input.level,
    message: truncate(input.message, TEXT),
    context: jsonText(input.context ?? {}, TEXT, 'context'),
    extra: jsonText(input.extra ?? {}, TEXT, 'extra'),
  }
}
