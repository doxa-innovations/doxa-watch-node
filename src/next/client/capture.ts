import { isSampled, page, pageLoadId, queueError, queueVital } from './send'

/** Spec §5: at most 10 errors per page load. */
export const MAX_ERRORS = 10
const MAX_MESSAGE = 1000
const MAX_STACK = 6000

const VITALS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB']
const EXTENSION = /(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//

interface Capture {
  /** `name \n message \n top frame` of every error already sent. */
  seen: Set<string>
  count: number
  /** Vital names already reported for this page load. */
  vitals: Set<string>
  /** Share of page loads whose vitals are sent (0–1). */
  rate: number
}

const state: Capture = { seen: new Set(), count: 0, vitals: new Set(), rate: 1 }

export function setVitalsSampleRate(rate: number | undefined): void {
  state.rate = typeof rate === 'number' && rate >= 0 && rate <= 1 ? rate : 1
}

function text(value: unknown, limit: number): string {
  return (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).slice(0, limit)
}

/** The first line of a stack that is a frame (V8 `at …`, Firefox/Safari `fn@url:line:col`). */
function topFrame(stack: string): string {
  return stack.split('\n').find((line) => /^\s*at |@.*:\d+/.test(line)) ?? ''
}

function pathname(): string {
  return page.path || location.pathname
}

/**
 * Queues one error for the tunnel. Dropped: everything after the 10th error of this page load, an error already sent
 * (same name, message and top frame), `Script error.` (a cross-origin script: there is nothing to report), and errors
 * thrown from a browser extension's code. Never throws.
 */
export function report(error: unknown, handled: boolean): void {
  try {
    if (typeof window === 'undefined' || state.count >= MAX_ERRORS) return
    const subject = (error !== null && typeof error === 'object' ? error : { message: error }) as Record<string, unknown>
    const name = text(subject.name || 'Error', 255)
    const message = text(subject.message, MAX_MESSAGE)
    const stack = text(typeof subject.stack === 'string' ? subject.stack : '', MAX_STACK)
    const top = topFrame(stack)

    if (/^Script error\.?$/i.test(message) || EXTENSION.test(top)) return
    const key = `${name}\n${message}\n${top}`
    if (state.seen.has(key)) return
    state.seen.add(key)
    state.count++

    const path = pathname()
    queueError({
      name,
      message,
      stack,
      handled,
      code: text(subject.code ?? subject.digest, 255),
      route: page.route || path,
      path,
    })
  } catch {
    // reporting must never break the page
  }
}

/**
 * Reports a handled error from the browser — call it from `app/error.tsx` and `app/global-error.tsx`:
 * `useEffect(() => captureException(error), [error])`. Does nothing during server rendering and never throws.
 */
export function captureException(error: unknown): void {
  report(error, true)
}

export function onError(event: ErrorEvent): void {
  try {
    // No error object: a cross-origin script, or a browser that only gives the location.
    const location = event.filename ? `    at ${event.filename}:${event.lineno}:${event.colno}` : ''
    report(event.error ?? { name: 'Error', message: event.message, stack: location }, false)
  } catch {
    // ignore
  }
}

export function onRejection(event: PromiseRejectionEvent): void {
  try {
    report(event.reason, false)
  } catch {
    // ignore
  }
}

/** What Next's `useReportWebVitals` passes (the `web-vitals` library's metric). */
export interface Metric {
  name: string
  value: number
  rating?: string
  navigationType?: string
}

/**
 * Queues LCP, INP, CLS, FCP and TTFB — each once per page load (the first final value), attributed to the route the
 * document was loaded on — when this page load is sampled. Must keep one identity: Next re-subscribes when it changes.
 */
export function onVital(metric: Metric): void {
  try {
    if (!VITALS.includes(metric.name) || state.vitals.has(metric.name) || !Number.isFinite(metric.value)) return
    state.vitals.add(metric.name)
    if (!isSampled(pageLoadId(), state.rate)) return
    const path = page.landingPath || pathname()
    queueVital({
      name: metric.name,
      value: metric.value,
      rating: text(metric.rating, 32),
      nav: text(metric.navigationType, 32),
      route: page.landingRoute || path,
      path,
    })
  } catch {
    // ignore
  }
}

/** Test helper: a fresh document load. */
export function resetCapture(): void {
  state.seen.clear()
  state.vitals.clear()
  state.count = 0
  state.rate = 1
}
