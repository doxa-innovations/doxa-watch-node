import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeServer, type WireRecord } from '../helpers/fake-server'
import { FIXTURES, type Fixture, type RunningApp, nextVersion, standaloneDir, startApp } from './harness'

const selected = FIXTURES.filter((fixture) => process.env.E2E_FIXTURE === undefined || process.env.E2E_FIXTURE === fixture)

interface Frame {
  file: string
  source: string
  code: Record<string, string> | null
}

describe.each(selected)('%s: standalone server against a fake Doxa Watch', (fixture: Fixture) => {
  let watch: FakeServer
  // A second server plays the API the app calls: fetches to Doxa Watch's own origin are never recorded.
  let upstream: FakeServer
  let app: RunningApp
  let sdkVersion: string

  beforeAll(async () => {
    watch = await new FakeServer().start()
    upstream = await new FakeServer().start()
    app = await startApp(fixture, {
      DOXA_WATCH_TOKEN: 'fixture-token',
      DOXA_WATCH_BASE_URL: watch.url,
      DOXA_WATCH_SERVER: 'fixture-web',
      UPSTREAM_URL: upstream.url,
    })
    sdkVersion = (JSON.parse(readFileSync(join(standaloneDir(fixture), 'node_modules/@doxa-innovations/watch/package.json'), 'utf8')) as { version: string }).version
  })
  afterAll(async () => {
    await app?.stop()
    await watch?.stop()
    await upstream?.stop()
  })

  /** The `request` record of `path`, once it has arrived (the SDK flushes every 5 s). */
  async function requestFor(path: string): Promise<WireRecord> {
    const find = () => watch.of('request').find((record) => String(record.url) === `${app.url}${path}`)
    await watch.waitFor(() => find() !== undefined, 12_000, `the request record of ${path}`)
    return find() as WireRecord
  }

  const childrenOf = (request: WireRecord, type: string) => watch.of(type).filter((record) => record.execution_id === request.trace_id)

  async function exceptionWith(message: string): Promise<WireRecord> {
    const find = () => watch.of('exception').find((record) => record.message === message)
    await watch.waitFor(() => find() !== undefined, 12_000, `the exception "${message}"`)
    return find() as WireRecord
  }

  it('standalone output contains the SDK, its dependencies and the server source maps', () => {
    const dir = standaloneDir(fixture)
    for (const path of ['node_modules/@doxa-innovations/watch/dist/next/index.js', 'node_modules/@opentelemetry/api/package.json', 'node_modules/@opentelemetry/sdk-trace-base/package.json', 'node_modules/source-map-js/package.json']) {
      expect(existsSync(join(dir, path)) || existsSync(join(dir, path.replace('index.js', 'index.cjs'))), path).toBe(true)
    }
  })

  it('authenticates with the Node user agent and the server name', async () => {
    await watch.waitFor(() => watch.auths.length >= 1, 5000, 'the auth call')
    expect(watch.auths[0]!.headers).toMatchObject({
      authorization: 'Bearer fixture-token',
      'nightwatch-server': 'fixture-web',
      'user-agent': `DoxaWatchNode/${sdkVersion} (next/${nextVersion(fixture)}; node/${process.versions.node})`,
    })
  })

  it('a page: route pattern, action, stages, and the build id as deploy', async () => {
    const response = await fetch(`${app.url}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Home')
    const request = await requestFor('/')
    expect(request).toMatchObject({ v: 1, method: 'GET', status_code: 200, route_path: '/', route_methods: ['GET'], route_action: 'page app/page', server: 'fixture-web', user: '', payload: '', bootstrap: 0, after_middleware: 0, sending: 0, terminating: 0 })
    expect(request.duration).toBe((request.before_middleware as number) + (request.action as number) + (request.render as number))
    expect(request.render).toBeGreaterThan(0)
    expect(request.response_size).toBeGreaterThan(0)
    expect(request._group).toMatch(/^[0-9a-f]{32}$/)
    expect(request.deploy).toBe(readFileSync(join(standaloneDir(fixture), '.next/BUILD_ID'), 'utf8').trim())
    expect(Object.values(request).every((value) => value !== null)).toBe(true)
  })

  it('a dynamic route: the pattern, not the concrete path; the user and a log attach to the request', async () => {
    const response = await fetch(`${app.url}/deals/981?tab=notes`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-fixture-middleware')).toBe('1')
    const request = await requestFor('/deals/981?tab=notes')
    expect(request).toMatchObject({ route_path: '/deals/[id]', route_action: 'page app/deals/[id]/page', user: '42', logs: 1, status_code: 200 })
    // Next 16's proxy.ts runs in Node and is timed; Next 15's Edge middleware runs in a sandbox the SDK cannot see into.
    if (fixture === 'next16') expect(request.before_middleware).toBeGreaterThan(0)
    else expect(request.before_middleware).toBe(0)
    expect(watch.of('user').find((record) => record.id === '42')).toMatchObject({ v: 1, name: 'Ada Lovelace', username: 'ada@example.com' })
    const logs = childrenOf(request, 'log')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'info', message: 'deal viewed', context: '{"id":"981"}', user: '42', execution_source: 'request', execution_preview: 'GET /deals/981', trace_id: request.trace_id })
  })

  it('a path no route matches: recorded as a 404 without a route', async () => {
    expect((await fetch(`${app.url}/no-such-page`)).status).toBe(404)
    const request = await requestFor('/no-such-page')
    expect(request).toMatchObject({ status_code: 404, route_path: '', route_methods: [], route_action: '' })
  })

  it('a route handler with an outgoing fetch', async () => {
    const response = await fetch(`${app.url}/api/hello`)
    expect(await response.json()).toEqual({ hello: 'world', upstream: true })
    const request = await requestFor('/api/hello')
    expect(request).toMatchObject({ route_path: '/api/hello', route_action: 'route app/api/hello/route', status_code: 200, outgoing_requests: 1, render: 0 })
    const outgoing = childrenOf(request, 'outgoing-request')
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]).toMatchObject({ v: 1, host: new URL(upstream.url).host, method: 'GET', url: `${upstream.url}/upstream/items?page=2`, status_code: 200, execution_preview: 'GET /api/hello', trace_id: request.trace_id })
    expect(outgoing[0]!.duration).toBeGreaterThan(0)
    expect(upstream.upstream).toHaveLength(1)
  })

  it('a server action', async () => {
    const manifest = JSON.parse(readFileSync(join(standaloneDir(fixture), '.next/server/server-reference-manifest.json'), 'utf8')) as { node: Record<string, { workers: Record<string, unknown> }> }
    const id = Object.entries(manifest.node).find(([, entry]) => Object.keys(entry.workers).some((worker) => worker.includes('/action/page')))?.[0]
    expect(id, 'a server action id in the manifest').toBeDefined()
    const response = await fetch(`${app.url}/action`, { method: 'POST', headers: { 'next-action': id as string, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: '[]' })
    expect(response.status).toBe(200)
    await response.text()
    const find = () => watch.of('request').find((record) => record.method === 'POST' && String(record.url) === `${app.url}/action`)
    await watch.waitFor(() => find() !== undefined, 12_000, 'the action request')
    const request = find() as WireRecord
    expect(request).toMatchObject({ route_path: '/action', route_methods: ['POST'], route_action: 'action app/action/page', status_code: 200 })
    expect(childrenOf(request, 'log').map((log) => [log.level, log.message])).toContainEqual(['notice', 'note saved'])
  })

  it('a throwing page: an unhandled exception resolved to the original file, line and code', async () => {
    const response = await fetch(`${app.url}/boom`)
    expect(response.status).toBe(500)
    const exception = await exceptionWith('page exploded')
    expect(exception).toMatchObject({ v: 3, class: 'TypeError', handled: false, file: 'app/boom/page.tsx', line: 4, execution_source: 'request', execution_preview: 'GET /boom', php_version: '', laravel_version: '', runtime: 'node', runtime_version: process.versions.node, framework: 'next', framework_version: nextVersion(fixture) })
    const trace = JSON.parse(exception.trace as string) as Frame[]
    expect(trace[0]).toMatchObject({ file: 'app/boom/page.tsx:4', source: '' })
    expect(trace[0]!.code!['4']).toContain("throw new TypeError('page exploded')")
    expect(Object.keys(trace[0]!.code!)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    // The production build minifies and inlines, so later entries are Next's runtime (vendor, no code) and the
    // function names are the minified ones; the shift by one is covered by the unit tests.
    expect(trace.length).toBeGreaterThan(2)
    expect(trace.slice(1).every((frame) => typeof frame.source === 'string' && typeof frame.file === 'string')).toBe(true)
    expect(trace.some((frame) => frame.file.startsWith('node_modules/next/') && frame.code === null)).toBe(true)

    const request = await requestFor('/boom')
    expect(request).toMatchObject({ status_code: 500, route_path: '/boom', exception_preview: 'page exploded' })
    expect(request.exceptions).toBeGreaterThanOrEqual(1)
    expect(exception.trace_id).toBe(request.trace_id)
  })

  it('a throwing route handler', async () => {
    const response = await fetch(`${app.url}/api/boom`)
    expect(response.status).toBe(500)
    const exception = await exceptionWith('handler exploded')
    expect(exception).toMatchObject({ class: 'RangeError', handled: false, file: 'app/api/boom/route.ts', line: 4, execution_preview: 'GET /api/boom' })
    const trace = JSON.parse(exception.trace as string) as Frame[]
    expect(trace[0]!.file).toBe('app/api/boom/route.ts:4')
    expect(trace[0]!.code!['4']).toContain("throw new RangeError('handler exploded')")
    const request = await requestFor('/api/boom')
    expect(request).toMatchObject({ status_code: 500, route_path: '/api/boom', route_action: 'route app/api/boom/route', exception_preview: 'handler exploded' })
  })

  it('a handled exception reported with watch.captureException', async () => {
    await fetch(`${app.url}/api/handled`)
    const request = await requestFor('/api/handled')
    const exceptions = childrenOf(request, 'exception')
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({ class: 'SyntaxError', handled: true, file: 'app/api/handled/route.ts', line: 7 })
    expect(request).toMatchObject({ status_code: 200, exceptions: 1, exception_preview: '' })
  })

  it('console.error becomes a log with the exception class; console.log stays below the default level', async () => {
    await fetch(`${app.url}/api/log`)
    const request = await requestFor('/api/log')
    const logs = childrenOf(request, 'log')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ v: 1, level: 'error', execution_preview: 'GET /api/log', extra: '{}' })
    expect(logs[0]!.message).toContain('payment provider said no')
    expect(JSON.parse(logs[0]!.context as string)).toEqual({ exception: { class: 'TypeError', message: 'card declined' } })
    expect(request.logs).toBe(1)
  })

  it('static assets and /_next are not recorded; the SDK never records its own calls', async () => {
    await fetch(`${app.url}/favicon.ico`)
    await fetch(`${app.url}/_next/static/chunks/nothing.js`)
    await fetch(`${app.url}/api/doxa-watch`, { method: 'POST', body: '{}' })
    await fetch(`${app.url}/`)
    await watch.waitFor(() => watch.of('request').filter((record) => record.url === `${app.url}/`).length >= 2, 12_000, 'the second home request')
    const urls = watch.of('request').map((record) => String(record.url))
    expect(urls.some((url) => url.includes('favicon') || url.includes('/_next/') || url.includes('/api/doxa-watch'))).toBe(false)
    expect(watch.of('outgoing-request').some((record) => String(record.url).includes('/api/ingest') || String(record.url).includes('/api/agent-auth'))).toBe(false)
    expect(watch.ingests.every((request) => request.headers['content-encoding'] === 'gzip' && request.headers.authorization === 'Bearer short-lived')).toBe(true)
  })

  it('every record carries every key with a non-null value', () => {
    for (const record of watch.records) {
      for (const [key, value] of Object.entries(record)) expect(value, `${record.t}.${key}`).not.toBeNull()
    }
    expect(watch.records.length).toBeGreaterThan(10)
  })

  it('SIGTERM: what is still buffered is sent, and the process ends the way it does without the SDK', async () => {
    // What this Next version does on SIGTERM by itself (15 exits 0 after a graceful close; 16 dies of the signal).
    const baseline = await startApp(fixture, { UPSTREAM_URL: upstream.url })
    baseline.process.kill('SIGTERM')
    const expected = [await baseline.exited, baseline.process.signalCode]

    await fetch(`${app.url}/deals/sigterm`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(watch.of('request').some((record) => record.url === `${app.url}/deals/sigterm`)).toBe(false) // still buffered
    app.process.kill('SIGTERM')
    expect([await app.exited, app.process.signalCode]).toEqual(expected)
    await watch.waitFor(() => watch.of('request').some((record) => record.url === `${app.url}/deals/sigterm`), 3000, 'the buffered request')
    expect(watch.of('request').filter((record) => record.url === `${app.url}/deals/sigterm`)).toHaveLength(1)
  })
})

describe.each(selected)('%s: no token', (fixture: Fixture) => {
  let watch: FakeServer
  let app: RunningApp

  beforeAll(async () => {
    watch = await new FakeServer().start()
    app = await startApp(fixture, { DOXA_WATCH_BASE_URL: watch.url, UPSTREAM_URL: watch.url })
  })
  afterAll(async () => {
    await app?.stop()
    await watch?.stop()
  })

  it('boots, serves pages, handlers and errors as usual, says so once, and contacts nobody', async () => {
    expect((await fetch(`${app.url}/`)).status).toBe(200)
    expect((await fetch(`${app.url}/deals/7`)).status).toBe(200)
    expect(await (await fetch(`${app.url}/api/hello`)).json()).toEqual({ hello: 'world', upstream: true })
    expect((await fetch(`${app.url}/boom`)).status).toBe(500)
    expect((await fetch(`${app.url}/api/handled`)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(watch.auths).toHaveLength(0)
    expect(watch.ingests).toHaveLength(0)
    expect(app.output().match(/\[doxa-watch\] DOXA_WATCH_TOKEN is not set/g)).toHaveLength(1)
    expect(app.process.exitCode).toBeNull()
  })
})
