import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WEB_VITAL_THRESHOLDS, type WebVitalInput, buildWebVital, isWebVitalName, rateWebVital } from '../src/records/web-vital'

const input: WebVitalInput = {
  deploy: 'a1b2c3d',
  server: 'crm-web-0',
  traceId: '6f1c0f0e-3b7a-4f0e-9d51-0c2a4b7a9e11',
  user: '42',
  routePath: '/deals/[id]',
  path: '/deals/981',
  name: 'LCP',
  value: 1834.5,
  rating: 'good',
  navigationType: 'navigate',
  device: 'desktop',
  browser: 'Chrome 141',
  timestamp: 1759570000.123456,
}

describe('buildWebVital', () => {
  it('is the PROTOCOL §9.5 example, key for key', () => {
    const record = buildWebVital(input)
    expect(record).toEqual({
      v: 1,
      t: 'web-vital',
      timestamp: 1759570000.123456,
      deploy: 'a1b2c3d',
      server: 'crm-web-0',
      _group: createHash('md5').update('/deals/[id]').digest('hex'),
      trace_id: '6f1c0f0e-3b7a-4f0e-9d51-0c2a4b7a9e11',
      user: '42',
      route_path: '/deals/[id]',
      path: '/deals/981',
      name: 'LCP',
      value: 1834.5,
      rating: 'good',
      navigation_type: 'navigate',
      device: 'desktop',
      browser: 'Chrome 141',
    })
    expect(Object.keys(record)).toEqual(['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'user', 'route_path', 'path', 'name', 'value', 'rating', 'navigation_type', 'device', 'browser'])
    expect(Object.keys(record).some((key) => key.startsWith('execution_'))).toBe(false)
  })

  it('never sends null: absent values are empty strings, and the timestamp defaults to now', () => {
    const record = buildWebVital({ ...input, user: '', navigationType: undefined, browser: '', rating: undefined, timestamp: undefined })
    expect(record).toMatchObject({ user: '', navigation_type: '', browser: '', rating: 'good' })
    expect(record.timestamp).toBeGreaterThan(Date.now() / 1000 - 5)
    expect(Object.values(record).every((value) => value !== null && value !== undefined)).toBe(true)
  })

  it.each([
    ['/deals/981?tab=notes', '/deals/981'],
    ['/deals/981#top', '/deals/981'],
    ['/search?q=a?b#c', '/search'],
    ['/plain', '/plain'],
  ])('removes the query string and fragment from the path: %s', (path, expected) => {
    expect(buildWebVital({ ...input, path }).path).toBe(expected)
  })

  it('limits the strings by bytes', () => {
    const record = buildWebVital({ ...input, routePath: `/${'r'.repeat(400)}`, path: `/${'p'.repeat(5000)}`, navigationType: 'n'.repeat(100), browser: 'b'.repeat(100) })
    expect((record.route_path as string).length).toBe(255)
    expect((record.path as string).length).toBe(2048)
    expect((record.navigation_type as string).length).toBe(32)
    expect((record.browser as string).length).toBe(64)
    // the group is the hash of what is sent
    expect(record._group).toBe(createHash('md5').update(record.route_path as string).digest('hex'))
  })

  it.each([['good'], ['needs-improvement'], ['poor']])('keeps the client rating "%s"', (rating) => {
    expect(buildWebVital({ ...input, value: 99_999, rating }).rating).toBe(rating)
  })

  it.each([['great'], [''], [undefined], [null], [3], ['GOOD']])('recomputes a rating that is not one of the three (%s)', (rating) => {
    expect(buildWebVital({ ...input, value: 5000, rating }).rating).toBe('poor')
    expect(buildWebVital({ ...input, value: 3000, rating }).rating).toBe('needs-improvement')
    expect(buildWebVital({ ...input, value: 100, rating }).rating).toBe('good')
  })
})

describe('rateWebVital — the standard thresholds', () => {
  it.each([
    ['LCP', 2500, 'good'], ['LCP', 2500.1, 'needs-improvement'], ['LCP', 4000, 'needs-improvement'], ['LCP', 4000.1, 'poor'],
    ['INP', 200, 'good'], ['INP', 201, 'needs-improvement'], ['INP', 500, 'needs-improvement'], ['INP', 501, 'poor'],
    ['CLS', 0, 'good'], ['CLS', 0.1, 'good'], ['CLS', 0.11, 'needs-improvement'], ['CLS', 0.25, 'needs-improvement'], ['CLS', 0.26, 'poor'],
    ['FCP', 1800, 'good'], ['FCP', 1801, 'needs-improvement'], ['FCP', 3000, 'needs-improvement'], ['FCP', 3001, 'poor'],
    ['TTFB', 800, 'good'], ['TTFB', 801, 'needs-improvement'], ['TTFB', 1800, 'needs-improvement'], ['TTFB', 1801, 'poor'],
  ] as const)('%s %d → %s', (name, value, rating) => {
    expect(rateWebVital(name, value)).toBe(rating)
  })

  it('knows exactly the five names', () => {
    expect(Object.keys(WEB_VITAL_THRESHOLDS).sort()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB'])
    expect(['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].every(isWebVitalName)).toBe(true)
    expect(['FID', 'lcp', '', null, 1, undefined].some(isWebVitalName)).toBe(false)
  })
})
