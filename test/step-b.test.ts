import { createHash } from 'node:crypto'
import nodemailer from 'nodemailer'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from '../src/api'
import type { ConfigOverrides } from '../src/config'
import { currentExecution, runExecution } from '../src/execution'
import {
  type RecordContext,
  type WireRecord,
  buildCommand,
  buildJobAttempt,
  buildMail,
  buildQuery,
  buildScheduledTask,
  emptyCounters,
  normaliseSql,
} from '../src/records'
import { getRuntime } from '../src/runtime'
import { countAddresses, instrumentNodemailer } from '../src/sensors/nodemailer'
import { instrumentPg } from '../src/sensors/pg'
import { FakeClient, FakePool, FakeQuery, dispatcher, fakePg } from './helpers/fake-pg'
import { type MemorySink, useMemorySink } from './helpers/sink'

const md5 = (text: string): string => createHash('md5').update(text).digest('hex')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The line this is called from. */
function here(): number {
  const frame = (new Error().stack ?? '').split('\n')[2] ?? ''
  return Number(/:(\d+):\d+\)?$/.exec(frame)?.[1] ?? 0)
}

const context: RecordContext = {
  deploy: 'v1.2.3',
  server: 'web-01',
  traceId: '00000000-0000-0000-0000-000000000000',
  executionSource: 'request',
  executionId: '00000000-0000-0000-0000-000000000001',
  executionPreview: 'GET /users',
  executionStage: 'action',
  user: '',
}

const CHILD = ['deploy', 'server', '_group', 'trace_id', 'execution_source', 'execution_id', 'execution_preview', 'execution_stage', 'user']
const TAIL = ['exceptions', 'logs', 'queries', 'lazy_loads', 'jobs_queued', 'mail', 'notifications', 'outgoing_requests', 'files_read', 'files_written', 'cache_events', 'hydrated_models', 'peak_memory_usage', 'exception_preview', 'context']
const parent = { timestamp: 946688523.456789, deploy: 'v1.2.3', server: 'web-01', traceId: '0d3ca349-e222-4982-ac23-2343692de258', counters: { ...emptyCounters(), queries: 4 }, peakMemoryUsage: 1234, exceptionPreview: '' }

let sink: MemorySink

function setup(overrides: ConfigOverrides = {}): void {
  sink = useMemorySink(overrides).sink
  // `watch.command` registers when nothing did; here the memory sink stands for a registered collector.
  getRuntime().registered = true
  FakeClient.received = []
}
beforeEach(() => setup())

describe('record shapes (PROTOCOL §4)', () => {
  const shapes: { name: string; record: WireRecord; keys: string[]; expected: Record<string, unknown> }[] = [
    {
      name: 'query (§4.8)',
      record: buildQuery(context, { timestamp: 946688523.456789, sql: 'select * from "users"', file: 'app/users/page.tsx', line: 42, duration: 4321, connection: 'crm' }),
      keys: ['v', 't', 'timestamp', ...CHILD, 'sql', 'file', 'line', 'duration', 'connection', 'connection_type'],
      expected: { v: 1, t: 'query', timestamp: 946688523.456789, _group: md5('crm,select * from "users"'), sql: 'select * from "users"', file: 'app/users/page.tsx', line: 42, duration: 4321, connection: 'crm', connection_type: '', execution_source: 'request', execution_preview: 'GET /users' },
    },
    {
      name: 'mail (§4.11)',
      record: buildMail(context, { timestamp: 946688523.459289, mailer: 'SMTP', class: 'Welcome', subject: 'Welcome!', to: 3, cc: 2, bcc: 1, attachments: 1, duration: 2500, failed: false }),
      keys: ['v', 't', 'timestamp', ...CHILD, 'mailer', 'class', 'subject', 'to', 'cc', 'bcc', 'attachments', 'duration', 'failed'],
      expected: { v: 1, t: 'mail', _group: md5('Welcome'), mailer: 'SMTP', class: 'Welcome', subject: 'Welcome!', to: 3, cc: 2, bcc: 1, attachments: 1, duration: 2500, failed: false },
    },
    {
      name: 'job-attempt (§4.7)',
      record: buildJobAttempt({ ...parent, user: '', jobId: '5f1c', attemptId: '9a7e', attempt: 1, name: 'SendInvoice', connection: 'database', queue: 'default', status: 'processed', duration: 2500 }),
      keys: ['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'user', 'job_id', 'attempt_id', 'attempt', 'name', 'connection', 'queue', 'status', 'duration', ...TAIL],
      expected: { v: 1, t: 'job-attempt', _group: md5('SendInvoice'), trace_id: parent.traceId, user: '', job_id: '5f1c', attempt_id: '9a7e', attempt: 1, name: 'SendInvoice', connection: 'database', queue: 'default', status: 'processed', duration: 2500, queries: 4, lazy_loads: 0, peak_memory_usage: 1234, exception_preview: '', context: '{}' },
    },
    {
      name: 'scheduled-task (§4.5)',
      record: buildScheduledTask({ ...parent, name: 'nightly-sync', cron: '0 2 * * *', timezone: 'UTC', status: 'processed', duration: 1_000_000 }),
      keys: ['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'name', 'cron', 'timezone', 'repeat_seconds', 'without_overlapping', 'on_one_server', 'run_in_background', 'even_in_maintenance_mode', 'status', 'duration', ...TAIL],
      expected: { v: 1, t: 'scheduled-task', _group: md5('nightly-sync,0 2 * * *,UTC'), name: 'nightly-sync', cron: '0 2 * * *', timezone: 'UTC', repeat_seconds: 0, without_overlapping: false, on_one_server: false, run_in_background: false, even_in_maintenance_mode: false, status: 'processed', duration: 1_000_000 },
    },
    {
      name: 'command (§4.4)',
      record: buildCommand({ ...parent, name: 'app:build', command: 'app:build path/to/output --force', exitCode: 3, duration: 1234567 }),
      keys: ['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'class', 'name', 'command', 'exit_code', 'duration', 'bootstrap', 'action', 'terminating', ...TAIL],
      expected: { v: 1, t: 'command', _group: md5('app:build'), class: '', name: 'app:build', command: 'app:build path/to/output --force', exit_code: 3, duration: 1234567, bootstrap: 0, action: 1234567, terminating: 0 },
    },
  ]

  it.each(shapes)('$name carries exactly the protocol keys, none null', ({ record, keys, expected }) => {
    expect(Object.keys(record)).toEqual(keys)
    expect(record).toMatchObject(expected)
    for (const [key, value] of Object.entries(record)) {
      expect(value, key).not.toBeNull()
      expect(value, key).not.toBeUndefined()
    }
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })

  it('scheduled-task: a sub-minute repeat joins the group identity; a skipped run has no duration', () => {
    const record = buildScheduledTask({ ...parent, name: 'poll', cron: '* * * * *', timezone: 'UTC', repeatSeconds: 10, status: 'skipped', duration: 99 })
    expect(record).toMatchObject({ _group: md5('poll,* * * * *,UTC,10'), repeat_seconds: 10, status: 'skipped', duration: 0 })
  })

  it.each([
    [0, 0],
    [255, 255],
    [256, 255],
    [-1, 255],
    [1.5, 255],
  ])('command: exit code %s is reported as %s', (exitCode, reported) => {
    expect(buildCommand({ ...parent, name: 'x', command: 'x', exitCode, duration: 1 }).exit_code).toBe(reported)
  })
})

describe('SQL normalisation and the query group (PROTOCOL §4.8)', () => {
  it.each([
    ['select * from users where id in ($1, $2, $3)', 'select * from users where id in (...?)'],
    ['select * from users where id in (?, ?)', 'select * from users where id in (...?)'],
    ['select * from users where id in (1, 2, 3) and org in ($1)', 'select * from users where id in (...?) and org in (...?)'],
    ['SELECT * FROM users WHERE id IN ($1,$2)', 'SELECT * FROM users WHERE id IN (...?)'],
    ['insert into users (name, email) values ($1, $2), ($3, $4)', 'insert into users (name, email) values ...'],
    ['insert into users (name) values (?), (?) returning id', 'insert into users (name) values ...returning id'],
    ['select * from (values ($1), ($2)) as t', 'select * from (values ($1), ($2)) as t'],
    ['select * from users where id = $1', 'select * from users where id = $1'],
    ["select * from users where name in ('a', 'b')", "select * from users where name in ('a', 'b')"],
  ])('%s', (sql, normalised) => {
    expect(normaliseSql(sql)).toBe(normalised)
  })

  it('the same statement with a different number of bindings is one group; the sql itself is sent as written', () => {
    const two = buildQuery(context, { timestamp: 1, sql: 'select * from users where id in ($1, $2)', file: '', line: 0, duration: 1, connection: 'crm' })
    const five = buildQuery(context, { timestamp: 1, sql: 'select * from users where id in ($1, $2, $3, $4, $5)', file: '', line: 0, duration: 1, connection: 'crm' })
    expect(two._group).toBe(md5('crm,select * from users where id in (...?)'))
    expect(five._group).toBe(two._group)
    expect(five.sql).toBe('select * from users where id in ($1, $2, $3, $4, $5)')
    const otherDatabase = buildQuery(context, { timestamp: 1, sql: 'select * from users where id in ($1)', file: '', line: 0, duration: 1, connection: 'billing' })
    expect(otherDatabase._group).not.toBe(two._group)
  })
})

beforeAll(() => {
  dispatcher.start()
  expect(instrumentPg(fakePg)).toBe(true)
})
afterAll(() => dispatcher.stop())

describe('pg', () => {
  const queries = (): WireRecord[] => sink.records.filter((record) => record.t === 'query')

  it('is idempotent, accepts an ES module namespace, and refuses what is not pg', () => {
    const patched = FakeClient.prototype.query
    expect(instrumentPg(fakePg)).toBe(true)
    expect(instrumentPg({ default: fakePg })).toBe(true)
    expect(FakeClient.prototype.query).toBe(patched)
    expect(Object.prototype.hasOwnProperty.call(FakePool.prototype, 'query')).toBe(false) // patched where pg-pool defines it
    for (const junk of [undefined, null, {}, 'pg', { Client: {} }]) expect(instrumentPg(junk)).toBe(false)
  })

  it('text: a promise with the driver result; statement, database, caller, duration and start time recorded', async () => {
    const before = Date.now() / 1000
    const line = here() + 1
    const result = await new FakeClient().query('select * from deals where id = $1', [981])
    expect(result).toEqual({ rows: [{ text: 'select * from deals where id = $1' }], rowCount: 1 })
    expect(queries()).toHaveLength(1)
    const record = queries()[0]!
    expect(record).toMatchObject({ v: 1, sql: 'select * from deals where id = $1', connection: 'crm', connection_type: '', file: 'test/step-b.test.ts', line, _group: md5('crm,select * from deals where id = $1'), execution_source: 'command', execution_preview: 'node server' })
    expect(record.duration).toBeGreaterThan(0)
    expect(record.timestamp).toBeGreaterThanOrEqual(before - 0.001)
    expect(record.timestamp).toBeLessThanOrEqual(Date.now() / 1000)
    expect(Object.keys(record)).toEqual(['v', 't', 'timestamp', ...CHILD, 'sql', 'file', 'line', 'duration', 'connection', 'connection_type'])
  })

  it('bind values reach the driver and never the wire', async () => {
    const client = new FakeClient()
    await client.query('select * from users where email = $1 and token = $2', ['ada@example.com', 'secret-value-1'])
    await client.query({ text: 'update users set password = $1', values: ['secret-value-2'] })
    await new Promise((resolve) => client.query('select $1::text', ['secret-value-3'], resolve))
    expect(FakeClient.received.map((call) => call.values)).toEqual([['ada@example.com', 'secret-value-1'], ['secret-value-2'], ['secret-value-3']])
    expect(queries()).toHaveLength(3)
    const wire = JSON.stringify(sink.calls)
    expect(wire).not.toContain('secret-value')
    expect(wire).not.toContain('ada@example.com')
  })

  it.each([
    ['text, callback', (client: FakeClient, done: () => void) => client.query('select 1', done)],
    ['text, values, callback', (client: FakeClient, done: () => void) => client.query('select 1', [], done)],
    ['config, callback', (client: FakeClient, done: () => void) => client.query({ text: 'select 1' }, done)],
    ['config, values, callback', (client: FakeClient, done: () => void) => client.query({ text: 'select 1' }, [], done)],
    ['config with its own callback', (client: FakeClient, done: () => void) => client.query({ text: 'select 1', callback: done })],
    ['a submittable with a callback', (client: FakeClient, done: () => void) => client.query(new FakeQuery('select 1', done))],
    ['a submittable, callback as argument', (client: FakeClient, done: () => void) => client.query(new FakeQuery('select 1'), done)],
  ])('callback form (%s): the callback gets the driver result once, nothing extra is returned, one record', async (name, call) => {
    const results: unknown[][] = []
    let returned: unknown
    await new Promise<void>((resolve) => {
      returned = call(new FakeClient(), ((...args: unknown[]) => {
        results.push(args)
        resolve()
      }) as () => void)
    })
    await sleep(5)
    expect(results).toEqual([[null, { rows: [{ text: 'select 1' }], rowCount: 1 }]])
    // pg returns the submittable itself, and nothing for the other callback forms.
    if (name.startsWith('a submittable')) expect(returned).toBeInstanceOf(FakeQuery)
    else expect(returned).toBeUndefined()
    expect(queries()).toHaveLength(1)
    expect(queries()[0]).toMatchObject({ sql: 'select 1', file: 'test/step-b.test.ts' })
  })

  it('a config object is left as the driver would have left it, so it can be reused', async () => {
    const callback = vi.fn()
    const config: { text: string; callback?: unknown } = { text: 'select 2' }
    const client = new FakeClient()
    client.query(config, callback)
    expect(config.callback).toBe(callback)
    const own = vi.fn()
    const withCallback = { text: 'select 3', callback: own }
    client.query(withCallback)
    client.query(withCallback)
    expect(withCallback.callback).toBe(own)
    await sleep(10)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(own).toHaveBeenCalledTimes(2)
    expect(queries().map((record) => record.sql)).toEqual(['select 2', 'select 3', 'select 3'])
  })

  it('a submittable without a callback reports through its events, and its listeners are untouched', async () => {
    const query = new FakeQuery('select * from big_table')
    const ended = new Promise((resolve) => query.once('end', resolve))
    expect(new FakeClient().query(query)).toBe(query)
    expect(queries()).toHaveLength(0)
    expect(await ended).toEqual({ rows: [{ text: 'select * from big_table' }], rowCount: 1 })
    expect(queries()).toHaveLength(1)
    expect(queries()[0]).toMatchObject({ sql: 'select * from big_table' })
    expect(Object.prototype.hasOwnProperty.call(query, 'emit')).toBe(false)
    expect(query.listenerCount('error')).toBe(0)
  })

  it('a failed query is still recorded, and the error reaches the caller unchanged', async () => {
    const client = new FakeClient()
    const rejection = await client.query('select * from no_such_table').then(
      () => null,
      (error: unknown) => error,
    )
    expect(rejection).toMatchObject({ message: 'relation "no_such_table" does not exist', code: '42P01' })
    const viaCallback = await new Promise((resolve) => client.query('select * from no_such_table', (error: unknown) => resolve(error)))
    expect(viaCallback).toMatchObject({ code: '42P01' })
    expect(queries().map((record) => record.sql)).toEqual(['select * from no_such_table', 'select * from no_such_table'])
  })

  it('a call the driver rejects outright still throws, and records nothing', () => {
    expect(() => new FakeClient().query(null)).toThrow('Client was passed a null or undefined query')
    expect(queries()).toHaveLength(0)
  })

  it('attaches to the surrounding execution and counts there, also when the driver calls back from elsewhere', async () => {
    let executionId = ''
    let insideCallback: unknown
    await runExecution({ source: 'request', preview: 'GET /deals', sampled: true }, async (execution) => {
      executionId = execution.id
      const client = new FakeClient()
      await client.query('select 1')
      await new Promise<void>((resolve) =>
        client.query('select 2', () => {
          insideCallback = currentExecution()
          resolve()
        }),
      )
      expect(insideCallback).toBe(execution)
      expect(execution.counters.queries).toBe(2)
      execution.end()
    })
    expect(queries().map((record) => [record.sql, record.execution_id, record.execution_source, record.execution_preview])).toEqual([
      ['select 1', executionId, 'request', 'GET /deals'],
      ['select 2', executionId, 'request', 'GET /deals'],
    ])
  })

  it('a pooled query is recorded once, with the caller of pool.query and in its execution', async () => {
    const pool = new FakePool()
    let executionId = ''
    let line = 0
    await runExecution({ source: 'request', preview: 'GET /pooled', sampled: true }, async (execution) => {
      executionId = execution.id
      line = here() + 1
      const result = await pool.query('select * from deals where org in ($1, $2)', [1, 2])
      expect(result).toEqual({ rows: [{ text: 'select * from deals where org in ($1, $2)' }], rowCount: 1 })
      await new Promise((resolve) => pool.query('select 2', resolve))
      expect(execution.counters.queries).toBe(2)
      execution.end()
    })
    expect(FakeClient.received).toHaveLength(2)
    expect(queries()).toHaveLength(2)
    expect(queries()[0]).toMatchObject({ sql: 'select * from deals where org in ($1, $2)', execution_id: executionId, file: 'test/step-b.test.ts', line, _group: md5('crm,select * from deals where org in (...?)') })
    expect(queries()[1]).toMatchObject({ sql: 'select 2', execution_id: executionId, file: 'test/step-b.test.ts' })
  })

  it('a client checked out of the pool by the app is recorded once per query, in the caller’s execution', async () => {
    const pool = new FakePool()
    await runExecution({ source: 'request', preview: 'GET /tx', sampled: true }, async (execution) => {
      await new Promise<void>((resolve) => {
        pool.connect((_error, client) => {
          expect(currentExecution()).toBe(execution)
          void (client as FakeClient).query('begin').then(() => resolve())
        })
      })
      const client = (await pool.connect()) as FakeClient
      await client.query('commit')
      execution.end()
    })
    expect(queries().map((record) => record.sql)).toEqual(['begin', 'commit'])
  })

  it('redactQuery rewrites the statement before it is hashed and sent', async () => {
    setup({ redactQuery: (query) => ({ sql: query.sql.replace(/'[^']*'/g, "'?'") }) })
    await new FakeClient().query("select * from users where token = 'abc123'")
    expect(queries()[0]).toMatchObject({ sql: "select * from users where token = '?'", _group: md5("crm,select * from users where token = '?'") })
    expect(FakeClient.received[0]!.text).toBe("select * from users where token = 'abc123'")

    setup({
      redactQuery: (query) => {
        query.sql = '[redacted]'
      },
    })
    await new FakeClient().query("select 'in place'")
    expect(queries()[0]).toMatchObject({ sql: '[redacted]' })
  })

  it('a redactQuery that throws drops the record rather than sending the statement; the query itself is unaffected', async () => {
    setup({
      redactQuery: () => {
        throw new Error('redaction bug')
      },
    })
    await expect(new FakeClient().query("select 'secret'")).resolves.toMatchObject({ rowCount: 1 })
    expect(sink.records).toHaveLength(0)
  })

  it('ignoreQueries, or an inert SDK: queries run and nothing is recorded', async () => {
    setup({ ignoreQueries: true })
    await expect(new FakeClient().query('select 1')).resolves.toMatchObject({ rowCount: 1 })
    await expect(new FakePool().query('select 1')).resolves.toMatchObject({ rowCount: 1 })
    expect(sink.records).toHaveLength(0)

    setup()
    getRuntime().sink = null
    await expect(new FakeClient().query('select 1')).resolves.toMatchObject({ rowCount: 1 })
    expect(sink.records).toHaveLength(0)
  })
})

describe('nodemailer', () => {
  beforeAll(() => {
    expect(instrumentNodemailer(nodemailer)).toBe(true)
  })

  const mails = (): WireRecord[] => sink.records.filter((record) => record.t === 'mail')
  const failing = { name: 'Broken', version: '1.0.0', send: (_mail: unknown, callback: (error: Error) => void) => setTimeout(() => callback(new Error('smtp down')), 2) }

  it('is idempotent and refuses what is not nodemailer', () => {
    const patched = nodemailer.createTransport
    expect(instrumentNodemailer(nodemailer)).toBe(true)
    expect(instrumentNodemailer({ default: nodemailer })).toBe(true)
    expect(nodemailer.createTransport).toBe(patched)
    for (const junk of [undefined, null, {}, 'nodemailer']) expect(instrumentNodemailer(junk)).toBe(false)
  })

  it.each([
    [undefined, 0],
    ['', 0],
    ['ada@example.com', 1],
    ['ada@example.com, bob@example.com', 2],
    ['ada@example.com,bob@example.com,', 2],
    ['"Lovelace, Ada" <ada@example.com>, Bob <bob@example.com>', 2],
    ['Ada <ada@example.com>; bob@example.com', 2],
    ['Team: ada@example.com, bob@example.com;', 2],
    [['ada@example.com', 'bob@example.com, eve@example.com'], 3],
    [{ name: 'Lovelace, Ada', address: 'ada@example.com' }, 1],
    [[{ name: 'Ada', address: 'ada@example.com' }, 'bob@example.com', { name: 'nobody' }], 2],
    [42, 0],
  ])('countAddresses(%j) = %i', (value, count) => {
    expect(countAddresses(value)).toBe(count)
  })

  it('promise form: transport name, subject and counts; the given name is the class; no address on the wire', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true })
    const info = await transporter.sendMail({
      from: 'crm@example.com',
      to: 'ada@example.com, "Hopper, Grace" <grace@example.com>',
      cc: ['bob@example.com'],
      bcc: [{ name: 'Audit', address: 'audit@example.com' }, 'legal@example.com', 'ceo@example.com'],
      subject: 'Your invoice',
      text: 'attached',
      attachments: [{ filename: 'invoice.txt', content: 'total: 1' }],
      watch: { name: 'InvoiceMail' },
    })
    // nodemailer got the message, without the SDK's own key.
    const sent = JSON.parse(String(info.message)) as Record<string, unknown>
    expect(sent.subject).toBe('Your invoice')
    expect(sent).not.toHaveProperty('watch')

    expect(mails()).toHaveLength(1)
    expect(mails()[0]).toMatchObject({ v: 1, mailer: 'JSONTransport', class: 'InvoiceMail', _group: md5('InvoiceMail'), subject: 'Your invoice', to: 2, cc: 1, bcc: 3, attachments: 1, failed: false, execution_source: 'command' })
    expect(mails()[0]!.duration).toBeGreaterThan(0)
    expect(Object.keys(mails()[0]!)).toEqual(['v', 't', 'timestamp', ...CHILD, 'mailer', 'class', 'subject', 'to', 'cc', 'bcc', 'attachments', 'duration', 'failed'])
    expect(JSON.stringify(sink.calls)).not.toContain('example.com')
  })

  it('callback form: the callback gets nodemailer’s result once and nothing is returned; an unnamed message has class ""', async () => {
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true })
    const results: unknown[][] = []
    let returned: unknown
    await new Promise<void>((resolve) => {
      returned = transporter.sendMail({ from: 'crm@example.com', to: 'ada@example.com', subject: 'Hello' }, (...args: unknown[]) => {
        results.push(args)
        resolve()
      }) as unknown
    })
    expect(returned).toBeUndefined()
    expect(results).toHaveLength(1)
    expect(results[0]![0]).toBeNull()
    expect(String((results[0]![1] as { message: Buffer }).message)).toContain('Subject: Hello')
    expect(mails()).toHaveLength(1)
    expect(mails()[0]).toMatchObject({ mailer: 'StreamTransport', class: '', _group: md5(''), subject: 'Hello', to: 1, cc: 0, bcc: 0, attachments: 0, failed: false })
  })

  it('a rejected send is recorded as failed and still rejects (promise) or errors (callback)', async () => {
    const transporter = nodemailer.createTransport(failing)
    await expect(transporter.sendMail({ to: 'ada@example.com', subject: 'Lost' })).rejects.toThrow('smtp down')
    const error = await new Promise((resolve) => transporter.sendMail({ to: 'ada@example.com', subject: 'Lost too' }, (failure) => resolve(failure)))
    expect(error).toMatchObject({ message: 'smtp down' })
    expect(mails().map((record) => [record.mailer, record.subject, record.failed])).toEqual([
      ['Broken', 'Lost', true],
      ['Broken', 'Lost too', true],
    ])
  })

  it('attaches to the surrounding execution and counts there', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true })
    await runExecution({ source: 'request', preview: 'POST /invite', sampled: true }, async (execution) => {
      await transporter.sendMail({ to: 'ada@example.com', subject: 'Invite' })
      expect(execution.counters.mail).toBe(1)
      execution.end()
      expect(mails()[0]).toMatchObject({ execution_id: execution.id, execution_source: 'request', execution_preview: 'POST /invite' })
    })
  })

  it('ignoreMail, or an inert SDK: mail is sent, nothing is recorded, and the name key is still removed', async () => {
    setup({ ignoreMail: true })
    const transporter = nodemailer.createTransport({ jsonTransport: true })
    const info = await transporter.sendMail({ to: 'ada@example.com', subject: 'Quiet', watch: { name: 'Quiet' } })
    expect(JSON.parse(String(info.message))).not.toHaveProperty('watch')
    getRuntime().sink = null
    await expect(transporter.sendMail({ to: 'ada@example.com', subject: 'Inert' })).resolves.toBeDefined()
    expect(sink.records).toHaveLength(0)
  })
})

describe('manual API', () => {
  const of = (type: string): WireRecord[] => sink.records.filter((record) => record.t === type)

  it('job: processed, with its duration, counters and children; returns the callback’s result', async () => {
    const result = await watch.job('SendInvoice', { queue: 'invoices', connection: 'redis', attempt: 3, jobId: 'job-17' }, async () => {
      watch.log.info('sending', { invoice: 42 })
      await new FakeClient().query('select * from invoices where id = $1', [42])
      await sleep(20)
      return 'sent'
    })
    expect(result).toBe('sent')

    const [attempt] = of('job-attempt')
    expect(of('job-attempt')).toHaveLength(1)
    expect(attempt).toMatchObject({ v: 1, name: 'SendInvoice', _group: md5('SendInvoice'), queue: 'invoices', connection: 'redis', attempt: 3, job_id: 'job-17', status: 'processed', user: '', deploy: 'v1.2.3', server: 'web-01', logs: 1, queries: 1, exceptions: 0, mail: 0, exception_preview: '', context: '{}' })
    expect(attempt!.attempt_id).toMatch(UUID)
    expect(attempt!.trace_id).toBe(attempt!.attempt_id)
    expect(attempt!.duration).toBeGreaterThanOrEqual(19_000)
    expect(attempt!.duration).toBeLessThan(5_000_000)
    expect(attempt!.peak_memory_usage).toBeGreaterThan(0)

    // Children first, then the parent (PROTOCOL §4.2); each child points at the attempt.
    expect(sink.records.map((record) => record.t)).toEqual(['log', 'query', 'job-attempt'])
    for (const child of sink.records.slice(0, 2)) {
      expect(child).toMatchObject({ execution_source: 'job', execution_id: attempt!.attempt_id, execution_preview: 'SendInvoice', trace_id: attempt!.trace_id })
    }
  })

  it('job: options are optional, defaults are never null, and a synchronous callback returns synchronously', () => {
    expect(watch.job('Sync', () => 7)).toBe(7)
    expect(watch.job('Sync', undefined, () => 8)).toBe(8)
    const [first, second] = of('job-attempt')
    expect(first).toMatchObject({ name: 'Sync', queue: '', connection: '', attempt: 1, status: 'processed' })
    expect(first!.job_id).toMatch(UUID)
    expect(first!.job_id).not.toBe(first!.attempt_id)
    expect(second!.attempt_id).not.toBe(first!.attempt_id)
  })

  it.each([
    ['rejects', async () => Promise.reject(new RangeError('card declined'))],
    [
      'throws',
      () => {
        throw new RangeError('card declined')
      },
    ],
  ])('job: a callback that %s → failed, an unhandled exception record, and the same error again', async (_name, fn) => {
    let caught: unknown
    try {
      await watch.job('ChargeCard', fn)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RangeError)
    const [attempt] = of('job-attempt')
    expect(attempt).toMatchObject({ status: 'failed', exceptions: 1, exception_preview: 'card declined' })
    expect(of('exception')).toHaveLength(1)
    expect(of('exception')[0]).toMatchObject({ class: 'RangeError', message: 'card declined', handled: false, execution_source: 'job', execution_id: attempt!.attempt_id, execution_preview: 'ChargeCard' })
    // The exception travels at once, in its own batch entry.
    expect(sink.calls[0]).toMatchObject({ options: { immediate: true } })
  })

  it('job inside a request: the request’s trace id and user, an execution id of its own, and the request does not end', async () => {
    await runExecution({ source: 'request', preview: 'POST /invoices', sampled: true }, async (request) => {
      request.setUser({ id: '42' })
      await watch.job('SendInvoice', async () => {
        expect(currentExecution()).not.toBe(request)
        watch.log.info('inside the job')
      })
      expect(currentExecution()).toBe(request)
      expect(request.ended).toBe(false)
      watch.log.info('back in the request')
      const [attempt] = of('job-attempt')
      expect(attempt).toMatchObject({ trace_id: request.traceId, user: '42', logs: 1 })
      expect(attempt!.attempt_id).not.toBe(request.id)
      expect(of('log')[0]).toMatchObject({ message: 'inside the job', trace_id: request.traceId, execution_id: attempt!.attempt_id, execution_source: 'job', user: '42' })
      expect(request.counters.logs).toBe(1)
      request.end()
    })
    expect(of('log')[1]).toMatchObject({ message: 'back in the request', execution_source: 'request' })
  })

  it('job inside an unsampled request is not sent either', async () => {
    await runExecution({ source: 'request', sampled: false }, async (request) => {
      await watch.job('Quiet', async () => watch.log.info('x'))
      request.end()
    })
    expect(sink.records).toHaveLength(0)
  })

  it('scheduledTask: processed with its cron, time zone and group; every run is a trace of its own', async () => {
    const result = await watch.scheduledTask('nightly-sync', '0 2 * * *', async () => {
      watch.log.warning('slow upstream')
      await sleep(10)
      return 3
    }, { timezone: 'Africa/Addis_Ababa' })
    expect(result).toBe(3)
    watch.scheduledTask('nightly-sync', '0 2 * * *', () => {})

    const [first, second] = of('scheduled-task')
    expect(first).toMatchObject({ v: 1, name: 'nightly-sync', cron: '0 2 * * *', timezone: 'Africa/Addis_Ababa', _group: md5('nightly-sync,0 2 * * *,Africa/Addis_Ababa'), repeat_seconds: 0, without_overlapping: false, on_one_server: false, run_in_background: false, even_in_maintenance_mode: false, status: 'processed', logs: 1, exceptions: 0 })
    expect(first!.duration).toBeGreaterThanOrEqual(9_000)
    expect(first!.trace_id).toMatch(UUID)
    expect(of('log')[0]).toMatchObject({ execution_source: 'schedule', execution_id: first!.trace_id, trace_id: first!.trace_id, execution_preview: '' })
    expect(second!.trace_id).not.toBe(first!.trace_id)
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(second).toMatchObject({ timezone: zone, _group: md5(`nightly-sync,0 2 * * *,${zone}`) })
    expect(first).not.toHaveProperty('user')
  })

  it('scheduledTask: a failing run → failed, an exception record, and the error again', async () => {
    await expect(watch.scheduledTask('nightly-sync', '0 2 * * *', async () => Promise.reject(new Error('upstream down')))).rejects.toThrow('upstream down')
    const [task] = of('scheduled-task')
    expect(task).toMatchObject({ status: 'failed', exceptions: 1, exception_preview: 'upstream down' })
    expect(of('exception')[0]).toMatchObject({ handled: false, execution_source: 'schedule', execution_id: task!.trace_id })
  })

  it('command: exit code 0, the command line, children, and everything flushed before it returns', async () => {
    const flush = vi.spyOn(sink, 'flush')
    const argv = process.argv
    process.argv = ['node', 'scripts/import.js', '--dry-run', 'contacts.csv']
    try {
      const result = await watch.command('import-contacts', async () => {
        expect(flush).not.toHaveBeenCalled()
        watch.log.error('row 3 skipped')
        await sleep(10)
        return { imported: 2 }
      })
      expect(result).toEqual({ imported: 2 })
    } finally {
      process.argv = argv
    }
    expect(flush).toHaveBeenCalledTimes(1)
    const [command] = of('command')
    expect(command).toMatchObject({ v: 1, class: '', name: 'import-contacts', _group: md5('import-contacts'), command: 'import-contacts --dry-run contacts.csv', exit_code: 0, bootstrap: 0, terminating: 0, logs: 1, exceptions: 0, exception_preview: '' })
    expect(command!.duration).toBeGreaterThanOrEqual(9_000)
    expect(command!.action).toBe(command!.duration)
    expect(of('log')[0]).toMatchObject({ execution_source: 'command', execution_id: command!.trace_id, execution_preview: 'import-contacts' })
    expect(sink.records.map((record) => record.t)).toEqual(['log', 'command'])
  })

  it('command: a failing callback → exit code 1, an exception record, flushed, and the error again', async () => {
    const flush = vi.spyOn(sink, 'flush')
    await expect(
      watch.command('import-contacts', () => {
        throw new TypeError('bad file')
      }),
    ).rejects.toThrow(TypeError)
    expect(of('command')[0]).toMatchObject({ exit_code: 1, exceptions: 1, exception_preview: 'bad file' })
    expect(of('exception')[0]).toMatchObject({ class: 'TypeError', handled: false, execution_source: 'command', execution_preview: 'import-contacts' })
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('command with a job inside: the error is recorded once, and both parents say failed', async () => {
    await expect(watch.command('nightly', () => watch.job('Step', async () => Promise.reject(new Error('step failed'))))).rejects.toThrow('step failed')
    expect(of('exception')).toHaveLength(1)
    expect(of('exception')[0]).toMatchObject({ execution_source: 'job' })
    expect(of('job-attempt')[0]).toMatchObject({ status: 'failed', exceptions: 1, exception_preview: 'step failed' })
    expect(of('command')[0]).toMatchObject({ exit_code: 1, exceptions: 0, exception_preview: 'step failed' })
    expect(of('job-attempt')[0]!.trace_id).toBe(of('command')[0]!.trace_id)
  })

  it('command registers the collector when nothing did (a standalone script)', async () => {
    const runtime = getRuntime()
    runtime.registered = false
    runtime.sink = null
    const token = process.env.DOXA_WATCH_TOKEN
    delete process.env.DOXA_WATCH_TOKEN // no token: registering leaves the SDK inert, and the script still runs
    const notice = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(watch.command('standalone', async () => 'done')).resolves.toBe('done')
      expect(runtime.registered).toBe(true)
    } finally {
      notice.mockRestore()
      warn.mockRestore()
      log.mockRestore()
      if (token !== undefined) process.env.DOXA_WATCH_TOKEN = token
    }
  })

  it('with the SDK inert the wrappers only run the callback', async () => {
    getRuntime().sink = null
    expect(watch.job('x', () => 1)).toBe(1)
    await expect(watch.scheduledTask('x', '* * * * *', async () => 2)).resolves.toBe(2)
    await expect(watch.command('x', async () => 3)).resolves.toBe(3)
    expect(() =>
      watch.job('x', () => {
        throw new Error('still thrown')
      }),
    ).toThrow('still thrown')
    expect(sink.records).toHaveLength(0)
  })
})
