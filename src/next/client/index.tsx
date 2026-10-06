// doxa-watch/next/client — the browser entry point. It ships to visitors: no dependencies, no token, and nothing
// here may import Node modules or the core entry point.
//
//   // app/doxa-watch.tsx — a client file of the app, because `withDoxaWatch` keeps this package out of the server
//   // bundle and a server component can only hand a client component to the browser through the app's own bundle
//   'use client'
//   export { DoxaWatchClient } from '@doxa-innovations/watch/next/client'
//
//   // app/layout.tsx
//   <DoxaWatchClient />
//
//   // app/error.tsx, app/global-error.tsx
//   useEffect(() => captureException(error), [error])
//
// The `.js` suffix on the two Next imports is deliberate: this package is an ES module, and Next has no export map,
// so a bundler resolving strictly needs the file name.
import { useParams, usePathname } from 'next/navigation.js'
import { useReportWebVitals } from 'next/web-vitals.js'
import { useEffect } from 'react'
import { onError, onRejection, onVital, setVitalsSampleRate } from './capture'
import { routePattern } from './route'
import { DEFAULT_ENDPOINT, flush, page } from './send'

export { captureException } from './capture'

export interface DoxaWatchClientProps {
  /** The tunnel route this page reports to. Default `/api/doxa-watch`; must be same-origin. */
  endpoint?: string
  /**
   * Share of page loads (0–1) whose web vitals are sent at all. Optional: the tunnel applies
   * `DOXA_WATCH_VITALS_SAMPLE_RATE` to what arrives, with the same per-page-load decision, so passing the rate here
   * only saves the unsampled visitors the request.
   */
  vitalsSampleRate?: number
}

let listening = false

function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  // The last moments a page can still send: hidden (tab switch, app switch on mobile) and pagehide (navigation away).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
}

/**
 * Put it once in the root layout. Reports uncaught errors, unhandled promise rejections and web vitals (LCP, INP, CLS,
 * FCP, TTFB) of the visitor's browser to the same-origin tunnel route. Renders nothing and never throws.
 */
export function DoxaWatchClient({ endpoint, vitalsSampleRate }: DoxaWatchClientProps): null {
  // On the server there is nothing to do, and no hook may run: `withDoxaWatch` keeps this package out of the server
  // bundle, so during server rendering this file is loaded by Node itself and sees a different copy of React than
  // the one rendering the page. The branch is fixed per environment, so the hook order never changes.
  if (typeof window === 'undefined') return null

  const pathname = usePathname()
  const params = useParams()

  // Assigned while rendering, not in an effect: an error thrown by the page being rendered now must already carry
  // this route. The assignments are idempotent.
  page.endpoint = endpoint || DEFAULT_ENDPOINT
  page.path = pathname || location.pathname
  page.route = routePattern(pathname, params) || page.path
  if (page.landingPath === '') {
    page.landingPath = page.path
    page.landingRoute = page.route
  }
  setVitalsSampleRate(vitalsSampleRate)

  useReportWebVitals(onVital)

  useEffect(() => {
    try {
      listen()
    } catch {
      // reporting must never break the page
    }
  }, [])

  return null
}
