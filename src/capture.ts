import { debug } from './debug'
import { type Execution, currentExecution } from './execution'
import { buildException } from './records/exception'
import { getRuntime, processContext } from './runtime'
import { resolveStack } from './stacktrace/sourcemaps'

// An error reaches us at most once, whichever hooks see it (onRequestError, process events, captureException).
const seen = new WeakSet<object>()

export interface CaptureOptions {
  handled: boolean
  /** Defaults to the current execution. */
  execution?: Execution
}

interface ErrorLike {
  name?: unknown
  message?: unknown
  code?: unknown
  digest?: unknown
  stack?: unknown
}

function errorClass(error: ErrorLike): string {
  if (typeof error.name === 'string' && error.name !== '') return error.name
  const constructor = (error as { constructor?: { name?: unknown } }).constructor
  return typeof constructor?.name === 'string' && constructor.name !== '' && constructor.name !== 'Object'
    ? constructor.name
    : 'Error'
}

/**
 * Builds the `exception` record for `error` and sends it immediately in its own batch entry. Inside an unsampled
 * execution it gets the second chance (PROTOCOL §5.1); outside any execution it is sampled with the exception rate.
 * Returns whether a record was sent. Never throws.
 */
export function captureError(error: unknown, options: CaptureOptions): boolean {
  try {
    const runtime = getRuntime()
    if (runtime.sink === null) return false

    let subject: ErrorLike
    if (error !== null && typeof error === 'object') {
      if (seen.has(error)) return false
      seen.add(error)
      subject = error as ErrorLike
    } else {
      // A thrown string or number has no stack of its own.
      subject = { name: 'Error', message: String(error), stack: '' }
    }

    const { config } = runtime
    const execution = options.execution ?? currentExecution()
    const message = typeof subject.message === 'string' ? subject.message : String(subject.message ?? '')
    const code = subject.code ?? subject.digest ?? ''

    const record = buildException(execution?.context() ?? processContext(), {
      class: errorClass(subject),
      message,
      code: typeof code === 'string' || typeof code === 'number' ? String(code) : '',
      stack: resolveStack(subject, {
        projectRoot: config.projectRoot,
        mapDirs: config.sourceMapDirs,
        captureSource: config.captureExceptionSourceCode,
      }),
      handled: options.handled,
      runtime: 'node',
      runtimeVersion: process.versions.node,
      framework: config.framework,
    })

    if (execution !== undefined) return execution.report(record, { handled: options.handled, message })
    if (Math.random() >= config.exceptionSampleRate) return false
    runtime.sink.enqueue([record], { immediate: true })
    return true
  } catch (failure) {
    debug('captureError failed:', failure)
    return false
  }
}
