import { TINY_TEXT, type WireRecord, group, now, truncate } from './common'

export const WEB_VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number]

export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const
export type WebVitalRating = (typeof WEB_VITAL_RATINGS)[number]

export type Device = 'desktop' | 'mobile' | 'tablet'

/** The standard thresholds (web.dev): up to the first is `good`, up to the second `needs-improvement`, beyond `poor`. */
export const WEB_VITAL_THRESHOLDS: Record<WebVitalName, readonly [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
}

export function isWebVitalName(value: unknown): value is WebVitalName {
  return (WEB_VITAL_NAMES as readonly unknown[]).includes(value)
}

export function rateWebVital(name: WebVitalName, value: number): WebVitalRating {
  const [good, poor] = WEB_VITAL_THRESHOLDS[name]
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor'
}

export interface WebVitalInput {
  deploy: string
  server: string
  /** The page-load id, shared with the browser exceptions of that load. */
  traceId: string
  user: string
  /** Route pattern, e.g. `/deals/[id]`. */
  routePath: string
  /** Concrete path; a query string or fragment is removed here. */
  path: string
  name: WebVitalName
  /** Milliseconds; unitless for CLS. */
  value: number
  /** Used when it is one of the three ratings; otherwise computed from the thresholds. */
  rating?: unknown
  navigationType?: string
  device: Device
  /** Name + major version, `""` when unknown. */
  browser: string
  timestamp?: number
}

/** PROTOCOL §9.5. No `execution_*` fields. */
export function buildWebVital(input: WebVitalInput): WireRecord {
  const routePath = truncate(input.routePath, TINY_TEXT)
  const rating = (WEB_VITAL_RATINGS as readonly unknown[]).includes(input.rating)
    ? (input.rating as WebVitalRating)
    : rateWebVital(input.name, input.value)

  return {
    v: 1,
    t: 'web-vital',
    timestamp: input.timestamp ?? now(),
    deploy: truncate(input.deploy, TINY_TEXT),
    server: truncate(input.server, TINY_TEXT),
    _group: group(routePath),
    trace_id: input.traceId,
    user: truncate(input.user, TINY_TEXT),
    route_path: routePath,
    path: truncate(input.path.replace(/[?#].*$/s, ''), 2048),
    name: input.name,
    value: input.value,
    rating,
    navigation_type: truncate(input.navigationType ?? '', 32),
    device: input.device,
    browser: truncate(input.browser, 64),
  }
}
