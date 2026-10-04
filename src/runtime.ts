import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { type Config, loadConfig } from './config'
import type { Execution } from './execution'
import type { RecordContext, WireRecord } from './records/common'
import type { EnqueueOptions } from './transport/transport'

/** Where finished records go. `Transport` implements it; tests substitute an array-backed sink. */
export interface RecordSink {
  enqueue(records: WireRecord[], options?: EnqueueOptions): void
  flush(budgetMs?: number): Promise<void>
  shutdown(): Promise<void>
}

/**
 * Process-wide state. It lives on `globalThis` because the package can be loaded more than once in one process
 * (ESM and CJS builds, or a bundled copy next to the external one): every copy must share one transport and one
 * AsyncLocalStorage, or records would be lost between them.
 */
export interface Runtime {
  config: Config
  /** Null until `register()` ran with a token; then every sensor writes here. */
  sink: RecordSink | null
  registered: boolean
  als: AsyncLocalStorage<Execution>
  /** Identity of the pseudo-execution that owns records produced outside any execution. */
  processId: string
  /** Sensors already installed in this process, by name, so nothing is patched twice. */
  installed: Set<string>
}

const KEY = Symbol.for('doxa-watch.runtime.v1')

export function getRuntime(): Runtime {
  const scope = globalThis as unknown as Record<symbol, Runtime | undefined>
  let runtime = scope[KEY]
  if (runtime === undefined) {
    runtime = {
      config: loadConfig(),
      sink: null,
      registered: false,
      als: new AsyncLocalStorage<Execution>(),
      processId: randomUUID(),
      installed: new Set(),
    }
    scope[KEY] = runtime
  }
  return runtime
}

/** Test helper: forget everything (does not un-patch installed sensors). */
export function resetRuntime(config?: Config): Runtime {
  const runtime = getRuntime()
  runtime.config = config ?? loadConfig()
  runtime.sink = null
  runtime.registered = false
  runtime.processId = randomUUID()
  return runtime
}

/** PROTOCOL §9.6: records produced outside any execution stay visible under a per-process pseudo-command. */
export function processContext(): RecordContext {
  const runtime = getRuntime()
  return {
    deploy: runtime.config.deploy,
    server: runtime.config.server,
    traceId: runtime.processId,
    executionSource: 'command',
    executionId: runtime.processId,
    executionPreview: 'node server',
    executionStage: 'action',
    user: '',
  }
}
