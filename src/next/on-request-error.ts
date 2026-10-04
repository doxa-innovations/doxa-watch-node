import { captureError } from '../capture'
import { debug } from '../debug'
import { currentExecution } from '../execution'
import { requestState } from '../sensors/http'

/** What Next passes to `onRequestError` (next/dist/server/instrumentation/types). */
export interface RequestErrorContext {
  routerKind?: string
  /** The route file's pattern, e.g. `/deals/[id]` or `/api/deals/[id]/route`. */
  routePath?: string
  /** `middleware` on Next 15, `proxy` on Next 16. */
  routeType?: 'render' | 'route' | 'action' | 'middleware' | 'proxy' | string
  renderSource?: string
  revalidateReason?: string
}

export interface ErrorRequest {
  path?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

const KINDS: Record<string, string> = { render: 'page', route: 'route', action: 'action', middleware: 'middleware', proxy: 'middleware' }

/**
 * Next's `onRequestError` instrumentation hook: an error nobody caught while serving a request. Reported as an
 * unhandled exception of that request, and the route Next names fills in `route_path` if no span has yet.
 * Never throws and never rejects.
 */
export async function onRequestError(error: unknown, _request?: ErrorRequest, context?: RequestErrorContext): Promise<void> {
  try {
    if (process.env.NEXT_RUNTIME === 'edge') return
    const execution = currentExecution()
    const state = requestState(execution)

    if (state !== undefined && context !== undefined) {
      const kind = KINDS[String(context.routeType ?? '')] ?? ''
      const raw = typeof context.routePath === 'string' ? context.routePath : ''
      const path = raw.replace(/\/(route|page)$/, '') || (raw === '' ? '' : '/')
      if (state.routePath === '' && path !== '' && kind !== 'middleware') state.routePath = path
      if (state.routeKind === '' && kind !== '') {
        state.routeKind = kind
        if (path !== '' && kind !== 'middleware') {
          const root = context.routerKind === 'Pages Router' ? 'pages' : 'app'
          const base = path === '/' ? '' : path
          state.routeModule = root === 'pages' ? `pages${base === '' ? '/index' : base}` : `app${base}/${kind === 'route' ? 'route' : 'page'}`
        }
      }
    }

    captureError(error, { handled: false, execution })
  } catch (failure) {
    debug('onRequestError failed:', failure)
  }
}
