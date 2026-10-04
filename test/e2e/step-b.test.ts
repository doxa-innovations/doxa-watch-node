import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeServer, type WireRecord } from '../helpers/fake-server'
import { FIXTURES, type Fixture, type RunningApp, fixtureDir, standaloneDir, startApp } from './harness'

const selected = FIXTURES.filter((fixture) => process.env.E2E_FIXTURE === undefined || process.env.E2E_FIXTURE === fixture)
/** Set by the global set-up when it could start a throwaway Postgres (Docker). */
const databaseUrl = process.env.E2E_DATABASE_URL
const NO_DATABASE = 'SKIPPED: no Postgres — Docker is not available on this machine'

interface Frame {
  file: string
  source: string
  code: Record<string, string> | null
}

describe.each(selected)('%s: queries, mail and the manual API', (fixture: Fixture) => {
  let watch: FakeServer
  let upstream: FakeServer
  let app: RunningApp

  beforeAll(async () => {
    watch = await new FakeServer().start()
    upstream = await new FakeServer().start()
    app = await startApp(fixture, {
      DOXA_WATCH_TOKEN: 'fixture-token',
      DOXA_WATCH_BASE_URL: watch.url,
      DOXA_WATCH_SERVER: 'fixture-web',
      UPSTREAM_URL: upstream.url,
      DATABASE_URL: databaseUrl ?? 'postgres://postgres:fixture@127.0.0.1:9/none',
    })
  })
  afterAll(async () => {
    await app?.stop()
    await watch?.stop()
    await upstream?.stop()
  })

  async function requestFor(path: string): Promise<WireRecord> {
    const find = () => watch.of('request').find((record) => String(record.url) === `${app.url}${path}`)
    await watch.waitFor(() => find() !== undefined, 12_000, `the request record of ${path}`)
    return find() as WireRecord
  }

  const childrenOf = (id: unknown, type: string) => watch.of(type).filter((record) => record.execution_id === id)

  it('standalone output keeps pg and nodemailer external, so the SDK patches the copies the app uses', () => {
    for (const path of ['node_modules/pg/package.json', 'node_modules/nodemailer/package.json']) {
      expect(existsSync(join(standaloneDir(fixture), path)), path).toBe(true)
    }
  })

  it.skipIf(databaseUrl === undefined)(`pg: pooled and client queries against a real Postgres${databaseUrl === undefined ? ` — ${NO_DATABASE}` : ''}`, async () => {
    const response = await fetch(`${app.url}/api/query`)
    expect(await response.json()).toEqual({ deals: [2, 4], token: 'bind-secret-value', failed: 'relation "no_such_table" does not exist' })

    const request = await requestFor('/api/query')
    expect(request).toMatchObject({ status_code: 200, route_path: '/api/query', queries: 3 })
    const queries = childrenOf(request.trace_id, 'query')
    // Three statements, three records: a pooled query is not counted once for the pool and once for its client.
    expect(queries.map((query) => query.sql)).toEqual([
      'select id::int from generate_series(1, 5) as id where id in ($1, $2)',
      'select $1::text as token',
      'select * from no_such_table',
    ])
    for (const query of queries) {
      expect(query).toMatchObject({ v: 1, connection: 'fixture_crm', connection_type: '', file: 'app/api/query/route.ts', execution_source: 'request', execution_preview: 'GET /api/query', trace_id: request.trace_id, user: '' })
      expect(query.duration).toBeGreaterThan(0)
      expect(query._group).toMatch(/^[0-9a-f]{32}$/)
      expect(Object.keys(query)).toEqual(['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'execution_source', 'execution_id', 'execution_preview', 'execution_stage', 'user', 'sql', 'file', 'line', 'duration', 'connection', 'connection_type'])
    }
    // The caller's own line in the original source: pool.query in findDeals, client.query and the failing pool.query in GET.
    expect(queries.map((query) => query.line)).toEqual([8, 18, 24])
    expect(queries[0]!.timestamp).toBeLessThan(queries[2]!.timestamp as number)
    // Bind values never leave the process.
    expect(JSON.stringify(watch.records)).not.toContain('bind-secret-value')
  })

  it('nodemailer: json and stream transports, counts only, the given name as class', async () => {
    const response = await fetch(`${app.url}/api/mail`)
    const body = (await response.json()) as { keys: string[]; receipt: boolean }
    expect(body.receipt).toBe(true)
    expect(body.keys).toContain('subject')
    expect(body.keys).not.toContain('watch')

    const request = await requestFor('/api/mail')
    expect(request).toMatchObject({ status_code: 200, mail: 2 })
    const mails = childrenOf(request.trace_id, 'mail')
    expect(mails).toHaveLength(2)
    expect(mails[0]).toMatchObject({ v: 1, mailer: 'JSONTransport', class: 'WelcomeMail', subject: 'Welcome aboard', to: 2, cc: 1, bcc: 1, attachments: 1, failed: false, execution_preview: 'GET /api/mail', trace_id: request.trace_id })
    expect(mails[1]).toMatchObject({ mailer: 'StreamTransport', class: '', subject: 'Receipt', to: 1, cc: 0, bcc: 0, attachments: 0, failed: false })
    expect(Object.keys(mails[0]!)).toEqual(['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'execution_source', 'execution_id', 'execution_preview', 'execution_stage', 'user', 'mailer', 'class', 'subject', 'to', 'cc', 'bcc', 'attachments', 'duration', 'failed'])
    expect(JSON.stringify(watch.records)).not.toContain('example.com')
  })

  it('watch.job inside a request: a job-attempt on the request’s trace, with its own children', async () => {
    const response = await fetch(`${app.url}/api/job`)
    expect(await response.json()).toEqual({ result: 'sent' })

    const request = await requestFor('/api/job')
    const attempt = watch.of('job-attempt').find((record) => record.trace_id === request.trace_id) as WireRecord
    expect(attempt).toMatchObject({ v: 1, name: 'SendInvoice', queue: 'invoices', connection: 'inline', attempt: 1, status: 'processed', logs: 1, outgoing_requests: 1, exceptions: 0, exception_preview: '', server: 'fixture-web', user: '' })
    expect(attempt.attempt_id).not.toBe(request.trace_id)
    expect(attempt.duration).toBeGreaterThan(0)
    expect(Object.values(attempt).every((value) => value !== null)).toBe(true)
    // The log and the fetch belong to the attempt, not to the request around it.
    expect(childrenOf(attempt.attempt_id, 'log')).toMatchObject([{ message: 'sending invoice', execution_source: 'job', execution_preview: 'SendInvoice', trace_id: request.trace_id }])
    expect(childrenOf(attempt.attempt_id, 'outgoing-request')).toMatchObject([{ url: `${upstream.url}/upstream/invoice`, execution_source: 'job' }])
    expect(request).toMatchObject({ status_code: 200, logs: 0, outgoing_requests: 0 })
  })

  it('watch.job that throws: failed, an unhandled exception with real function names in the trace, and the error again', async () => {
    const response = await fetch(`${app.url}/api/job?fail`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ failed: 'card declined' })

    const find = () => watch.of('exception').find((record) => record.message === 'card declined')
    await watch.waitFor(() => find() !== undefined, 12_000, 'the job exception')
    const exception = find() as WireRecord
    expect(exception).toMatchObject({ class: 'RangeError', handled: false, file: 'app/api/job/route.ts', line: 6, execution_source: 'job', execution_preview: 'SendInvoice' })

    const trace = JSON.parse(exception.trace as string) as Frame[]
    expect(trace[0]).toMatchObject({ file: 'app/api/job/route.ts:6', source: '' })
    expect(trace[1]!.file).toMatch(/^app\/api\/job\/route\.ts:\d+$/)
    // `withDoxaWatch` turns server minification off, so with webpack the entry after the throw site names the real
    // function that threw, at the line it was called from. Turbopack (Next 16's default bundler) does not read that
    // option: it still minifies and inlines the function, so there the name is the minifier's.
    if (fixture === 'next15') expect(trace[1]).toMatchObject({ file: 'app/api/job/route.ts:15', source: 'chargeCustomer' })
    else expect(typeof trace[1]!.source).toBe('string')

    await watch.waitFor(() => watch.of('job-attempt').some((record) => record.attempt_id === exception.execution_id), 12_000, 'the failed attempt')
    const attempt = watch.of('job-attempt').find((record) => record.attempt_id === exception.execution_id) as WireRecord
    expect(attempt).toMatchObject({ status: 'failed', exceptions: 1, exception_preview: 'card declined', outgoing_requests: 1 })
    expect(attempt.trace_id).toBe(exception.trace_id)
  })
})

describe('a standalone script: watch.command without register()', () => {
  const fixture = selected[0] as Fixture
  let watch: FakeServer

  beforeAll(async () => {
    watch = await new FakeServer().start()
  })
  afterAll(async () => {
    await watch?.stop()
  })

  /**
   * Runs a CommonJS script from the fixture's directory, where `doxa-watch` and `pg` are installed. With `-e` the
   * first argument takes the place a script path has in `process.argv`.
   */
  function runScript(source: string, env: Record<string, string>): Promise<{ code: number | null; output: string }> {
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('DOXA_WATCH_') && key !== 'NODE_OPTIONS') clean[key] = value
    }
    return new Promise((resolve) => {
      const child = execFile(process.execPath, ['-e', source, 'scripts/import.js', 'contacts.csv', '--dry-run'], { cwd: fixtureDir(fixture), env: { ...clean, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (child.exitCode ?? 1), output: `${stdout}${stderr}` })
      })
    })
  }

  it('registers by itself, records the command and its children, sends before it returns, and lets the process end', async () => {
    const script = `
      const { watch } = require('doxa-watch')
      watch.command('import-contacts', async () => {
        watch.log.info('importing')
        return 2
      }).then((imported) => { console.log('imported ' + imported) })
    `
    const { code, output } = await runScript(script, { DOXA_WATCH_TOKEN: 'script-token', DOXA_WATCH_BASE_URL: watch.url, DOXA_WATCH_SERVER: 'script-host' })
    expect(output).toContain('imported 2')
    expect(code).toBe(0)
    // Already here: nothing was left to a timer or an exit hook.
    const [command] = watch.of('command')
    expect(command).toMatchObject({ v: 1, name: 'import-contacts', class: '', command: 'import-contacts contacts.csv --dry-run', exit_code: 0, logs: 1, server: 'script-host', bootstrap: 0, terminating: 0, exception_preview: '', context: '{}' })
    expect(command!.action).toBe(command!.duration)
    expect(watch.of('log')).toMatchObject([{ message: 'importing', execution_source: 'command', execution_id: command!.trace_id, execution_preview: 'import-contacts' }])
    expect(Object.values(command!).every((value) => value !== null)).toBe(true)
  })

  it('a failing command: exit code 1 on the record, the exception sent, and the script sees the error', async () => {
    watch.reset()
    const script = `
      const { watch } = require('doxa-watch')
      watch.command('import-contacts', async () => { throw new TypeError('bad file') })
        .catch((error) => { console.log('caught ' + error.message); process.exitCode = 3 })
    `
    const { code, output } = await runScript(script, { DOXA_WATCH_TOKEN: 'script-token', DOXA_WATCH_BASE_URL: watch.url })
    expect(output).toContain('caught bad file')
    expect(code).toBe(3)
    expect(watch.of('command')).toMatchObject([{ exit_code: 1, exceptions: 1, exception_preview: 'bad file' }])
    expect(watch.of('exception')).toMatchObject([{ class: 'TypeError', message: 'bad file', handled: false, execution_source: 'command', framework: '' }])
  })

  it.skipIf(databaseUrl === undefined)(`pg in plain Node: every call shape against a real Postgres, pooled queries once${databaseUrl === undefined ? ` — ${NO_DATABASE}` : ''}`, async () => {
    watch.reset()
    const script = `
      const { watch } = require('doxa-watch')
      const pg = require('pg')
      const out = {}
      watch.command('pg-shapes', async () => {
        const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
        await client.connect()
        out.text = (await client.query('select 1 as n')).rows[0].n
        out.values = (await client.query('select $1::int as n', [2])).rows[0].n
        out.config = (await client.query({ text: 'select $1::int as n', values: [3], rowMode: 'array' })).rows[0][0]
        out.named = (await client.query({ name: 'four', text: 'select $1::int + 0 as n', values: [4] })).rows[0].n
        out.callback = await new Promise((resolve, reject) => client.query('select $1::int + 1 as n', [4], (error, result) => error ? reject(error) : resolve(result.rows[0].n)))
        out.configCallback = await new Promise((resolve) => client.query({ text: 'select 6 as n', callback: (error, result) => resolve(result.rows[0].n) }))
        const submitted = new pg.Query('select 7 as n')
        out.same = client.query(submitted) === submitted
        out.rows = await new Promise((resolve, reject) => { const rows = []; submitted.on('row', (row) => rows.push(row.n)); submitted.on('end', () => resolve(rows)); submitted.on('error', reject) })
        out.rejected = await client.query('select * from no_such_table').then(() => '', (error) => error.code)
        out.failedCallback = await new Promise((resolve) => client.query('select * from no_such_table', (error) => resolve(error.code)))
        try { client.query(null) } catch (error) { out.thrown = error.constructor.name }
        await client.end()

        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
        out.pool = (await pool.query('select $1::int as n where $1 in ($1, $2)', [8, 9])).rows[0].n
        out.poolCallback = await new Promise((resolve) => pool.query('select 9 as n', (error, result) => resolve(result.rows[0].n)))
        // More callers than connections: each waits for the one client and is still recorded once.
        out.contended = (await Promise.all([10, 11, 12].map((n) => pool.query('select $1::int as n', [n])))).map((result) => result.rows[0].n)
        await pool.end()
      }).then(() => console.log(JSON.stringify(out)), (error) => { console.log('FAILED ' + error.stack); process.exitCode = 1 })
    `
    const { code, output } = await runScript(script, { DOXA_WATCH_TOKEN: 'script-token', DOXA_WATCH_BASE_URL: watch.url, DATABASE_URL: databaseUrl as string })
    expect(code, output).toBe(0)
    // Behaviour and return values are those of pg itself.
    expect(JSON.parse(output.trim().split('\n').pop() as string)).toEqual({
      text: 1, values: 2, config: 3, named: 4, callback: 5, configCallback: 6, same: true, rows: [7], rejected: '42P01', failedCallback: '42P01', thrown: 'TypeError', pool: 8, poolCallback: 9, contended: [10, 11, 12],
    })

    const [command] = watch.of('command')
    const queries = watch.of('query')
    expect(queries.map((query) => query.sql)).toEqual([
      'select 1 as n',
      'select $1::int as n',
      'select $1::int as n',
      'select $1::int + 0 as n',
      'select $1::int + 1 as n',
      'select 6 as n',
      'select 7 as n',
      'select * from no_such_table',
      'select * from no_such_table',
      'select $1::int as n where $1 in ($1, $2)',
      'select 9 as n',
      'select $1::int as n',
      'select $1::int as n',
      'select $1::int as n',
    ])
    expect(command).toMatchObject({ name: 'pg-shapes', exit_code: 0, queries: 14, exceptions: 0 })
    for (const query of queries) {
      expect(query).toMatchObject({ connection: 'fixture_crm', connection_type: '', execution_source: 'command', execution_id: command!.trace_id, execution_preview: 'pg-shapes' })
      expect(query.duration).toBeGreaterThan(0)
    }
    // Same statement and database → same group, whatever the call shape.
    expect(new Set([queries[1], queries[2], queries[11], queries[12], queries[13]].map((query) => query!._group)).size).toBe(1)
  })
})
