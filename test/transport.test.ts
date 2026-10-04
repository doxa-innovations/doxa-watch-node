import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ConfigOverrides, loadConfig } from '../src/config'
import type { WireRecord } from '../src/records'
import { AuthClient, backoffSeconds } from '../src/transport/auth'
import { Transport } from '../src/transport/transport'
import { SDK_VERSION } from '../src/version'
import { FakeServer } from './helpers/fake-server'

let server: FakeServer
let transports: Transport[] = []

beforeEach(async () => {
  server = await new FakeServer().start()
  transports = []
})
afterEach(async () => {
  for (const transport of transports) await transport.shutdown()
  await server.stop()
})

function make(overrides: ConfigOverrides = {}): Transport {
  const config = loadConfig(
    { token: 'env-token', baseUrl: server.url, server: 'web-01', framework: { name: 'next', version: '15.5.27' }, shutdownBudgetMs: 500, ...overrides },
    {},
  )
  const transport = new Transport(config)
  transports.push(transport)
  return transport
}

const record = (n: number, extra: Record<string, unknown> = {}): WireRecord => ({ v: 1, t: 'log', timestamp: n, message: `m${n}`, ...extra })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('authentication', () => {
  it('posts {} with the environment token, the server name and the SDK user agent', async () => {
    const transport = make()
    transport.start()
    await server.waitFor(() => server.auths.length === 1)
    const auth = server.auths[0]!
    expect(auth.body.toString()).toBe('{}')
    expect(auth.headers).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer env-token',
      'content-type': 'application/json',
      'nightwatch-server': 'web-01',
      'user-agent': `DoxaWatchNode/${SDK_VERSION} (next/15.5.27; node/${process.versions.node})`,
    })
  })

  it('sends gzip {"records":[…]} to ingest_url with the short-lived token', async () => {
    const transport = make()
    transport.start()
    transport.enqueue([record(1), record(2)])
    await transport.flush()
    expect(server.ingests).toHaveLength(1)
    expect(server.ingests[0]!.headers).toMatchObject({
      authorization: 'Bearer short-lived',
      'content-encoding': 'gzip',
      'content-type': 'application/json',
      'nightwatch-server': 'web-01',
      'user-agent': `DoxaWatchNode/${SDK_VERSION} (next/15.5.27; node/${process.versions.node})`,
    })
    expect(server.records).toEqual([record(1), record(2)])
    expect(transport.stats).toMatchObject({ sent: 2, dropped: 0, batches: 1 })
  })

  it('refreshes on a timer after refresh_in seconds', async () => {
    server.onAuth = () => ({ body: server.authBody({ refresh_in: 1 }) })
    make().start()
    await server.waitFor(() => server.auths.length >= 2, 4000, 'the timer refresh')
  })

  it('re-authenticates on demand once the token has expired', async () => {
    server.onAuth = (_seen, count) => ({ body: server.authBody({ token: `token-${count}`, expires_in: count === 1 ? 0 : 3600 }) })
    const transport = make()
    transport.start()
    await server.waitFor(() => server.auths.length === 1)
    transport.enqueue([record(1)])
    await transport.flush()
    expect(server.auths).toHaveLength(2)
    expect(server.ingests[0]!.headers.authorization).toBe('Bearer token-2')
  })

  it.each([
    ['a float', { expires_in: 3600.5 }],
    ['a numeric string', { refresh_in: '2700' }],
    ['a missing field', { ingest_url: undefined }],
  ])('rejects an auth response with %s and drops the batch', async (_name, extra) => {
    server.onAuth = () => ({ body: server.authBody(extra) })
    const transport = make()
    transport.start()
    transport.enqueue([record(1)])
    await transport.flush()
    expect(server.ingests).toHaveLength(0)
    expect(transport.stats).toMatchObject({ sent: 0, dropped: 1, failedBatches: 1 })
  })

  it('a failed auth is retried after the refresh_in of the error body', async () => {
    server.onAuth = (_seen, count) => (count === 1 ? { status: 401, body: { message: 'Invalid environment token', refresh_in: 0.05 } } : { body: server.authBody() })
    const transport = make()
    transport.start()
    await server.waitFor(() => server.auths.length === 2, 3000, 'the retry')
    transport.enqueue([record(1)])
    await transport.flush()
    expect(server.records).toHaveLength(1)
  })

  it('stop on the auth endpoint drops the token and pauses until a later auth succeeds', async () => {
    let allow = true
    server.onAuth = () => (allow ? { body: server.authBody({ refresh_in: 1 }) } : { status: 403, body: { stop: true, refresh_in: 0.2, message: 'Exceeded quota' } })
    const transport = make()
    transport.start()
    transport.enqueue([record(1)])
    await transport.flush()
    expect(server.records).toHaveLength(1)

    allow = false
    await server.waitFor(() => transport.paused, 4000, 'the pause')
    transport.enqueue([record(2)])
    await transport.flush()
    expect(server.records).toHaveLength(1)

    allow = true
    await server.waitFor(() => !transport.paused, 4000, 'the resume')
    transport.enqueue([record(3)])
    await transport.flush()
    expect(server.records.map((r) => r.message)).toEqual(['m1', 'm3'])
  })

  it.each([
    // [consecutive failures, ever authenticated, seconds]
    [1, false, 2.5], [2, false, 5], [3, false, 10], [4, false, 15], [5, false, 30], [6, false, 60], [7, false, 120], [8, false, 240],
    [9, false, 300], [20, false, 300], [21, false, 3600], [100, false, 3600],
    [1, true, 300], [12, true, 300], [13, true, 3600], [50, true, 3600],
  ])('back-off table: failure %i (authenticated before: %s) → %f s', (failures, ever, seconds) => {
    expect(backoffSeconds(failures, ever)).toBe(seconds)
  })

  it('without stop, a failed refresh keeps the old token in use', async () => {
    server.onAuth = (_seen, count) => (count === 1 ? { body: server.authBody() } : { status: 500, body: {} })
    const auth = new AuthClient(loadConfig({ token: 't', baseUrl: server.url }, {}))
    await auth.start()
    await auth.authenticate()
    expect(server.auths).toHaveLength(2)
    expect(auth.peek()?.token).toBe('short-lived')
    expect(auth.lastError).toContain('500')
    auth.stop()
  })
})

describe('ingest', () => {
  it('stop in an ingest response pauses, discards the buffer and re-authenticates after refresh_in', async () => {
    server.onIngest = () => ({ status: 200, body: { stop: true, refresh_in: 0.3, message: 'paused' } })
    const transport = make()
    transport.start()
    transport.enqueue([record(1)])
    await transport.flush()
    expect(transport.paused).toBe(true)
    transport.enqueue([record(2)])
    expect(transport.buffered).toBe(0)
    expect(transport.stats.dropped).toBe(2)

    server.onIngest = () => ({ body: {} })
    await server.waitFor(() => !transport.paused, 3000, 'the resume')
    expect(server.auths).toHaveLength(2)
    transport.enqueue([record(3)])
    await transport.flush()
    expect(server.batches.at(-1)).toEqual([record(3)])
  })

  it.each([
    ['a 500', { status: 500, body: { message: 'boom' } }],
    ['a 401', { status: 401, body: {} }],
  ])('a batch answered with %s is dropped and never retried', async (_name, reply) => {
    server.onIngest = (_seen, count) => (count === 1 ? reply : { body: {} })
    const transport = make()
    transport.start()
    transport.enqueue([record(1)])
    await transport.flush()
    transport.enqueue([record(2)])
    await transport.flush()
    expect(server.ingests).toHaveLength(2)
    expect(server.batches[1]).toEqual([record(2)])
    expect(transport.stats).toMatchObject({ sent: 1, dropped: 1, failedBatches: 1 })
    expect(server.auths).toHaveLength(1) // no re-auth on a 401 from ingest
  })

  it('a batch that times out is dropped', async () => {
    server.onIngest = () => ({ hang: true })
    const transport = make({ requestTimeoutMs: 150 })
    transport.start()
    transport.enqueue([record(1)])
    await transport.flush()
    expect(transport.stats).toMatchObject({ sent: 0, dropped: 1, failedBatches: 1 })
  })

  it('an unreachable server costs the batch, nothing else', async () => {
    const transport = make({ baseUrl: 'http://127.0.0.1:9' })
    transport.start()
    transport.enqueue([record(1)])
    await transport.flush()
    expect(transport.stats).toMatchObject({ sent: 0, dropped: 1 })
  })
})

describe('flush triggers', () => {
  it('flushes the interval after the first buffered record', async () => {
    const transport = make({ flushIntervalMs: 150 })
    transport.start()
    transport.enqueue([record(1)])
    await sleep(60)
    transport.enqueue([record(2)])
    expect(server.ingests).toHaveLength(0)
    await server.waitFor(() => server.ingests.length === 1, 2000, 'the timed flush')
    expect(server.records).toHaveLength(2)
  })

  it('flushes at the record limit without waiting for the timer', async () => {
    const transport = make({ maxBatchRecords: 500 })
    transport.start()
    transport.enqueue(Array.from({ length: 499 }, (_, n) => record(n)))
    await sleep(100)
    expect(server.ingests).toHaveLength(0)
    transport.enqueue([record(499)])
    await server.waitFor(() => server.records.length === 500, 2000, '500 records')
    expect(server.batches[0]).toHaveLength(500)
  })

  it('flushes at 1 MB of uncompressed JSON', async () => {
    const transport = make()
    transport.start()
    const big = 'x'.repeat(300_000)
    transport.enqueue([record(1, { big }), record(2, { big }), record(3, { big })])
    await sleep(100)
    expect(server.ingests).toHaveLength(0)
    transport.enqueue([record(4, { big })])
    await server.waitFor(() => server.records.length >= 3, 2000, 'the size flush')
    await transport.flush()
    // Three fit under 1 MB; the fourth would exceed it and travels in a request of its own.
    expect(server.batches.map((batch) => batch.length).sort()).toEqual([1, 3])
  })

  it('never has more than two requests in flight; the rest waits in the buffer', async () => {
    let active = 0
    let peak = 0
    server.onIngest = () => {
      active++
      peak = Math.max(peak, active)
      setTimeout(() => active--, 80)
      return { body: {}, delay: 80 }
    }
    const transport = make({ maxBatchRecords: 10 })
    transport.start()
    transport.enqueue(Array.from({ length: 60 }, (_, n) => record(n)))
    await transport.flush()
    expect(peak).toBe(2)
    expect(server.records).toHaveLength(60)
    expect(server.ingests).toHaveLength(6)
  })

  it('caps the buffer at 5,000 records, dropping the oldest and counting them', async () => {
    server.onAuth = () => ({ hang: true }) // nothing can leave
    const transport = make({ maxBatchRecords: 100_000, maxBatchBytes: 1e12, requestTimeoutMs: 300 })
    transport.enqueue(Array.from({ length: 5200 }, (_, n) => record(n)))
    expect(transport.buffered).toBe(5000)
    expect(transport.stats.dropped).toBe(200)
  })

  it('immediate records go out at once, in their own request', async () => {
    const transport = make()
    transport.start()
    await server.waitFor(() => server.auths.length === 1)
    transport.enqueue([record(1)])
    transport.enqueue([record(2, { t: 'exception' })], { immediate: true })
    await server.waitFor(() => server.ingests.length === 1, 1000, 'the immediate send')
    expect(server.batches[0]).toEqual([record(2, { t: 'exception' })])
    await transport.flush()
    expect(server.batches[1]).toEqual([record(1)])
  })

  it('a record that cannot be serialised is dropped alone', async () => {
    const transport = make()
    transport.start()
    const circular: WireRecord = record(1)
    circular.self = circular
    transport.enqueue([circular, record(2)])
    await transport.flush()
    expect(server.records).toEqual([record(2)])
    expect(transport.stats.dropped).toBe(1)
  })
})

describe('shutdown', () => {
  it('flushes what is buffered, then drops later records', async () => {
    const transport = make()
    transport.start()
    transport.enqueue([record(1)])
    await transport.shutdown()
    expect(server.records).toEqual([record(1)])
    transport.enqueue([record(2)])
    expect(transport.buffered).toBe(0)
  })

  it('gives up after the budget', async () => {
    server.onIngest = () => ({ body: {}, delay: 1500 })
    const transport = make({ shutdownBudgetMs: 200 })
    transport.start()
    transport.enqueue([record(1)])
    const started = Date.now()
    await transport.shutdown()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('flushSync posts the buffer from a child process (the exit hook)', async () => {
    // spawnSync blocks this thread's event loop, so the receiving server has to live in another thread.
    const { Worker } = await import('node:worker_threads')
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      const { gunzipSync } = require('node:zlib');
      const server = require('node:http').createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const port = server.address().port;
          if (req.url === '/api/agent-auth') {
            res.end(JSON.stringify({ token: 'short-lived', expires_in: 3600, refresh_in: 2700, ingest_url: 'http://127.0.0.1:' + port + '/api/ingest' }));
            return;
          }
          parentPort.postMessage({ authorization: req.headers.authorization, encoding: req.headers['content-encoding'], body: gunzipSync(Buffer.concat(chunks)).toString() });
          res.end('{}');
        });
      });
      server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
      `,
      { eval: true },
    )
    try {
      const messages: Record<string, unknown>[] = []
      worker.on('message', (message: Record<string, unknown>) => messages.push(message))
      const until = async (count: number): Promise<void> => {
        const deadline = Date.now() + 5000
        while (messages.length < count) {
          if (Date.now() > deadline) throw new Error('timed out waiting for the worker server')
          await sleep(10)
        }
      }
      await until(1)

      const transport = make({ baseUrl: `http://127.0.0.1:${String(messages[0]!.port)}`, flushIntervalMs: 60_000 })
      // Without a token there is nothing it could do: the buffer is left alone.
      transport.enqueue([record(1), record(2)])
      transport.flushSync(2000)
      expect(transport.buffered).toBe(2)

      await transport.auth.start()
      transport.flushSync(5000)
      expect(transport.buffered).toBe(0)
      await until(2)
      expect(messages[1]).toEqual({
        authorization: 'Bearer short-lived',
        encoding: 'gzip',
        body: JSON.stringify({ records: [record(1), record(2)] }),
      })
    } finally {
      await worker.terminate()
    }
  })
})
