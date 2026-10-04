// The browser client's logic, against the handful of browser globals it touches (stubbed: no DOM library needed).
// The React component itself runs in a real browser in test/e2e/browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ERRORS, captureException, onError, onRejection, onVital, report, resetCapture, setVitalsSampleRate } from '../src/next/client/capture'
import { routePattern } from '../src/next/client/route'
import { ERROR_FLUSH_MS, VITAL_FLUSH_MS, flush, isSampled, page, pageLoadId, resetPage } from '../src/next/client/send'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface Sent {
  id: string
  errors: Record<string, unknown>[]
  vitals: Record<string, unknown>[]
}

let beacon: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>
let doc: { visibilityState: string }

const sent = (): Sent[] => beacon.mock.calls.map((call) => JSON.parse(call[1] as string) as Sent)
const errorAt = (message: string, frame = 'https://app.test/_next/static/chunks/a.js:1:100', name = 'Error') => ({ name, message, stack: `${name}: ${message}\n    at run (${frame})\n    at https://app.test/_next/static/chunks/b.js:2:3` })

beforeEach(() => {
  vi.useFakeTimers()
  resetPage()
  resetCapture()
  beacon = vi.fn(() => true)
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
  doc = { visibilityState: 'visible' }
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', doc)
  vi.stubGlobal('location', { pathname: '/deals/981' })
  vi.stubGlobal('navigator', { sendBeacon: beacon })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('page-load id', () => {
  it('is a v4 UUID, generated once per document load and shared by everything sent', () => {
    const id = pageLoadId()
    expect(id).toMatch(UUID)
    expect(pageLoadId()).toBe(id)
    report(errorAt('one'), false)
    flush()
    onVital({ name: 'TTFB', value: 12 })
    flush()
    expect(sent().map((body) => body.id)).toEqual([id, id])
    resetPage()
    expect(pageLoadId()).not.toBe(id)
  })

  it('still produces a UUID without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined)
    expect(pageLoadId()).toMatch(UUID)
  })
})

describe('errors', () => {
  it('sends name, message, stack, handled, code, route and path shortly after the error', () => {
    page.route = '/deals/[id]'
    page.path = '/deals/981'
    report(Object.assign(errorAt('boom', undefined, 'TypeError'), { digest: '12345' }), false)
    expect(beacon).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(beacon.mock.calls[0]![0]).toBe('/api/doxa-watch')
    const [body] = sent()
    expect(body!.vitals).toEqual([])
    expect(body!.errors).toEqual([{ name: 'TypeError', message: 'boom', stack: expect.stringContaining('at run ('), handled: false, code: '12345', route: '/deals/[id]', path: '/deals/981' }])
  })

  it('does not send the stand-in for a Server Component error that error.tsx receives: the server reported the real one', () => {
    const omitted =
      'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.'
    captureException(Object.assign(errorAt(omitted), { digest: '2375321282' }))
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(beacon).not.toHaveBeenCalled()

    // It does not use up the page load's allowance, and an own error with a digest is still sent.
    captureException(Object.assign(errorAt('render failed in the browser'), { digest: '99' }))
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(sent()[0]!.errors).toEqual([expect.objectContaining({ message: 'render failed in the browser', handled: true, code: '99' })])
  })

  it('falls back to the concrete pathname when the route is unknown, and never sends a query string', () => {
    vi.stubGlobal('location', { pathname: '/deals/981', search: '?token=secret', href: 'https://app.test/deals/981?token=secret' })
    captureException(errorAt('no route'))
    flush()
    expect(sent()[0]!.errors[0]).toMatchObject({ route: '/deals/981', path: '/deals/981', handled: true })
    expect(beacon.mock.calls[0]![1]).not.toContain('secret')
  })

  it('sends an identical error (name, message, top frame) once', () => {
    report(errorAt('same'), false)
    report(errorAt('same'), false)
    captureException(errorAt('same'))
    report(errorAt('same', 'https://app.test/_next/static/chunks/other.js:9:9'), false) // another place
    report(errorAt('same', undefined, 'RangeError'), false) // another class
    report(errorAt('different'), false)
    flush()
    expect(sent().flatMap((body) => body.errors).map((error) => [error.name, error.message])).toEqual([['Error', 'same'], ['Error', 'same'], ['RangeError', 'same'], ['Error', 'different']])
  })

  it(`sends at most ${MAX_ERRORS} errors per page load`, () => {
    for (let n = 0; n < 25; n++) report(errorAt(`error ${n}`), false)
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    const errors = sent().flatMap((body) => body.errors)
    expect(errors).toHaveLength(MAX_ERRORS)
    expect(errors.map((error) => error.message)).toEqual(Array.from({ length: 10 }, (_, n) => `error ${n}`))
    report(errorAt('one more'), false)
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(sent().flatMap((body) => body.errors)).toHaveLength(MAX_ERRORS)
  })

  it('batches: five errors go at once, and every body stays under the tunnel cap', () => {
    for (let n = 0; n < 7; n++) report({ name: 'Error', message: `m${n} ${'x'.repeat(5000)}`, stack: `Error\n    at f (https://app.test/a.js:${n}:1)\n${'y'.repeat(20_000)}` }, false)
    expect(beacon).toHaveBeenCalledTimes(1) // the first five, immediately
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(sent().map((body) => body.errors.length)).toEqual([5, 2])
    for (const call of beacon.mock.calls) expect((call[1] as string).length).toBeLessThan(64 * 1024)
    expect((sent()[0]!.errors[0]!.message as string).length).toBe(1000)
    expect((sent()[0]!.errors[0]!.stack as string).length).toBe(6000)
  })

  it.each([
    ['Script error.', { message: 'Script error.' }],
    ['Script error', { message: 'Script error' }],
    ['a Chrome extension', errorAt('ext', 'chrome-extension://abcdef/content.js:1:1')],
    ['a Firefox extension', { name: 'Error', message: 'ext', stack: 'run@moz-extension://abcdef/content.js:1:1' }],
    ['a Safari extension', errorAt('ext', 'safari-web-extension://abcdef/content.js:1:1')],
  ])('drops %s', (_name, error) => {
    report(error, false)
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(beacon).not.toHaveBeenCalled()
  })

  it('keeps an application error that merely passed through an extension further up the stack', () => {
    report({ name: 'Error', message: 'mine', stack: 'Error: mine\n    at run (https://app.test/a.js:1:1)\n    at wrapped (chrome-extension://abcdef/inject.js:1:1)' }, false)
    flush()
    expect(sent()[0]!.errors).toHaveLength(1)
  })

  it('global handlers: an error event, an event without an error object, a rejection, a thrown string', () => {
    onError({ error: errorAt('from event'), message: 'ignored' } as unknown as ErrorEvent)
    onError({ error: null, message: 'Uncaught oops', filename: 'https://app.test/a.js', lineno: 3, colno: 9 } as unknown as ErrorEvent)
    onError({ error: null, message: 'Script error.', filename: '', lineno: 0, colno: 0 } as unknown as ErrorEvent)
    onRejection({ reason: errorAt('rejected', undefined, 'AbortError') } as unknown as PromiseRejectionEvent)
    onRejection({ reason: 'just a string' } as unknown as PromiseRejectionEvent)
    flush()
    expect(sent()[0]!.errors.map((error) => [error.name, error.message, error.handled, error.stack])).toEqual([
      ['Error', 'from event', false, expect.stringContaining('at run')],
      ['Error', 'Uncaught oops', false, '    at https://app.test/a.js:3:9'],
      ['AbortError', 'rejected', false, expect.any(String)],
      ['Error', 'just a string', false, ''],
    ])
  })

  it('falls back to fetch with keepalive when sendBeacon is missing or refuses', () => {
    beacon.mockReturnValue(false)
    report(errorAt('one'), false)
    flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/doxa-watch', { method: 'POST', body: expect.stringContaining('"one"'), keepalive: true })

    vi.stubGlobal('navigator', {})
    report(errorAt('two'), false)
    flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never throws: odd values, a throwing transport, a rejected fetch', async () => {
    beacon.mockImplementation(() => {
      throw new Error('beacon blocked')
    })
    fetchMock.mockReturnValue(Promise.reject(new Error('offline')))
    const cyclic: Record<string, unknown> = { name: 'Odd' }
    cyclic.message = { toString: () => { throw new Error('no string') } }
    for (const value of [undefined, null, 0, Symbol('s'), cyclic, Object.create(null), new Proxy({}, { get: () => { throw new Error('trap') } })]) {
      expect(() => captureException(value)).not.toThrow()
    }
    expect(() => flush()).not.toThrow()
    await Promise.resolve()
  })

  it('does nothing during server rendering', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    expect(typeof window).toBe('undefined')
    expect(() => captureException(new Error('on the server'))).not.toThrow()
    expect(() => flush()).not.toThrow()
    expect(beacon).not.toHaveBeenCalled()
    expect(page.errors).toEqual([])
  })

  it('sends at once when the page is already hidden', () => {
    doc.visibilityState = 'hidden'
    report(errorAt('while hidden'), false)
    expect(beacon).toHaveBeenCalledTimes(1)
  })
})

describe('web vitals', () => {
  it('queues the five metrics once each, for the route the document was loaded on, and flushes after a while', () => {
    page.landingRoute = '/deals/[id]'
    page.landingPath = '/deals/981'
    page.route = '/settings' // the visitor navigated on
    page.path = '/settings'
    onVital({ name: 'TTFB', value: 80.5, rating: 'good', navigationType: 'navigate' })
    onVital({ name: 'FCP', value: 400, rating: 'good', navigationType: 'navigate' })
    onVital({ name: 'TTFB', value: 999, rating: 'poor', navigationType: 'navigate' }) // reported again: ignored
    onVital({ name: 'FID', value: 3 }) // not one of ours
    onVital({ name: 'Next.js-hydration', value: 30 })
    onVital({ name: 'LCP', value: Number.NaN })
    expect(beacon).not.toHaveBeenCalled()
    vi.advanceTimersByTime(VITAL_FLUSH_MS)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]!.errors).toEqual([])
    expect(sent()[0]!.vitals).toEqual([
      { name: 'TTFB', value: 80.5, rating: 'good', nav: 'navigate', route: '/deals/[id]', path: '/deals/981' },
      { name: 'FCP', value: 400, rating: 'good', nav: 'navigate', route: '/deals/[id]', path: '/deals/981' },
    ])
  })

  it('a metric reported while the page is being hidden goes out immediately, with what was queued', () => {
    onVital({ name: 'FCP', value: 400 })
    doc.visibilityState = 'hidden'
    onVital({ name: 'CLS', value: 0.02 })
    expect(sent().map((body) => body.vitals.map((vital) => vital.name))).toEqual([['FCP', 'CLS']])
  })

  it('an error does not wait for the slower vitals timer, and takes the queued vitals along', () => {
    onVital({ name: 'TTFB', value: 80 })
    report(errorAt('boom'), false)
    vi.advanceTimersByTime(ERROR_FLUSH_MS)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({ errors: [{ message: 'boom' }], vitals: [{ name: 'TTFB' }] })
  })

  it('the sampling decision is one per page load, the same function of the page-load id the tunnel uses', () => {
    expect(isSampled('00000000-0000-4000-8000-000000000000', 0.01)).toBe(true)
    expect(isSampled('7fffffff-0000-4000-8000-000000000000', 0.5)).toBe(true)
    expect(isSampled('80000000-0000-4000-8000-000000000000', 0.5)).toBe(false)
    expect(isSampled('ffffffff-0000-4000-8000-000000000000', 1)).toBe(true)
    expect(isSampled('00000000-0000-4000-8000-000000000000', 0)).toBe(false)

    page.id = 'c0000000-0000-4000-8000-000000000000' // 0.75
    setVitalsSampleRate(0.5)
    onVital({ name: 'TTFB', value: 80 })
    onVital({ name: 'LCP', value: 900 })
    report(errorAt('errors are not sampled here'), false)
    vi.advanceTimersByTime(VITAL_FLUSH_MS)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({ vitals: [], errors: [{ message: 'errors are not sampled here' }] })

    resetCapture()
    setVitalsSampleRate(0.8)
    onVital({ name: 'TTFB', value: 80 })
    flush()
    expect(sent()[1]!.vitals).toHaveLength(1)
  })

  it.each([[undefined], [Number.NaN], [-1], [2], ['0.5' as unknown as number]])('an invalid rate (%s) means every page load', (rate) => {
    page.id = 'ffffffff-0000-4000-8000-000000000000'
    setVitalsSampleRate(rate)
    onVital({ name: 'TTFB', value: 80 })
    flush()
    expect(sent()[0]!.vitals).toHaveLength(1)
  })
})

describe('routePattern', () => {
  it.each([
    ['/deals/981', { id: '981' }, '/deals/[id]'],
    ['/', {}, '/'],
    ['/about', {}, '/about'],
    ['/about', null, '/about'],
    ['/teams/acme/deals/981', { team: 'acme', id: '981' }, '/teams/[team]/deals/[id]'],
    ['/docs/guides/setup/next', { slug: ['guides', 'setup', 'next'] }, '/docs/[...slug]'],
    ['/shop/shoes/red/42', { category: 'shoes', rest: ['red', '42'] }, '/shop/[category]/[...rest]'],
    ['/docs', { slug: undefined }, '/docs'],
    ['/docs', { slug: [] }, '/docs'],
    ['/tags/caf%C3%A9', { tag: 'café' }, '/tags/[tag]'],
    ['/tags/caf%C3%A9', { tag: 'caf%C3%A9' }, '/tags/[tag]'],
    ['/files/a%20b/c', { path: ['a b', 'c'] }, '/files/[...path]'],
    ['/deals/981/edit', { id: '981' }, '/deals/[id]/edit'],
    ['/deals/981', { other: 'nope' }, '/deals/981'],
    ['/9/9', { a: '9', b: '9' }, '/[a]/[b]'],
  ])('%s with %j → %s', (pathname, params, expected) => {
    expect(routePattern(pathname, params as never)).toBe(expected)
  })

  it('has no pattern without a pathname (the caller falls back to the location)', () => {
    expect(routePattern(null, { id: '1' })).toBe('')
    expect(routePattern(undefined, null)).toBe('')
  })

  it('documented limit: a value equal to an earlier static segment replaces that segment', () => {
    expect(routePattern('/deals/deals', { id: 'deals' })).toBe('/[id]/deals')
  })
})
