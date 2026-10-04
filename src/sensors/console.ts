import { format } from 'node:util'
import { LOG_LEVELS, type LogLevel } from '../config'
import { emit, currentContext } from '../execution'
import { buildLog } from '../records/log'
import { getRuntime } from '../runtime'

const METHODS: Record<string, LogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warning',
  error: 'error',
}

export function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level)
}

/** The context of a console call: an `Error` among the arguments becomes `exception.{class,message}`. */
export function consoleContext(args: unknown[]): Record<string, unknown> {
  for (const arg of args) {
    if (arg instanceof Error) {
      // The server uses `exception.class` to keep this log from opening a second issue next to the exception record.
      return { exception: { class: arg.name || 'Error', message: arg.message } }
    }
  }
  return {}
}

let busy = false

/**
 * Records `console.*` calls at or above `DOXA_WATCH_LOG_LEVEL` as `log` records; the original method always runs.
 * `console.log`/`info` → `info`, `warn` → `warning`, `error` → `error`, `debug` → `debug`.
 */
export function installConsoleSensor(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('console')) return
  runtime.installed.add('console')

  const target = console as unknown as Record<string, (...args: unknown[]) => void>
  for (const [method, level] of Object.entries(METHODS)) {
    const original = target[method]
    if (typeof original !== 'function') continue

    target[method] = function patched(this: unknown, ...args: unknown[]): void {
      if (!busy) {
        busy = true
        try {
          const { sink, config } = getRuntime()
          if (sink !== null && levelRank(level) >= levelRank(config.logLevel)) {
            emit(buildLog(currentContext(), { level, message: format(...args), context: consoleContext(args) }))
          }
        } catch {
          // Never let logging break the app; not even a debug line here (it would recurse).
        } finally {
          busy = false
        }
      }
      original.apply(this, args)
    }
  }
}
