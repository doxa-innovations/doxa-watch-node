/* Internal diagnostics. Nothing the SDK does may throw into the host app: every hook goes through `safe`. */

type ConsoleMethod = (...args: unknown[]) => void

// Captured at module load, before the console sensor patches anything, so SDK output is never recorded as app logs.
const original: { log: ConsoleMethod; warn: ConsoleMethod } = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
}

let enabled = process.env.DOXA_WATCH_DEBUG === '1' || process.env.DOXA_WATCH_DEBUG === 'true'

export function setDebug(value: boolean): void {
  enabled = value
}

/** Internal failures and decisions; printed only with `DOXA_WATCH_DEBUG=1`. */
export function debug(...args: unknown[]): void {
  if (!enabled) return
  try {
    original.log('[doxa-watch]', ...args)
  } catch {
    // ignore
  }
}

/** The one line the SDK prints at start-up regardless of the debug flag. */
export function notice(message: string): void {
  try {
    original.log(`[doxa-watch] ${message}`)
  } catch {
    // ignore
  }
}

/** Runs `fn`; an exception becomes a debug line and `fallback`. */
export function safe<T>(label: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn()
  } catch (error) {
    debug(`${label} failed:`, error)
    return fallback
  }
}
