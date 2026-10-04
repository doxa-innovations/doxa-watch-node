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

/**
 * Final flush: `beforeExit` (the loop ran dry) and `SIGTERM`, each with the 2 s budget. If nobody else handles
 * SIGTERM the signal is re-raised afterwards so the process still dies of it; if the app (Next's server) handles it
 * and exits on its own, the `exit` hook posts whatever is still buffered from a child process.
 */
export function installShutdownHooks(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('shutdown')) return
  runtime.installed.add('shutdown')

  process.on('beforeExit', () => {
    void getRuntime().sink?.flush(getRuntime().config.shutdownBudgetMs)
  })

  const onSigterm = (): void => {
    const { sink, config } = getRuntime()
    const alone = process.listenerCount('SIGTERM') === 1
    const done = (): void => {
      if (!alone) return
      process.removeListener('SIGTERM', onSigterm)
      process.kill(process.pid, 'SIGTERM')
    }
    if (sink === null) {
      done()
      return
    }
    sink.flush(config.shutdownBudgetMs).then(done, done)
  }
  process.on('SIGTERM', onSigterm)

  process.on('exit', () => {
    const sink = getRuntime().sink as { flushSync?: (budgetMs?: number) => void } | null
    try {
      sink?.flushSync?.()
    } catch (error) {
      debug('exit flush failed:', error)
    }
  })
}
