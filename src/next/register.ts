import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { context, trace } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import type { ConfigOverrides } from '../config'
import { debug } from '../debug'
import { register as registerCore } from '../register'
import { getRuntime } from '../runtime'
import { AlsContextManager } from './context-manager'
import { DoxaWatchSpanProcessor } from './span-processor'

export interface NextRegisterOptions extends ConfigOverrides {
  /**
   * `false` when the app runs its own OpenTelemetry set-up: nothing is registered globally, and the app adds
   * `new DoxaWatchSpanProcessor()` to its tracer provider. Default `true`.
   */
  tracing?: boolean
}

function nextVersion(projectRoot: string): string {
  for (const base of [join(projectRoot, 'package.json'), __filename]) {
    try {
      const pkg = createRequire(base)('next/package.json') as { version?: unknown }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      // try the next base
    }
  }
  return ''
}

function buildId(projectRoot: string): string {
  try {
    return readFileSync(join(projectRoot, '.next', 'BUILD_ID'), 'utf8').trim()
  } catch {
    return ''
  }
}

function installTracing(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('next-tracing')) return
  runtime.installed.add('next-tracing')

  // `getDelegate` exists on the proxy the API hands out; anything but the no-op means the app has a provider.
  const current = trace.getTracerProvider() as { getDelegate?: () => { constructor?: { name?: string } } }
  const delegate = current.getDelegate?.()
  if (delegate !== undefined && delegate.constructor?.name !== 'NoopTracerProvider') {
    debug('an OpenTelemetry tracer provider is already registered; add DoxaWatchSpanProcessor to it to get route patterns and render timings.')
    return
  }

  // One span processor, no exporter: the spans are only read, never sent anywhere.
  const provider = new BasicTracerProvider({ spanProcessors: [new DoxaWatchSpanProcessor()] })
  if (!trace.setGlobalTracerProvider(provider)) {
    debug('the tracer provider could not be registered; requests are recorded without route patterns.')
    return
  }
  // Next finds its root span through the active context; without a manager there is none.
  context.setGlobalContextManager(new AlsContextManager())
}

/**
 * Next's `register` instrumentation hook. Starts the collector in the Node.js runtime; in the Edge runtime it does
 * nothing. Accepts the same options as the core `register` plus `tracing`.
 */
export function register(options: NextRegisterOptions = {}): void {
  try {
    if (process.env.NEXT_RUNTIME === 'edge') return
    const { tracing, ...overrides } = options
    const projectRoot = overrides.projectRoot ?? process.cwd()

    const runtime = registerCore({
      ...overrides,
      projectRoot,
      framework: overrides.framework ?? { name: 'next', version: nextVersion(projectRoot) },
    })
    if (runtime.sink === null) return

    // Last fallback for `deploy` (after DOXA_WATCH_DEPLOY, GIT_SHA, SOURCE_COMMIT): Next's build id.
    if (runtime.config.deploy === '') runtime.config.deploy = buildId(projectRoot)

    if (tracing !== false) installTracing()
  } catch (error) {
    debug('next register failed:', error)
  }
}
