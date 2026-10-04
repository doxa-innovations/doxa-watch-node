import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeServer, type WireRecord } from '../helpers/fake-server'
import { FIXTURES, type Fixture, type RunningApp, nextVersion, standaloneDir, startApp } from './harness'

const selected = FIXTURES.filter((fixture) => process.env.E2E_FIXTURE === undefined || process.env.E2E_FIXTURE === fixture)

interface Frame {
  file: string
  source: string
  code: Record<string, string> | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

let browser: Browser

beforeAll(async () => {
  // Needs the browser once: `npx playwright install chromium`.
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

describe.each(selected)('%s: the browser reports through the tunnel', (fixture: Fixture) => {
  let watch: FakeServer
  let app: RunningApp
  let context: BrowserContext
  let page: Page
  const dir = standaloneDir(fixture)

  beforeAll(async () => {
    watch = await new FakeServer().start()
    app = await startApp(fixture, { DOXA_WATCH_TOKEN: 'fixture-token', DOXA_WATCH_BASE_URL: watch.url, DOXA_WATCH_SERVER: 'fixture-web', UPSTREAM_URL: watch.url })
    context = await browser.newContext()
    await context.addCookies([{ name: 'fixture_user', value: '7', url: app.url }])
    page = await context.newPage()
  })
  afterAll(async () => {
    await context?.close()
    await app?.stop()
    await watch?.stop()
  })

  async function exceptionWith(message: string): Promise<WireRecord> {
    const find = () => watch.of('exception').find((record) => record.message === message)
    await watch.waitFor(() => find() !== undefined, 12_000, `the exception "${message}"`)
    return find() as WireRecord
  }

  it('the image has the tunnel and the moved maps, and no map or map comment is left in the public folder', () => {
    expect(existsSync(join(dir, 'node_modules/doxa-watch/dist/next/tunnel/index.js')) || existsSync(join(dir, 'node_modules/doxa-watch/dist/next/tunnel/index.cjs'))).toBe(true)
    const maps = filesUnder(join(dir, '.next/doxa-watch/maps'))
    expect(maps.length).toBeGreaterThan(3)
    expect(maps.every((path) => path.endsWith('.map'))).toBe(true)
    const assets = filesUnder(join(dir, '.next/static'))
    expect(assets.length).toBeGreaterThan(3)
    expect(assets.filter((path) => path.endsWith('.map'))).toEqual([])
    expect(assets.filter((path) => /\.(js|css)$/.test(path) && readFileSync(path, 'utf8').includes('sourceMappingURL='))).toEqual([])
  })

  it('an error thrown in an event handler: a browser exception with the original file, line and code', async () => {
    await page.goto(`${app.url}/browser/click`)
    await page.click('#throw')
    const exception = await exceptionWith('button exploded')
    const version = (await browser.version()).split('.')[0]
    expect(exception).toMatchObject({
      v: 3,
      class: 'RangeError',
      handled: false,
      file: 'app/browser/click/page.tsx',
      line: 4,
      code: '',
      deploy: readFileSync(join(dir, '.next/BUILD_ID'), 'utf8').trim(),
      server: 'fixture-web',
      execution_source: 'browser',
      execution_preview: 'PAGE /browser/click',
      execution_stage: 'action',
      php_version: '',
      laravel_version: '',
      runtime: 'browser',
      runtime_version: `Chrome ${version}`,
      framework: 'next',
      framework_version: nextVersion(fixture),
    })
    expect(exception.trace_id).toMatch(UUID)
    expect(exception.execution_id).toBe(exception.trace_id)
    expect(exception._group).toMatch(/^[0-9a-f]{32}$/)
    const trace = JSON.parse(exception.trace as string) as Frame[]
    expect(trace[0]).toMatchObject({ file: 'app/browser/click/page.tsx:4', source: '' })
    expect(trace[0]!.code!['4']).toContain("throw new RangeError('button exploded')")
    expect(Object.keys(trace[0]!.code!)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    // The rest of the stack is React's event dispatch: kept, resolved to node_modules where a map covers it.
    expect(trace.length).toBeGreaterThan(2)
    expect(trace.every((frame) => typeof frame.file === 'string' && frame.file !== '' && typeof frame.source === 'string')).toBe(true)
    expect(Object.values(exception).every((value) => value !== null)).toBe(true)
  })

  it('an error thrown while rendering arrives through the error boundary, once', async () => {
    await page.goto(`${app.url}/browser/render`)
    await page.click('#break')
    await page.waitForSelector('#error-boundary')
    const exception = await exceptionWith('render exploded')
    expect(exception).toMatchObject({ class: 'TypeError', handled: true, file: 'app/browser/render/page.tsx', line: 6, runtime: 'browser', execution_source: 'browser', execution_preview: 'PAGE /browser/render' })
    const trace = JSON.parse(exception.trace as string) as Frame[]
    expect(trace[0]!.file).toBe('app/browser/render/page.tsx:6')
    expect(trace[0]!.code!['6']).toContain("throw new TypeError('render exploded')")
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(watch.of('exception').filter((record) => record.message === 'render exploded')).toHaveLength(1)
  })

  it('captureException on a dynamic route: the route pattern, no query string, and the user of the tunnel request', async () => {
    await page.goto(`${app.url}/browser/items/7?secret=abc`)
    await page.click('#report')
    const exception = await exceptionWith('item rejected')
    expect(exception).toMatchObject({ class: 'SyntaxError', handled: true, file: 'app/browser/items/[id]/page.tsx', line: 7, execution_preview: 'PAGE /browser/items/[id]' })
    // The server's own `request` record keeps its URL; nothing the browser reported carries the query string.
    expect(JSON.stringify(watch.records.filter((record) => record.t !== 'request'))).not.toContain('secret')
    // Reporting the same error object again, and an identical one from the same place, sends nothing more.
    await page.click('#report')
    await page.click('#report')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(watch.of('exception').filter((record) => record.message === 'item rejected')).toHaveLength(1)

    if (fixture === 'next16') {
      // This fixture's tunnel resolves the user from a cookie.
      expect(exception.user).toBe('7')
      await watch.waitFor(() => watch.of('user').some((record) => record.id === '7'), 12_000, 'the user record')
      expect(watch.of('user').find((record) => record.id === '7')).toMatchObject({ v: 1, name: 'Grace Hopper', username: 'grace@example.com' })
    } else {
      expect(exception.user).toBe('')
    }
  })

  it('web vitals arrive after a navigation and a page hide, with the page-load id of that document', async () => {
    const fresh = await context.newPage()
    await fresh.goto(`${app.url}/deals/981?tab=notes`)
    await fresh.click('h1')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await fresh.goto('about:blank') // pagehide + hidden
    const mine = () => watch.of('web-vital').filter((record) => record.path === '/deals/981')
    const names = () => mine().map((record) => record.name)
    await watch.waitFor(() => ['TTFB', 'FCP', 'LCP', 'CLS'].every((name) => names().includes(name)), 15_000, 'TTFB, FCP, LCP and CLS')
    await fresh.close()

    const vitals = mine()
    expect(new Set(vitals.map((record) => record.trace_id)).size).toBe(1)
    expect(vitals[0]!.trace_id).toMatch(UUID)
    expect(new Set(names()).size).toBe(vitals.length) // each metric once per page load
    const version = (await browser.version()).split('.')[0]
    for (const vital of vitals) {
      expect(Object.keys(vital)).toEqual(['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'user', 'route_path', 'path', 'name', 'value', 'rating', 'navigation_type', 'device', 'browser'])
      expect(vital).toMatchObject({
        v: 1,
        server: 'fixture-web',
        _group: createHash('md5').update('/deals/[id]').digest('hex'),
        route_path: '/deals/[id]',
        path: '/deals/981',
        navigation_type: 'navigate',
        device: 'desktop',
        browser: `Chrome ${version}`,
        user: fixture === 'next16' ? '7' : '',
      })
      expect(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']).toContain(vital.name)
      expect(['good', 'needs-improvement', 'poor']).toContain(vital.rating)
      expect(Number.isFinite(vital.value) && (vital.value as number) >= 0).toBe(true)
      expect(vital.timestamp).toBeGreaterThan(Date.now() / 1000 - 60)
    }
    expect((vitals.find((record) => record.name === 'TTFB')!.value as number)).toBeGreaterThan(0)
  })

  it('no source map is publicly reachable under /_next/static', async () => {
    await page.goto(`${app.url}/browser/click`)
    const scripts = await page.evaluate(() => Array.from(document.scripts, (script) => script.src).filter((src) => src.includes('/_next/static/')))
    expect(scripts.length).toBeGreaterThan(0)
    for (const src of scripts) {
      expect((await fetch(src)).status, src).toBe(200)
      expect((await fetch(`${src.replace(/\?.*$/, '')}.map`)).status, `${src}.map`).toBe(404)
    }
    const maps = join(dir, '.next/doxa-watch/maps')
    for (const map of filesUnder(maps)) {
      const url = `${app.url}/_next/static/${relative(maps, map).split('\\').join('/')}`
      expect((await fetch(url)).status, url).toBe(404)
    }
    expect((await fetch(`${app.url}/_next/doxa-watch/maps/${relative(maps, filesUnder(maps)[0]!)}`)).status).toBe(404)
  })

  it('cross-origin, oversized and malformed posts are answered 204 and forward nothing', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const body = (message: string, padding = '') => JSON.stringify({ id, errors: [{ name: 'Error', message, stack: padding, handled: true, route: '/probe', path: '/probe' }] })
    const post = (payload: string, headers: Record<string, string>) => fetch(`${app.url}/api/doxa-watch`, { method: 'POST', body: payload, headers })
    const sameOrigin = { origin: app.url }

    const answers = [
      await post(body('cross-origin'), { origin: 'https://evil.example' }),
      await post(body('cross-site fetch'), { origin: app.url, 'sec-fetch-site': 'cross-site' }),
      await post(body('no origin'), {}),
      await post(body('oversized', 'x'.repeat(70_000)), sameOrigin),
      await post('{"id":', sameOrigin),
      await post(JSON.stringify({ id: 'not-a-uuid', errors: [{ name: 'Error', message: 'bad id', path: '/probe' }] }), sameOrigin),
      await post(JSON.stringify({ id, vitals: [{ name: 'XYZ', value: 1, path: '/probe' }, { name: 'LCP', value: null, path: '/probe' }] }), sameOrigin),
      await post(body('accepted'), sameOrigin),
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(204)
      expect(await answer.text()).toBe('')
    }

    await exceptionWith('accepted')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const probes = watch.records.filter((record) => record.trace_id === id || record.path === '/probe')
    expect(probes.map((record) => record.message)).toEqual(['accepted'])
    expect(probes[0]).toMatchObject({ runtime: 'browser', execution_preview: 'PAGE /probe', handled: true })
  })

  it('the tunnel is not recorded as a request', async () => {
    await fetch(`${app.url}/`)
    await watch.waitFor(() => watch.of('request').some((record) => record.url === `${app.url}/`), 12_000, 'a request record')
    expect(watch.of('request').some((record) => String(record.url).includes('/api/doxa-watch'))).toBe(false)
  })
})

describe.each(selected)('%s: no token', (fixture: Fixture) => {
  it('the page works, the client posts, and the tunnel answers 204 without contacting anybody', async () => {
    const watch = await new FakeServer().start()
    const app = await startApp(fixture, { DOXA_WATCH_BASE_URL: watch.url, UPSTREAM_URL: watch.url })
    const page = await browser.newPage()
    try {
      const posts: number[] = []
      page.on('response', (response) => {
        if (response.url().endsWith('/api/doxa-watch')) posts.push(response.status())
      })
      await page.goto(`${app.url}/browser/click`)
      await page.click('#throw')
      await expect.poll(() => posts, { timeout: 10_000 }).toEqual([204])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(watch.auths).toHaveLength(0)
      expect(watch.ingests).toHaveLength(0)
    } finally {
      await page.close()
      await app.stop()
      await watch.stop()
    }
  })
})
