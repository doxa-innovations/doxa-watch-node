import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureError } from '../src/capture'
import { EXECUTION_BUFFER, Execution, currentContext, currentExecution, emit, runExecution } from '../src/execution'
import { buildLog } from '../src/records'
import { getRuntime } from '../src/runtime'
import { type MemorySink, useMemorySink } from './helpers/sink'

let sink: MemorySink

beforeEach(() => {
  sink = useMemorySink().sink
})
afterEach(() => vi.restoreAllMocks())

const log = (message: string) => buildLog(currentContext(), { level: 'info', message })

describe('scoping', () => {
  it('is visible through awaits, timers and callbacks, and not outside', async () => {
    expect(currentExecution()).toBeUndefined()
    const seen: (string | undefined)[] = []
    const execution = await runExecution({ source: 'request', preview: 'GET /a', sampled: true }, async (current) => {
      seen.push(currentExecution()?.id)
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.push(currentExecution()?.id)
      await new Promise<void>((resolve) => setImmediate(() => { seen.push(currentExecution()?.id); resolve() }))
      return current
    })
    expect(seen).toEqual([execution.id, execution.id, execution.id])
    expect(currentExecution()).toBeUndefined()
  })

  it('keeps concurrent executions apart', async () => {
    const run = (name: string) => runExecution({ source: 'request', preview: name, sampled: true }, async (execution) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
      emit(log(name))
      execution.end()
    })
    await Promise.all([run('a'), run('b'), run('c')])
    expect(sink.calls).toHaveLength(3)
    for (const call of sink.calls) {
      expect(call.records).toHaveLength(1)
      expect(call.records[0]?.message).toBe(call.records[0]?.execution_preview)
    }
  })

  it('children carry the execution fields; trace id defaults to the execution id', () => {
    runExecution({ source: 'request', preview: 'GET /users', sampled: true }, (execution) => {
      emit(log('x'))
      execution.end()
      expect(sink.records[0]).toMatchObject({ trace_id: execution.id, execution_id: execution.id, execution_source: 'request', execution_preview: 'GET /users', execution_stage: 'action', deploy: 'v1.2.3', server: 'web-01' })
    })
  })

  it('outside any execution a record goes straight out as the per-process pseudo-command', () => {
    emit(log('boot'))
    const { processId } = getRuntime()
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ execution_source: 'command', execution_preview: 'node server', execution_id: processId, trace_id: processId })
  })
})

describe('buffering and sampling', () => {
  it('sends children, then the parents, when the execution ends', () => {
    runExecution({ source: 'request', sampled: true }, (execution) => {
      emit(log('one'))
      emit(log('two'))
      expect(sink.calls).toHaveLength(0)
      execution.end([{ v: 1, t: 'request', timestamp: 1 }])
      execution.end([{ v: 1, t: 'request', timestamp: 2 }]) // a second end is a no-op
    })
    expect(sink.calls).toHaveLength(1)
    expect(sink.records.map((record) => record.t)).toEqual(['log', 'log', 'request'])
  })

  it('discards everything when not sampled', () => {
    runExecution({ source: 'request', sampled: false }, (execution) => {
      emit(log('one'))
      execution.end([{ v: 1, t: 'request', timestamp: 1 }])
    })
    expect(sink.calls).toHaveLength(0)
  })

  it('rolls the dice with the configured request rate', () => {
    useMemorySink({ requestSampleRate: 0 })
    expect(new Execution({ source: 'request' }).sampled).toBe(false)
    useMemorySink({ requestSampleRate: 1 })
    expect(new Execution({ source: 'request' }).sampled).toBe(true)
  })

  it(`unsampled: keeps a ring of the ${EXECUTION_BUFFER} most recent children`, () => {
    sink = useMemorySink({ exceptionSampleRate: 1 }).sink
    runExecution({ source: 'request', sampled: false }, (execution) => {
      for (let n = 0; n < EXECUTION_BUFFER + 50; n++) emit(log(`m${n}`))
      expect(sink.calls).toHaveLength(0)
      execution.sample()
      execution.end()
      expect(execution.counters.logs).toBe(EXECUTION_BUFFER + 50)
    })
    expect(sink.records.length).toBe(EXECUTION_BUFFER - 1)
    expect(sink.records[0]?.message).toBe('m51')
    expect(sink.records.at(-1)?.message).toBe(`m${EXECUTION_BUFFER + 49}`)
  })

  it('sampled: a full buffer is handed over at once', () => {
    runExecution({ source: 'request', sampled: true }, (execution) => {
      for (let n = 0; n < EXECUTION_BUFFER; n++) emit(log(`m${n}`))
      expect(sink.records).toHaveLength(EXECUTION_BUFFER)
      execution.end()
    })
    expect(sink.calls).toHaveLength(1)
  })

  it('counts children by type', () => {
    runExecution({ source: 'request', sampled: true }, (execution) => {
      emit(log('x'))
      execution.add({ v: 1, t: 'outgoing-request', timestamp: 1 })
      execution.add({ v: 1, t: 'query', timestamp: 1 })
      execution.add({ v: 1, t: 'query', timestamp: 1 })
      expect(execution.counters).toMatchObject({ logs: 1, outgoing_requests: 1, queries: 2, exceptions: 0 })
    })
  })

  it('attributes earlier children to a user set later', () => {
    runExecution({ source: 'request', sampled: true }, (execution) => {
      emit(log('before login'))
      execution.setUser({ id: 42 })
      execution.end()
    })
    expect(sink.records[0]?.user).toBe('42')
  })
})

describe('exceptions', () => {
  it('second chance: an exception in an unsampled execution samples it, with the buffered children', () => {
    sink = useMemorySink({ exceptionSampleRate: 1 }).sink
    runExecution({ source: 'request', preview: 'GET /boom', sampled: false }, (execution) => {
      emit(log('before'))
      expect(captureError(new Error('late'), { handled: false })).toBe(true)
      expect(execution.sampled).toBe(true)
      // Sent immediately, in its own batch entry, before the rest of the execution.
      expect(sink.calls).toHaveLength(1)
      expect(sink.calls[0]?.options).toEqual({ immediate: true })
      expect(sink.calls[0]?.records[0]).toMatchObject({ t: 'exception', message: 'late', handled: false, execution_id: execution.id })
      execution.end([{ v: 1, t: 'request', timestamp: 1 }])
      expect(execution.exceptionPreview).toBe('late')
      expect(execution.counters.exceptions).toBe(1)
    })
    expect(sink.records.map((record) => record.t)).toEqual(['exception', 'log', 'request'])
  })

  it('second chance lost: nothing is sent', () => {
    sink = useMemorySink({ exceptionSampleRate: 0 }).sink
    runExecution({ source: 'request', sampled: false }, (execution) => {
      expect(captureError(new Error('late'), { handled: false })).toBe(false)
      execution.end([{ v: 1, t: 'request', timestamp: 1 }])
    })
    expect(sink.calls).toHaveLength(0)
  })

  it('a handled exception does not become the exception preview; the same error is reported once', () => {
    runExecution({ source: 'request', sampled: true }, (execution) => {
      const error = new TypeError('handled')
      expect(captureError(error, { handled: true })).toBe(true)
      expect(captureError(error, { handled: false })).toBe(false)
      expect(execution.exceptionPreview).toBe('')
      expect(sink.records).toHaveLength(1)
      expect(sink.records[0]).toMatchObject({ class: 'TypeError', handled: true, runtime: 'node', runtime_version: process.versions.node })
    })
  })

  it('outside an execution it is sampled with the exception rate', () => {
    sink = useMemorySink({ exceptionSampleRate: 0 }).sink
    expect(captureError(new Error('x'), { handled: false })).toBe(false)
    sink = useMemorySink({ exceptionSampleRate: 1 }).sink
    expect(captureError(new Error('x'), { handled: false })).toBe(true)
    expect(sink.records[0]).toMatchObject({ execution_source: 'command', execution_preview: 'node server' })
  })

  it.each([
    ['a string', 'plain text', 'Error', 'plain text', ''],
    ['an error with a code', Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }), 'Error', 'nope', 'ECONNREFUSED'],
    ['a Next error with a digest', Object.assign(new Error('nope'), { digest: '12345' }), 'Error', 'nope', '12345'],
    ['a numeric code', Object.assign(new RangeError('nope'), { code: 42 }), 'RangeError', 'nope', '42'],
    ['undefined', undefined, 'Error', 'undefined', ''],
  ])('accepts %s', (_name, thrown, cls, message, code) => {
    expect(captureError(thrown, { handled: true })).toBe(true)
    expect(sink.records[0]).toMatchObject({ class: cls, message, code })
  })

  it('does nothing while inert', () => {
    getRuntime().sink = null
    expect(captureError(new Error('x'), { handled: true })).toBe(false)
  })
})
