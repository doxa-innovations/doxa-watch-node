import { captureError } from './capture'
import { LOG_LEVELS, type LogLevel, type WatchUser } from './config'
import { debug } from './debug'
import { currentContext, currentExecution, emit } from './execution'
import { buildLog } from './records/log'
import { getRuntime } from './runtime'

type LogMethod = (message: string, context?: Record<string, unknown>) => void

function logger(level: LogLevel): LogMethod {
  return (message, context) => {
    try {
      if (getRuntime().sink === null) return
      // The explicit logger always sends, whatever DOXA_WATCH_LOG_LEVEL says.
      emit(buildLog(currentContext(), { level, message: String(message), context: context ?? {} }))
    } catch (error) {
      debug('watch.log failed:', error)
    }
  }
}

const log = Object.fromEntries(LOG_LEVELS.map((level) => [level, logger(level)])) as Record<LogLevel, LogMethod>

/**
 * The manual API (spec §3.5). Every method is safe to call when the SDK is inert and never throws.
 * Further members (`job`, `scheduledTask`, `command`) are added to this object.
 */
export const watch = {
  /** Reports a handled error. Inside a request it attaches to that request. */
  captureException(error: unknown): void {
    captureError(error, { handled: true })
  },

  /** Attributes the current request (and its records) to a user. A no-op outside an execution. */
  setUser(user: WatchUser | null): void {
    try {
      currentExecution()?.setUser(user === null ? null : { ...user, id: String(user.id) })
    } catch (error) {
      debug('watch.setUser failed:', error)
    }
  },

  /** `watch.log.info('message', { key: 'value' })` — one method per PSR-3 level. */
  log,

  /** Sends everything buffered and waits for it, for at most `budgetMs` (no limit when omitted). */
  async flush(budgetMs?: number): Promise<void> {
    try {
      await getRuntime().sink?.flush(budgetMs)
    } catch (error) {
      debug('watch.flush failed:', error)
    }
  },
}

export type Watch = typeof watch
