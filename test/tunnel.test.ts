import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceMapGenerator } from 'source-map-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigOverrides, RequestInfo } from '../src/config'
import { createTunnel } from '../src/next/tunnel'
import { MAX_BODY_BYTES, RateLimiter, isSameOrigin, readBody } from '../src/next/tunnel/limits'
import { parseUserAgent } from '../src/next/tunnel/user-agent'
import { parseReport } from '../src/next/tunnel/validate'
import { resetRuntime } from '../src/runtime'
import { clearSourceMapCache } from '../src/stacktrace/sourcemaps'
import { type MemorySink, useMemorySink } from './helpers/sink'

const ID = '6f1c0f0e-3b7a-4f0e-9d51-0c2a4b7a9e11'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const ORIGIN = 'https://crm.example.com'

let root: string
let sink: MemorySink

const SOURCE = Array.from({ length: 30 }, (_, n) => `// page line ${n + 1}`).join('\n')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'doxa-watch-tunnel-'))
  // What `doxa-watch postbuild` leaves: the map of /_next/static/chunks/app/page-abc.js.
  const generator = new SourceMapGenerator({ file: 'page-abc.js' })
  generator.addMapping({ generated: { line: 1, column: 5000 }, original: { line: 15, column: 2 }, source: 'webpack://_N_E/./app/deals/[id]/page.tsx' })
  generator.addMapping({ generated: { line: 1, column: 9000 }, original: { line: 120, column: 0 }, source: 'webpack://_N_E/./node_modules/react-dom/cjs/react-dom.production.js' })
  generator.setSourceContent('webpack://_N_E/./app/deals/[id]/page.tsx', SOURCE)
  mkdirSync(join(root, '.next/doxa-watch/maps/chunks/app'), { recursive: true })
  writeFileSync(join(root, '.next/doxa-watch/maps/chunks/app/page-abc.js.map'), generator.toString())
  // Files a forged stack might point at.
  writeFileSync(join(root, '.env'), 'SECRET=do-not-leak\n')
  writeFileSync(join(root, 'server.js'), 'const secret = "do-not-leak"\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function setup(overrides: ConfigOverrides = {}): void {
  sink = useMemorySink({ projectRoot: root, framework: { name: 'next', version: '15.5.27' }, ...overrides }).sink
}
beforeEach(() => {
  clearSourceMapCache()
  setup()
})
afterEach(() => vi.restoreAllMocks())

const sameOrigin = { origin: ORIGIN, host: 'crm.example.com', 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.9' }

function post(body: unknown, headers: Record<string, string> = sameOrigin): Request {
  return new Request(`${ORIGIN}/api/doxa-watch`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

const error = (extra: Record<string, unknown> = {}) => ({
  name: 'TypeError',
  message: 'x is not a function',
  stack: `TypeError: x is not a function\n    at onClick (${ORIGIN}/_next/static/chunks/app/page-abc.js:1:5001)\n    at dispatch (${ORIGIN}/_next/static/chunks/app/page-abc.js:1:9001)\n    at ${ORIGIN}/_next/static/chunks/unmapped.js:2:3`,
  handled: false,
  route: '/deals/[id]',
  path: '/deals/981',
  ...extra,
})
const vital = (extra: Record<string, unknown> = {}) => ({ name: 'LCP', value: 1834.5, rating: 'good', nav: 'navigate', route: '/deals/[id]', path: '/deals/981', ...extra })

async function expectEmpty204(response: Response): Promise<void> {
  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
}

describe('tunnel: records', () => {
  it('builds a browser exception: runtime fields, browser execution, frames resolved from the moved maps', async () => {
    const tunnel = createTunnel()
    await expectEmpty204(await tunnel(post({ id: ID, errors: [error({ code: 'E_CLICK' })] })))

    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.options).toEqual({ immediate: true })
    const [record] = sink.records
    expect(record).toMatchObject({
      v: 3,
      t: 'exception',
      deploy: 'v1.2.3',
      server: 'web-01',
      trace_id: ID,
      execution_source: 'browser',
      execution_id: ID,
      execution_preview: 'PAGE /deals/[id]',
      execution_stage: 'action',
      user: '',
      class: 'TypeError',
      file: 'app/deals/[id]/page.tsx',
      line: 15,
      message: 'x is not a function',
      code: 'E_CLICK',
      handled: false,
      php_version: '',
      laravel_version: '',
      runtime: 'browser',
      runtime_version: 'Chrome 141',
      framework: 'next',
      framework_version: '15.5.27',
    })
    expect(record!._group).toBe(createHash('md5').update('TypeError,E_CLICK,app/deals/[id]/page.tsx,15').digest('hex'))
    expect(Object.keys(record!)).toEqual(['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'execution_source', 'execution_id', 'execution_preview', 'execution_stage', 'user', 'class', 'file', 'line', 'message', 'code', 'trace', 'handled', 'php_version', 'laravel_version', 'runtime', 'runtime_version', 'framework', 'framework_version'])
    expect(Object.values(record!).every((value) => value !== null && value !== undefined)).toBe(true)

    const trace = JSON.parse(record!.trace as string) as { file: string; source: string; code: Record<string, string> | null }[]
    expect(trace).toHaveLength(3)
    // PHP convention: entry 0 is the throw site; each later entry names the function called from there.
    expect(trace[0]).toMatchObject({ file: 'app/deals/[id]/page.tsx:15', source: '' })
    expect(Object.keys(trace[0]!.code!)).toEqual(['10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'])
    expect(trace[0]!.code!['15']).toBe('// page line 15')
    expect(trace[1]).toEqual({ file: 'node_modules/react-dom/cjs/react-dom.production.js:120', source: 'onClick', code: null })
    // No map covers this frame: kept, with the location as built.
    expect(trace[2]).toEqual({ file: `${ORIGIN}/_next/static/chunks/unmapped.js:2`, source: 'dispatch', code: null })
  })

  it('handled comes from the client; missing optional fields get their defaults; Firefox and Safari stacks resolve too', async () => {
    const tunnel = createTunnel()
    await tunnel(post({ id: ID, errors: [
      { name: 'Error', message: 'gecko', stack: `onClick@${ORIGIN}/_next/static/chunks/app/page-abc.js:1:5001\n@${ORIGIN}/other.js:1:1`, handled: true, path: '/deals/981?tab=notes#top' },
      { name: 'Error', message: 'no stack', path: '/x' },
    ] }))
    const [gecko, bare] = sink.records
    expect(gecko).toMatchObject({ handled: true, file: 'app/deals/[id]/page.tsx', line: 15, execution_preview: 'PAGE /deals/981', code: '' })
    expect(bare).toMatchObject({ handled: false, file: '', line: 0, trace: '[]', execution_preview: 'PAGE /x' })
    expect(JSON.stringify(sink.records)).not.toContain('tab=notes')
  })

  it('a missing or corrupt map leaves the frames unresolved and the exception recorded', async () => {
    writeFileSync(join(root, '.next/doxa-watch/maps/chunks/corrupt.js.map'), '{"version":3,"sources":["a.ts"],"mappings":"%%%')
    writeFileSync(join(root, '.next/doxa-watch/maps/chunks/garbage.js.map'), 'not json')
    const tunnel = createTunnel()
    await tunnel(post({ id: ID, errors: [error({ stack: `Error: x\n    at a (${ORIGIN}/_next/static/chunks/corrupt.js:1:10)\n    at b (${ORIGIN}/_next/static/chunks/garbage.js:1:20)\n    at c (${ORIGIN}/_next/static/chunks/missing.js:1:30)` })] }))
    const [record] = sink.records
    expect(record).toMatchObject({ t: 'exception', file: `${ORIGIN}/_next/static/chunks/corrupt.js`, line: 1 })
    expect((JSON.parse(record!.trace as string) as { file: string }[]).map((frame) => frame.file)).toEqual([`${ORIGIN}/_next/static/chunks/corrupt.js:1`, `${ORIGIN}/_next/static/chunks/garbage.js:1`, `${ORIGIN}/_next/static/chunks/missing.js:1`])
  })

  it('a forged stack never makes the server read a file: no code from disk, no map outside the maps folder', async () => {
    // A real map outside the maps folder, next to a "built file" a forged frame names.
    const generator = new SourceMapGenerator({ file: 'private.js' })
    generator.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: 'private.ts' })
    generator.setSourceContent('private.ts', 'const secret = "do-not-leak"')
    writeFileSync(join(root, 'private.js.map'), generator.toString())

    const tunnel = createTunnel()
    await tunnel(post({ id: ID, errors: [error({ stack: [
      'Error: forged',
      '    at a (.env:1:1)',
      '    at b (server.js:1:1)',
      `    at c (${join(root, 'server.js')}:1:1)`,
      `    at d (file://${join(root, 'server.js')}:1:1)`,
      '    at e (private.js:1:1)',
      `    at f (${join(root, 'private.js')}:1:1)`,
      `    at g (${ORIGIN}/../../private.js:1:1)`,
      `    at h (${ORIGIN}/_next/static/%2e%2e/%2e%2e/%2e%2e/private.js:1:1)`,
    ].join('\n') })] }))
    const [record] = sink.records
    expect(record!.t).toBe('exception')
    expect(JSON.stringify(record)).not.toContain('do-not-leak')
    const trace = JSON.parse(record!.trace as string) as { file: string; code: unknown }[]
    expect(trace).toHaveLength(8)
    expect(trace.every((frame) => frame.code === null)).toBe(true)
    expect(trace.some((frame) => frame.file.includes('private.ts'))).toBe(false)
  })

  it('builds web-vital records with the device and browser of the user agent', async () => {
    const tunnel = createTunnel()
    await expectEmpty204(await tunnel(post({ id: ID, vitals: [vital(), vital({ name: 'CLS', value: 0.3, rating: 'excellent', nav: 'back-forward' }), vital({ name: 'TTFB', value: 900, rating: undefined, route: undefined, path: '/deals/981?x=1' })] }, { ...sameOrigin, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' })))

    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.options).toBeUndefined() // vitals wait for the next flush
    expect(sink.records).toHaveLength(3)
    expect(sink.records[0]).toEqual({
      v: 1,
      t: 'web-vital',
      timestamp: expect.any(Number),
      deploy: 'v1.2.3',
      server: 'web-01',
      _group: createHash('md5').update('/deals/[id]').digest('hex'),
      trace_id: ID,
      user: '',
      route_path: '/deals/[id]',
      path: '/deals/981',
      name: 'LCP',
      value: 1834.5,
      rating: 'good',
      navigation_type: 'navigate',
      device: 'mobile',
      browser: 'Safari 17',
    })
    // a rating that is not one of the three is recomputed; a missing route falls back to the path, without its query string
    expect(sink.records[1]).toMatchObject({ name: 'CLS', value: 0.3, rating: 'poor', navigation_type: 'back-forward' })
    expect(sink.records[2]).toMatchObject({ name: 'TTFB', rating: 'needs-improvement', route_path: '/deals/981', path: '/deals/981' })
  })

  it('exceptions and vitals of one page load share the trace id; exceptions go first and at once', async () => {
    const tunnel = createTunnel()
    await tunnel(post({ id: ID.toUpperCase(), errors: [error()], vitals: [vital()] }))
    expect(sink.calls.map((call) => [call.records.map((record) => record.t), call.options])).toEqual([[['exception'], { immediate: true }], [['web-vital'], undefined]])
    expect(sink.records.map((record) => record.trace_id)).toEqual([ID, ID])
  })

  it('attaches the user from resolveUser (applied to the tunnel request) and emits a user record', async () => {
    const seen: RequestInfo[] = []
    setup({
      resolveUser: async (request) => {
        seen.push(request)
        return /session=abc/.test(String(request.headers.cookie)) ? { id: 42, name: 'Ada Lovelace', username: 'ada@example.com' } : null
      },
    })
    const tunnel = createTunnel()
    await tunnel(post({ id: ID, errors: [error()], vitals: [vital()] }, { ...sameOrigin, cookie: 'session=abc', 'x-forwarded-proto': 'https' }))

    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/doxa-watch', url: `${ORIGIN}/api/doxa-watch`, ip: '203.0.113.9' })
    expect(seen[0]!.headers['user-agent']).toBe(CHROME)
    expect(sink.records.map((record) => [record.t, record.user ?? record.id])).toEqual([['exception', '42'], ['web-vital', '42'], ['user', '42']])
    expect(sink.records[2]).toEqual({ v: 1, t: 'user', timestamp: expect.any(Number), id: '42', name: 'Ada Lovelace', username: 'ada@example.com' })

    // a guest: no user record
    sink.calls = []
    await tunnel(post({ id: ID, vitals: [vital()] }))
    expect(sink.records.map((record) => record.t)).toEqual(['web-vital'])
    expect(sink.records[0]!.user).toBe('')
  })

  it('createTunnel({ resolveUser }) wins over the registered callback; a throwing or hanging callback costs only the user', async () => {
    setup({ resolveUser: () => ({ id: 'from-register' }) })
    await createTunnel({ resolveUser: () => ({ id: 'from-tunnel' }) })(post({ id: ID, vitals: [vital()] }))
    expect(sink.records[0]!.user).toBe('from-tunnel')

    sink.calls = []
    await createTunnel({ resolveUser: () => { throw new Error('session store down') } })(post({ id: ID, vitals: [vital()] }))
    expect(sink.records.map((record) => [record.t, record.user])).toEqual([['web-vital', '']])

    sink.calls = []
    vi.useFakeTimers()
    try {
      const pending = createTunnel({ resolveUser: () => new Promise(() => {}) })(post({ id: ID, vitals: [vital()] }))
      await vi.advanceTimersByTimeAsync(2100)
      await expectEmpty204(await pending)
    } finally {
      vi.useRealTimers()
    }
    expect(sink.records.map((record) => [record.t, record.user])).toEqual([['web-vital', '']])
  })

  it('vitals are sampled per page load by the configured rate; errors are not affected by it', async () => {
    setup({ vitalsSampleRate: 0.5 })
    const tunnel = createTunnel()
    const low = '10000000-0000-4000-8000-000000000000' // 0.06
    const high = 'f0000000-0000-4000-8000-000000000000' // 0.94
    await tunnel(post({ id: low, vitals: [vital(), vital({ name: 'CLS', value: 0 })] }))
    await tunnel(post({ id: high, vitals: [vital(), vital({ name: 'CLS', value: 0 })], errors: [error()] }))
    await tunnel(post({ id: high, vitals: [vital({ name: 'INP', value: 80 })] })) // the same answer every time
    expect(sink.records.map((record) => [record.t, record.trace_id])).toEqual([['web-vital', low], ['web-vital', low], ['exception', high]])

    setup({ vitalsSampleRate: 0 })
    await createTunnel()(post({ id: low, vitals: [vital()] }))
    expect(sink.records).toEqual([])
  })

  it('browser exceptions honour the exception sample rate', async () => {
    setup({ exceptionSampleRate: 0 })
    await createTunnel()(post({ id: ID, errors: [error()] }))
    expect(sink.records).toEqual([])
  })

  it('does not send code lines when source capture is off', async () => {
    setup({ captureExceptionSourceCode: false })
    await createTunnel()(post({ id: ID, errors: [error()] }))
    expect((JSON.parse(sink.records[0]!.trace as string) as { code: unknown }[])[0]).toMatchObject({ file: 'app/deals/[id]/page.tsx:15', code: null })
  })

  it('reads the maps from mapsDir when given', async () => {
    await createTunnel({ mapsDir: 'nowhere' })(post({ id: ID, errors: [error()] }))
    expect(sink.records[0]).toMatchObject({ file: `${ORIGIN}/_next/static/chunks/app/page-abc.js`, line: 1 })
    sink.calls = []
    await createTunnel({ mapsDir: join(root, '.next/doxa-watch/maps') })(post({ id: ID, errors: [error()] }))
    expect(sink.records[0]).toMatchObject({ file: 'app/deals/[id]/page.tsx', line: 15 })
  })
})

describe('tunnel: every rejection is a 204 that forwards nothing', () => {
  it('inert SDK (no token): 204, nothing read, nothing sent', async () => {
    resetRuntime() // no sink
    const request = post({ id: ID, errors: [error()] })
    await expectEmpty204(await createTunnel()(request))
    expect(request.bodyUsed).toBe(false)
  })

  it.each([
    ['another origin', { ...sameOrigin, origin: 'https://evil.example' }],
    ['another port', { ...sameOrigin, origin: 'https://crm.example.com:8443' }],
    ['a sub-domain', { ...sameOrigin, origin: 'https://app.crm.example.com' }],
    ['no origin', { host: 'crm.example.com', 'user-agent': CHROME }],
    ['origin "null"', { ...sameOrigin, origin: 'null' }],
    ['a cross-site fetch that names our origin', { ...sameOrigin, 'sec-fetch-site': 'cross-site' }],
    ['a same-site (other sub-domain) fetch', { ...sameOrigin, 'sec-fetch-site': 'same-site' }],
  ])('cross-origin: %s', async (_name, headers) => {
    const request = post({ id: ID, errors: [error()], vitals: [vital()] }, headers as Record<string, string>)
    await expectEmpty204(await createTunnel()(request))
    expect(sink.calls).toEqual([])
    expect(request.bodyUsed).toBe(false)
  })

  it.each([
    ['Origin equals Host', sameOrigin],
    ['Origin equals x-forwarded-host behind a proxy', { ...sameOrigin, host: 'web-internal:3000', 'x-forwarded-host': 'crm.example.com' }],
    ['sec-fetch-site: same-origin without Origin', { host: 'crm.example.com', 'sec-fetch-site': 'same-origin' }],
    ['sec-fetch-site: same-origin behind a proxy that rewrites Host', { origin: ORIGIN, host: 'web-internal:3000', 'sec-fetch-site': 'same-origin' }],
  ])('same-origin: %s', async (_name, headers) => {
    await expectEmpty204(await createTunnel()(post({ id: ID, vitals: [vital()] }, headers as Record<string, string>)))
    expect(sink.records).toHaveLength(1)
  })

  it('a body over 64 kB: by content-length, and by what is actually read', async () => {
    const tunnel = createTunnel()
    const big = JSON.stringify({ id: ID, errors: [error({ message: 'x'.repeat(MAX_BODY_BYTES) })] })
    await expectEmpty204(await tunnel(post(big, { ...sameOrigin, 'content-length': String(Buffer.byteLength(big)) })))

    // A stream with no declared length that keeps going past the cap: reading stops there.
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(16 * 1024).fill(120))
      },
    })
    const streaming = new Request(`${ORIGIN}/api/doxa-watch`, { method: 'POST', headers: sameOrigin, body: stream, duplex: 'half' } as RequestInit)
    await expectEmpty204(await tunnel(streaming))
    expect(pulled).toBeLessThan(10)
    expect(sink.calls).toEqual([])

    // just under the cap is fine
    const ok = JSON.stringify({ id: ID, errors: [error({ stack: 'y'.repeat(15_000) })], vitals: [vital()] })
    await tunnel(post(ok))
    expect(sink.records.map((record) => record.t)).toEqual(['exception', 'web-vital'])
  })

  it('more than 60 posts a minute from one IP; other IPs are unaffected; the window resets', async () => {
    vi.useFakeTimers({ now: 1_760_000_000_000 })
    try {
      const tunnel = createTunnel()
      for (let n = 0; n < 75; n++) await expectEmpty204(await tunnel(post({ id: ID, vitals: [vital()] })))
      expect(sink.records).toHaveLength(60)

      await tunnel(post({ id: ID, vitals: [vital()] }, { ...sameOrigin, 'x-forwarded-for': '198.51.100.7, 203.0.113.9' }))
      expect(sink.records).toHaveLength(61)

      vi.advanceTimersByTime(60_001)
      await tunnel(post({ id: ID, vitals: [vital()] }))
      expect(sink.records).toHaveLength(62)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejected posts count against the limit too, and rateLimit is configurable', async () => {
    const tunnel = createTunnel({ rateLimit: 2 })
    await tunnel(post('not json'))
    await tunnel(post('not json'))
    await tunnel(post({ id: ID, vitals: [vital()] }))
    expect(sink.calls).toEqual([])
  })

  it.each([
    ['not JSON', '{"id":'],
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['null', 'null'],
    ['no id', JSON.stringify({ errors: [error()] })],
    ['an id that is not a UUID', JSON.stringify({ id: '../../etc/passwd', errors: [error()] })],
    ['errors not an array', JSON.stringify({ id: ID, errors: { 0: error() } })],
    ['vitals not an array', JSON.stringify({ id: ID, vitals: 'LCP' })],
    ['nothing to report', JSON.stringify({ id: ID })],
    ['an empty body', ''],
  ])('malformed: %s', async (_name, body) => {
    await expectEmpty204(await createTunnel()(post(body)))
    expect(sink.calls).toEqual([])
  })

  it('never throws, whatever the request or the sink do', async () => {
    sink.enqueue = () => {
      throw new Error('sink broke')
    }
    await expectEmpty204(await createTunnel()(post({ id: ID, errors: [error()] })))
    await expectEmpty204(await createTunnel()({ headers: null } as unknown as Request))
  })
})

describe('parseReport: an invalid item is dropped by itself', () => {
  const parse = (report: unknown) => parseReport(JSON.stringify(report))

  it('keeps valid items and normalises them', () => {
    expect(parse({ id: ID.toUpperCase(), errors: [error()], vitals: [vital()], extra: 'ignored' })).toEqual({
      id: ID,
      errors: [{ name: 'TypeError', message: 'x is not a function', stack: expect.any(String), handled: false, code: '', route: '/deals/[id]', path: '/deals/981' }],
      vitals: [{ name: 'LCP', value: 1834.5, rating: 'good', navigationType: 'navigate', route: '/deals/[id]', path: '/deals/981' }],
    })
  })

  it.each([
    ['an unknown name', { name: 'FID' }],
    ['a lower-case name', { name: 'lcp' }],
    ['a name that is not a string', { name: ['LCP'] }],
    ['NaN (null in JSON)', { value: null }],
    ['a string value', { value: '12' }],
    ['a negative value', { value: -1 }],
    ['an absurd value', { value: 1e12 }],
    ['an oversized rating', { rating: 'g'.repeat(33) }],
    ['a rating that is not a string', { rating: 1 }],
    ['an oversized navigation type', { nav: 'n'.repeat(33) }],
    ['an oversized route', { route: `/${'r'.repeat(255)}` }],
    ['a route that is not a path', { route: 'javascript:alert(1)' }],
    ['an oversized path', { path: `/${'p'.repeat(2048)}` }],
    ['a path that is a URL', { path: 'https://evil.example/' }],
    ['a path with control characters', { path: '/a\nb' }],
    ['no path', { path: undefined }],
  ])('drops a vital with %s', (_name, change) => {
    expect(parse({ id: ID, vitals: [vital(change), vital({ name: 'CLS', value: 0 })] })!.vitals.map((item) => item.name)).toEqual(['CLS'])
  })

  it.each([
    ['no name', { name: undefined }],
    ['an empty name', { name: '' }],
    ['an oversized name', { name: 'N'.repeat(256) }],
    ['no message', { message: undefined }],
    ['a message that is not a string', { message: { toString: 'x' } }],
    ['an oversized message', { message: 'm'.repeat(4001) }],
    ['an oversized stack', { stack: 's'.repeat(16_001) }],
    ['a stack that is not a string', { stack: ['at a'] }],
    ['an oversized code', { code: 'c'.repeat(256) }],
    ['handled that is not a boolean', { handled: 'yes' }],
    ['an oversized route', { route: `/${'r'.repeat(255)}` }],
    ['no path', { path: undefined }],
    ['a path that is not a path', { path: 'deals/981' }],
  ])('drops an error with %s', (_name, change) => {
    expect(parse({ id: ID, errors: [error(change), error({ message: 'kept' })] })!.errors.map((item) => item.message)).toEqual(['kept'])
  })

  it('drops items that are not objects, and looks at no more than 10 of each per post', () => {
    const report = parse({ id: ID, errors: [null, 'x', 3, [error()], ...Array.from({ length: 20 }, (_, n) => error({ message: `e${n}` }))], vitals: Array.from({ length: 20 }, () => vital()) })!
    expect(report.errors.map((item) => item.message)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5'])
    expect(report.vitals).toHaveLength(10)
  })

  it('cuts the query string and fragment off paths and routes; an unusual navigation type becomes ""', () => {
    const report = parse({ id: ID, errors: [error({ path: '/a?token=1', route: '/a?token=1' })], vitals: [vital({ path: '/b#frag', nav: 'Weird Type!' })] })!
    expect(report.errors[0]).toMatchObject({ path: '/a', route: '/a' })
    expect(report.vitals[0]).toMatchObject({ path: '/b', navigationType: '' })
  })
})

describe('limits', () => {
  it('RateLimiter: fixed window per client', () => {
    const limiter = new RateLimiter(3)
    const t0 = 1_000_000
    expect([limiter.allow('a', t0), limiter.allow('a', t0 + 1), limiter.allow('a', t0 + 2), limiter.allow('a', t0 + 3)]).toEqual([true, true, true, false])
    expect(limiter.allow('b', t0 + 3)).toBe(true)
    expect(limiter.allow('a', t0 + 59_999)).toBe(false)
    expect(limiter.allow('a', t0 + 60_000)).toBe(true)
    expect(new RateLimiter(0).allow('a')).toBe(false)
  })

  it('RateLimiter: the map of clients is bounded', () => {
    const limiter = new RateLimiter(60, 100)
    for (let n = 0; n < 1000; n++) limiter.allow(`client-${n}`, 1_000_000 + n)
    expect(limiter.size).toBe(100)
    // finished windows go first
    for (let n = 0; n < 50; n++) limiter.allow(`later-${n}`, 2_000_000 + n)
    expect(limiter.size).toBe(50)
    // a client that was pushed out starts a new window
    expect(limiter.allow('client-0', 2_000_100)).toBe(true)
  })

  it.each([
    [{ origin: 'https://a.test', host: 'a.test' }, true],
    [{ origin: 'https://A.test', host: 'a.TEST' }, true],
    [{ origin: 'http://localhost:3000', host: 'localhost:3000' }, true],
    [{ origin: 'http://localhost:3000', host: 'localhost:3001' }, false],
    [{ origin: 'https://b.test', host: 'a.test' }, false],
    [{ origin: 'https://a.test.evil.example', host: 'a.test' }, false],
    [{ origin: 'not a url', host: 'a.test' }, false],
    [{ host: 'a.test' }, false],
    [{}, false],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'none', origin: 'https://a.test', host: 'a.test' }, false],
    [{ origin: 'https://a.test', host: 'internal', 'x-forwarded-host': 'a.test, proxy' }, true],
  ])('isSameOrigin(%j) → %s', (headers, expected) => {
    expect(isSameOrigin(new Headers(headers as Record<string, string>))).toBe(expected)
  })

  it('readBody: text up to the cap, null beyond it', async () => {
    const request = (body: string) => new Request('http://a.test/', { method: 'POST', body })
    expect(await readBody(request('héllo'), 64)).toBe('héllo')
    expect(await readBody(request('x'.repeat(64)), 64)).toBe('x'.repeat(64))
    expect(await readBody(request('x'.repeat(65)), 64)).toBeNull()
    expect(await readBody(new Request('http://a.test/', { method: 'POST' }), 64)).toBe('')
  })
})

describe('parseUserAgent', () => {
  it.each([
    ['Chrome on macOS', CHROME, 'desktop', 'Chrome 141'],
    ['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'desktop', 'Chrome 140'],
    ['Chrome on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36', 'desktop', 'Chrome 139'],
    ['headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36', 'desktop', 'Chrome 153'],
    ['Chrome on Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'mobile', 'Chrome 141'],
    ['Chrome on Android tablet', 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'tablet', 'Chrome 141'],
    ['Chrome on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.26 Mobile/15E148 Safari/604.1', 'mobile', 'Chrome 141'],
    ['Safari on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'desktop', 'Safari 18'],
    ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'mobile', 'Safari 17'],
    ['Safari on iPad', 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'tablet', 'Safari 16'],
    ['Firefox on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0', 'desktop', 'Firefox 143'],
    ['Firefox on Android', 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0', 'mobile', 'Firefox 143'],
    ['Firefox on Android tablet', 'Mozilla/5.0 (Android 14; Tablet; rv:143.0) Gecko/143.0 Firefox/143.0', 'tablet', 'Firefox 143'],
    ['Firefox on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15', 'mobile', 'Firefox 143'],
    ['Edge on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'desktop', 'Edge 141'],
    ['Edge on Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0', 'mobile', 'Edge 141'],
    ['Opera', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/123.0.0.0', 'desktop', 'Opera 123'],
    ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36', 'mobile', 'Samsung Internet 27'],
    ['Kindle Fire (Silk)', 'Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/128.3.1 like Chrome/128.0.6613.187 Safari/537.36', 'tablet', 'Chrome 128'],
    ['curl', 'curl/8.9.1', 'desktop', ''],
    ['a bot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'desktop', ''],
    ['an empty header', '', 'desktop', ''],
  ])('%s', (_name, header, device, browser) => {
    expect(parseUserAgent(header)).toEqual({ device, browser })
  })

  it.each([[null], [undefined], [42], [{}]])('tolerates a missing header (%s)', (header) => {
    expect(parseUserAgent(header)).toEqual({ device: 'desktop', browser: '' })
  })

  it('does not choke on a huge header', () => {
    expect(parseUserAgent(`${'A'.repeat(1_000_000)} Chrome/141.0`)).toEqual({ device: 'desktop', browser: '' })
  })
})
