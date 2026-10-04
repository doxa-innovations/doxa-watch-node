import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { watch } from '../src/api'
import type { ConfigOverrides } from '../src/config'
import { currentExecution } from '../src/execution'
import { installConsoleSensor } from '../src/sensors/console'
import { installHttpSensor, isIgnoredPath, requestState } from '../src/sensors/http'
import { installProcessSensor } from '../src/sensors/process'
import { installUndiciSensor } from '../src/sensors/undici'
import { FakeServer } from './helpers/fake-server'
import { type MemorySink, useMemorySink } from './helpers/sink'

let upstream: FakeServer
let app: Server
let appUrl: string
let sink: MemorySink
let handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

beforeAll(async () => {
  installHttpSensor()
  installUndiciSensor()
  installConsoleSensor()
  installProcessSensor()
  upstream = await new FakeServer().start()
  app = createServer((request, response) => void handler(request, response))
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
})
afterAll(async () => {
  await upstream.stop()
  app.closeAllConnections()
  await new Promise<void>((resolve) => app.close(() => resolve()))
})

function setup(overrides: ConfigOverrides = {}): void {
  sink = useMemorySink(overrides).sink
  handler = (_request, response) => {
    response.end('ok')
  }
}
beforeEach(() => setup())

/** Calls the app from outside any execution context, the way a real client would. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${appUrl}${path}`, init)
  await response.text()
  return response
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got [${sink.records.map((r) => r.t).join(', ')}]`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// The fake upstream is an http.Server in this process too, so its requests are recorded as well: look at the app's only.
const requests = () => sink.records.filter((record) => record.t === 'request' && !String(record.url).includes('/upstream'))
// The test's own `fetch` to the app is an outgoing request of this process too; only the handler's count here.
const outgoing = () => sink.records.filter((record) => record.t === 'outgoing-request' && record.execution_source === 'request')

describe('http sensor', () => {
  it('records a request with method, URL, IP, sizes, status and redacted headers', async () => {
    handler = (_request, response) => {
      response.writeHead(201, { 'content-type': 'text/plain', 'content-length': '5' })
      response.end('hello')
    }
    await call('/deals/7?tab=notes', { method: 'POST', body: 'abc', headers: { authorization: 'Bearer secret', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'crm.example.com' } })
    await until(() => requests().length === 1, 'the request record')
    const record = requests()[0]!
    expect(record).toMatchObject({
      method: 'POST',
      url: 'https://crm.example.com/deals/7?tab=notes',
      ip: '203.0.113.9',
      status_code: 201,
      request_size: 3,
      response_size: 5,
      route_path: '',
      route_methods: [],
      route_action: '',
      user: '',
      payload: '',
    })
    expect(record.duration).toBe((record.before_middleware as number) + (record.action as number) + (record.render as number))
    expect(record.duration).toBeGreaterThan(0)
    expect(JSON.parse(record.headers as string).authorization).toEqual(['Bearer [6 bytes redacted]'])
    expect(record.peak_memory_usage).toBeGreaterThan(0)
  })

  it('measures a response without content-length from the bytes written', async () => {
    handler = (_request, response) => {
      response.write('a'.repeat(1000))
      response.end('b'.repeat(500))
    }
    await call('/stream')
    await until(() => requests().length === 1, 'the request record')
    // Chunked framing adds a few bytes per chunk.
    expect(requests()[0]!.response_size).toBeGreaterThanOrEqual(1500)
    expect(requests()[0]!.response_size).toBeLessThan(1600)
  })

  it('the handler runs inside the execution; children, the user record and the request arrive together, in order', async () => {
    handler = async (_request, response) => {
      watch.log.info('working', { step: 1 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      watch.setUser({ id: 42, name: 'Ada', username: 'ada@example.com' })
      const state = requestState(currentExecution())!
      state.routePath = '/deals/[id]'
      state.routeKind = 'page'
      state.routeModule = 'app/deals/[id]/page'
      state.renderMicros = 1000
      response.end('ok')
    }
    await call('/deals/7')
    await until(() => requests().length === 1, 'the request record')
    const batch = sink.calls.find((entry) => entry.records.some((record) => record.t === 'request'))!.records
    expect(batch.map((record) => record.t)).toEqual(['log', 'user', 'request'])
    const [log, user, request] = batch
    expect(log).toMatchObject({ message: 'working', context: '{"step":1}', user: '42', execution_source: 'request', execution_preview: 'GET /deals/7', trace_id: request!.trace_id, execution_id: request!.trace_id })
    expect(user).toMatchObject({ id: '42', name: 'Ada', username: 'ada@example.com' })
    expect(request).toMatchObject({ user: '42', logs: 1, route_path: '/deals/[id]', route_methods: ['GET'], route_action: 'page app/deals/[id]/page', render: 1000 })
  })

  it('waits for open framework spans before writing the record, but not forever', async () => {
    handler = (_request, response) => {
      const state = requestState(currentExecution())!
      state.openSpans = 1
      setTimeout(() => {
        state.routePath = '/late'
        state.routeKind = 'route'
        state.openSpans = 0
        state.onIdle?.()
      }, 60)
      response.end('ok')
    }
    await call('/late')
    await until(() => requests().length === 1, 'the request record')
    expect(requests()[0]).toMatchObject({ route_path: '/late', route_action: 'route' })
    expect(requests()[0]!.duration).toBeLessThan(50_000) // the wait is not part of the request

    setup()
    handler = (_request, response) => {
      requestState(currentExecution())!.openSpans = 1 // never ends
      response.end('ok')
    }
    await call('/stuck')
    await until(() => requests().length === 1, 'the request record after the grace period')
    expect(requests()[0]!.route_path).toBe('')
  })

  it.each([
    ['/_next/static/chunks/main.js', true],
    ['/_next/image', true],
    ['/logo.png', true],
    ['/fonts/inter.woff2', true],
    ['/favicon.ico', true],
    ['/robots.txt', true],
    ['/health', true],
    ['/healthz', true],
    ['/api/health', true],
    ['/api/health/', true],
    ['/api/doxa-watch', true],
    ['/', false],
    ['/deals/7', false],
    ['/api/deals', false],
    ['/api/export.json', false],
    ['/healthy-recipes', false],
  ])('ignores %s → %s', (path, ignored) => {
    expect(isIgnoredPath(path)).toBe(ignored)
  })

  it('does not record ignored paths, nor what the ignore callback rejects', async () => {
    setup({ ignore: (request) => request.path.startsWith('/internal') })
    await call('/_next/static/app.js')
    await call('/api/health')
    await call('/internal/metrics')
    await call('/kept')
    await until(() => requests().length === 1, 'the request record')
    expect(requests().map((record) => record.url)).toEqual([`${appUrl}/kept`])
  })

  it('resolveUser and redactRequest are applied; a throwing callback costs nothing', async () => {
    setup({
      resolveUser: async (request) => (request.headers['x-user'] ? { id: String(request.headers['x-user']) } : null),
      redactRequest: (request) => ({ ...request, url: request.url.replace(/token=[^&]+/, 'token=[redacted]'), ip: '' }),
    })
    await call('/a?token=abc', { headers: { 'x-user': 'u7' } })
    await until(() => requests().length === 1, 'the request record')
    expect(requests()[0]).toMatchObject({ user: 'u7', url: `${appUrl}/a?token=[redacted]`, ip: '' })
    expect(sink.records.some((record) => record.t === 'user' && record.id === 'u7')).toBe(true)

    setup({ resolveUser: () => { throw new Error('no session store') }, redactRequest: () => { throw new Error('bad') } })
    expect((await call('/b')).status).toBe(200)
    await until(() => requests().length === 1, 'the request record')
    expect(requests()[0]).toMatchObject({ user: '', url: `${appUrl}/b` })
  })

  it('an unsampled request sends nothing; inert, the server is untouched', async () => {
    setup({ requestSampleRate: 0 })
    await call('/quiet')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests()).toHaveLength(0)

    setup()
    const { getRuntime } = await import('../src/runtime')
    getRuntime().sink = null
    handler = (_request, response) => {
      response.end(String(currentExecution() === undefined))
    }
    expect(await (await fetch(`${appUrl}/inert`)).text()).toBe('true')
  })

  it('a client that goes away still produces a record', async () => {
    handler = (_request, response) => {
      setTimeout(() => response.end('late'), 200)
    }
    const controller = new AbortController()
    const pending = fetch(`${appUrl}/slow`, { signal: controller.signal }).catch(() => null)
    setTimeout(() => controller.abort(), 30)
    await pending
    await until(() => requests().length === 1, 'the request record')
    expect(requests()[0]).toMatchObject({ method: 'GET', url: `${appUrl}/slow` })
  })
})

describe('undici sensor', () => {
  it('records fetch inside a request with host, method, URL, status and sizes', async () => {
    handler = async (_request, response) => {
      const result = await fetch(`${upstream.url}/upstream/items?page=2`, { method: 'POST', body: '{"a":1}' })
      await result.text()
      response.end('ok')
    }
    await call('/with-fetch')
    await until(() => requests().length === 1, 'the request record')
    expect(outgoing()).toHaveLength(1)
    const host = new URL(upstream.url).host
    expect(outgoing()[0]).toMatchObject({ host, method: 'POST', url: `${upstream.url}/upstream/items?page=2`, status_code: 200, request_size: 7, response_size: 11, execution_preview: 'GET /with-fetch', trace_id: requests()[0]!.trace_id })
    expect(outgoing()[0]!.duration).toBeGreaterThan(0)
    expect(requests()[0]!.outgoing_requests).toBe(1)
  })

  it('a connection failure is recorded with status_code 0', async () => {
    // A port nothing listens on: take a free one and close it again.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const closedPort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    handler = async (_request, response) => {
      await fetch(`http://127.0.0.1:${closedPort}/nothing-listens-here`).catch(() => null)
      response.end('ok')
    }
    await call('/with-failure')
    await until(() => requests().length === 1, 'the request record')
    expect(outgoing()).toHaveLength(1)
    expect(outgoing()[0]).toMatchObject({ host: `127.0.0.1:${closedPort}`, status_code: 0, url: `http://127.0.0.1:${closedPort}/nothing-listens-here` })
  })

  it('a response whose body is never read is still recorded when the request ends', async () => {
    handler = async (_request, response) => {
      const result = await fetch(`${upstream.url}/upstream/missing`)
      response.end(String(result.status))
    }
    await call('/unread')
    await until(() => requests().length === 1, 'the request record')
    await until(() => outgoing().length === 1, 'the outgoing request')
    expect(outgoing()[0]).toMatchObject({ status_code: 404 })
  })

  it('DOXA_WATCH_IGNORE_OUTGOING_REQUESTS switches it off; calls to Doxa Watch itself are never recorded', async () => {
    setup({ ignoreOutgoingRequests: true })
    handler = async (_request, response) => {
      await (await fetch(`${upstream.url}/upstream/a`)).text()
      response.end('ok')
    }
    await call('/ignored')
    await until(() => requests().length === 1, 'the request record')
    expect(sink.records.filter((record) => record.t === 'outgoing-request')).toHaveLength(0)

    setup({ baseUrl: upstream.url })
    await call('/own')
    await until(() => requests().length === 1, 'the request record')
    expect(outgoing()).toHaveLength(0)
  })

  it('outside a request it is recorded under the per-process pseudo-command', async () => {
    await (await fetch(`${upstream.url}/upstream/boot`)).text()
    await until(() => sink.records.some((record) => record.t === 'outgoing-request'), 'the outgoing request')
    expect(sink.records.find((record) => record.t === 'outgoing-request')).toMatchObject({ execution_source: 'command', execution_preview: 'node server' })
  })
})

describe('console sensor', () => {
  const logs = () => sink.records.filter((record) => record.t === 'log')

  it.each([
    ['warning (the default)', 'warning', ['warning', 'error']],
    ['info', 'info', ['info', 'info', 'warning', 'error']],
    ['debug', 'debug', ['debug', 'info', 'info', 'warning', 'error']],
    ['error', 'error', ['error']],
  ] as const)('captures console.* at %s', (_name, logLevel, expected) => {
    setup({ logLevel })
    console.debug('d')
    console.log('l')
    console.info('i')
    console.warn('w')
    console.error('e')
    expect(logs().map((record) => record.level)).toEqual(expected)
  })

  it('formats the arguments like console does, and an Error sets context.exception.class', () => {
    console.error('Failed to load %s:', 'deal 7', new TypeError('bad id'))
    console.warn('plain', { a: 1 })
    expect(logs()[0]!.message).toContain('Failed to load deal 7: TypeError: bad id')
    expect(JSON.parse(logs()[0]!.context as string)).toEqual({ exception: { class: 'TypeError', message: 'bad id' } })
    expect(logs()[1]).toMatchObject({ level: 'warning', message: 'plain { a: 1 }', context: '{}', extra: '{}' })
  })

  it('watch.log.<level> always sends, whatever the level setting', () => {
    setup({ logLevel: 'emergency' })
    console.error('not captured')
    watch.log.debug('explicit', { key: 'value' })
    watch.log.critical('explicit critical')
    expect(logs().map((record) => [record.level, record.message, record.context])).toEqual([
      ['debug', 'explicit', '{"key":"value"}'],
      ['critical', 'explicit critical', '{}'],
    ])
  })
})

describe('process sensor', () => {
  const exceptions = () => sink.records.filter((record) => record.t === 'exception')

  it('reports an uncaught exception through the monitor event, which does not change what the process does', () => {
    expect(process.listenerCount('uncaughtException')).toBe(process.listeners('uncaughtException').length)
    const before = process.listenerCount('uncaughtException')
    const emitAny = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean
    emitAny('uncaughtExceptionMonitor', new RangeError('fatal'), 'uncaughtException')
    expect(process.listenerCount('uncaughtException')).toBe(before) // the sensor added no uncaughtException listener
    expect(exceptions()).toHaveLength(1)
    expect(exceptions()[0]).toMatchObject({ class: 'RangeError', message: 'fatal', handled: false, execution_source: 'command', execution_preview: 'node server' })
  })

  it('reports an unhandled rejection without becoming a listener for it', () => {
    // The sensor must not be a listener: a listener would switch off Node's default behaviour (crash).
    const existing = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    try {
      expect(process.listenerCount('unhandledRejection')).toBe(0)
      const error = new Error('rejected')
      // `emit` returns false when nobody listens — which is what Node uses to decide to crash: unchanged.
      expect(process.emit('unhandledRejection', error, Promise.resolve())).toBe(false)
      expect(exceptions()).toHaveLength(1)
      expect(exceptions()[0]).toMatchObject({ message: 'rejected', handled: false })

      let seen: unknown = null
      process.once('unhandledRejection', (reason) => { seen = reason })
      expect(process.emit('unhandledRejection', new Error('second'), Promise.resolve())).toBe(true)
      expect((seen as Error).message).toBe('second') // the app's own listener still gets it
      expect(exceptions()).toHaveLength(2)
    } finally {
      for (const listener of existing) process.on('unhandledRejection', listener)
    }
  })
})

describe('manual API', () => {
  it('is a no-op while inert and never throws', async () => {
    const { getRuntime } = await import('../src/runtime')
    getRuntime().sink = null
    expect(() => {
      watch.captureException(new Error('x'))
      watch.setUser({ id: 1 })
      watch.log.info('x')
    }).not.toThrow()
    await expect(watch.flush()).resolves.toBeUndefined()
  })

  it('captureException inside a request is handled and attached to it', async () => {
    handler = (_request, response) => {
      try {
        throw new Error('caught')
      } catch (error) {
        watch.captureException(error)
      }
      response.end('ok')
    }
    await call('/handled')
    await until(() => requests().length === 1, 'the request record')
    const exception = sink.records.find((record) => record.t === 'exception')!
    expect(exception).toMatchObject({ message: 'caught', handled: true, execution_preview: 'GET /handled', trace_id: requests()[0]!.trace_id, file: 'test/sensors.test.ts' })
    expect(requests()[0]).toMatchObject({ exceptions: 1, exception_preview: '' })
    // Sent immediately, in its own batch entry, ahead of the request's batch.
    expect(sink.calls[0]).toMatchObject({ options: { immediate: true } })
  })
})
