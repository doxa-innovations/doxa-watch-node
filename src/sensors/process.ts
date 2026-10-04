import { captureError } from '../capture'
import { debug } from '../debug'
import { getRuntime } from '../runtime'

/**
 * Reports `uncaughtException` and `unhandledRejection` without changing what the process does about them.
 *
 * `uncaughtExceptionMonitor` is the hook Node provides for exactly that. There is no monitor for rejections, and a
 * plain `unhandledRejection` listener would switch off Node's default (crash): so `process.emit` is observed instead,
 * which sees the event whether or not anybody listens and leaves the outcome to the listeners that exist.
 */
export function installProcessSensor(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('process')) return
  runtime.installed.add('process')

  process.on('uncaughtExceptionMonitor', (error) => {
    captureError(error, { handled: false })
  })

  const original = process.emit
  const patched = function emit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'unhandledRejection') {
      try {
        captureError(args[0], { handled: false })
      } catch (error) {
        debug('unhandledRejection capture failed:', error)
      }
    }
    return (original as (...all: unknown[]) => boolean).call(this, event, ...args)
  }
  process.emit = patched as typeof process.emit
}

type SyncSink = { flushSync?: (budgetMs?: number) => void } | null

/**
 * Final flush, each time with the 2 s budget:
 *
 * - `beforeExit` (the event loop ran dry): an ordinary flush.
 * - `SIGTERM`, nobody else listening: flush, then re-raise the signal so the process still dies of it.
 * - `SIGTERM`, the app handles it too (Next's server closes and calls `process.exit`): there is no telling how long
 *   the process has left, so what is buffered is posted synchronously, from a short-lived child process.
 * - `exit`: the same synchronous post for whatever was produced after that.
 */
export function installShutdownHooks(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('shutdown')) return
  runtime.installed.add('shutdown')

  const flushSync = (): void => {
    try {
      ;(getRuntime().sink as SyncSink)?.flushSync?.()
    } catch (error) {
      debug('synchronous flush failed:', error)
    }
  }

  process.on('beforeExit', () => {
    void getRuntime().sink?.flush(getRuntime().config.shutdownBudgetMs)
  })

  const onSigterm = (): void => {
    const { sink, config } = getRuntime()
    if (process.listenerCount('SIGTERM') > 1) {
      flushSync()
      return
    }
    const reraise = (): void => {
      process.removeListener('SIGTERM', onSigterm)
      process.kill(process.pid, 'SIGTERM')
    }
    if (sink === null) {
      reraise()
      return
    }
    sink.flush(config.shutdownBudgetMs).then(reraise, reraise)
  }
  process.on('SIGTERM', onSigterm)

  process.on('exit', flushSync)
}
