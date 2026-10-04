// Browser side of the tunnel: one page-load id, a small queue, and a beacon. No imports — this file ships to visitors.

/** What the browser sends about one error. The tunnel builds the `exception` record from it. */
export interface ErrorItem {
  name: string
  message: string
  stack: string
  handled: boolean
  /** `error.code ?? error.digest ?? ""`. */
  code: string
  /** Route pattern (`/deals/[id]`), or the concrete pathname when the pattern is unknown. */
  route: string
  /** Concrete pathname, never a query string. */
  path: string
}

/** What the browser sends about one web vital. */
export interface VitalItem {
  name: string
  value: number
  rating: string
  nav: string
  route: string
  path: string
}

export const DEFAULT_ENDPOINT = '/api/doxa-watch'
/** Queued errors are sent this long after the first one, so a burst travels together. */
export const ERROR_FLUSH_MS = 1000
/** Early vitals (TTFB, FCP) are not held until the page is hidden: a mobile browser may never fire that event. */
export const VITAL_FLUSH_MS = 5000
/** A batch stays well under the tunnel's 64 kB cap: stacks are cut to 6,000 characters and five errors go at once. */
const ERRORS_PER_BATCH = 5

interface Page {
  id: string
  endpoint: string
  /** Where the visitor is now (errors). */
  route: string
  path: string
  /** Where the document was loaded (web vitals are measured for the document load). */
  landingRoute: string
  landingPath: string
  errors: ErrorItem[]
  vitals: VitalItem[]
  timer: ReturnType<typeof setTimeout> | undefined
}

export const page: Page = {
  id: '',
  endpoint: DEFAULT_ENDPOINT,
  route: '',
  path: '',
  landingRoute: '',
  landingPath: '',
  errors: [],
  vitals: [],
  timer: undefined,
}

/** A UUID v4, generated once per document load and shared by everything this load reports. */
export function pageLoadId(): string {
  if (page.id === '') {
    page.id = '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => {
      const n = Number(c)
      let random = Math.random() * 256
      try {
        random = crypto.getRandomValues(new Uint8Array(1))[0] as number
      } catch {
        // no Web Crypto: Math.random is good enough for a correlation id
      }
      return (n ^ ((random & 15) >> (n / 4))).toString(16)
    })
  }
  return page.id
}

/**
 * The per-page-load sampling decision: a pure function of the page-load id, so the browser and the tunnel reach the
 * same answer for the same rate (the first 32 bits of a v4 UUID are uniformly random).
 */
export function isSampled(id: string, rate: number): boolean {
  return Number.parseInt(id.slice(0, 8), 16) / 4294967296 < rate
}

/** Sends what is queued: `sendBeacon` survives the page going away; `fetch` with `keepalive` is the fallback. */
export function flush(): void {
  try {
    clearTimeout(page.timer)
    page.timer = undefined
    if (page.errors.length + page.vitals.length === 0) return
    const body = JSON.stringify({ id: pageLoadId(), errors: page.errors, vitals: page.vitals })
    page.errors = []
    page.vitals = []
    let sent = false
    try {
      sent = navigator.sendBeacon(page.endpoint, body)
    } catch {
      // no sendBeacon, or it refused the URL
    }
    if (!sent) fetch(page.endpoint, { method: 'POST', body, keepalive: true }).catch(() => {})
  } catch {
    // reporting must never break the page
  }
}

function schedule(ms: number): void {
  if (document.visibilityState === 'hidden') flush()
  else if (page.timer === undefined) page.timer = setTimeout(flush, ms)
}

export function queueError(item: ErrorItem): void {
  page.errors.push(item)
  if (page.errors.length >= ERRORS_PER_BATCH) flush()
  else {
    // An error is worth sending soon, even when a slower vitals timer is already running.
    clearTimeout(page.timer)
    page.timer = undefined
    schedule(ERROR_FLUSH_MS)
  }
}

export function queueVital(item: VitalItem): void {
  page.vitals.push(item)
  schedule(VITAL_FLUSH_MS)
}

/** Test helper: a fresh document load. */
export function resetPage(): void {
  clearTimeout(page.timer)
  Object.assign(page, {
    id: '',
    endpoint: DEFAULT_ENDPOINT,
    route: '',
    path: '',
    landingRoute: '',
    landingPath: '',
    errors: [],
    vitals: [],
    timer: undefined,
  })
}
