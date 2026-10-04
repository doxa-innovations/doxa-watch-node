import { type Config, type ConfigOverrides, loadConfig } from '../../src/config'
import type { WireRecord } from '../../src/records/common'
import { type RecordSink, resetRuntime } from '../../src/runtime'
import type { EnqueueOptions } from '../../src/transport/transport'

/** An in-memory sink: what the transport would have been handed, call by call. */
export class MemorySink implements RecordSink {
  calls: { records: WireRecord[]; options?: EnqueueOptions }[] = []

  get records(): WireRecord[] {
    return this.calls.flatMap((call) => call.records)
  }

  enqueue(records: WireRecord[], options?: EnqueueOptions): void {
    this.calls.push({ records: [...records], options })
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/** Resets the process-wide runtime with a test configuration and a memory sink. */
export function useMemorySink(overrides: ConfigOverrides = {}): { sink: MemorySink; config: Config } {
  const config = loadConfig({ token: 'test-token', deploy: 'v1.2.3', server: 'web-01', projectRoot: process.cwd(), ...overrides }, {})
  const runtime = resetRuntime(config)
  const sink = new MemorySink()
  runtime.sink = sink
  return { sink, config }
}
