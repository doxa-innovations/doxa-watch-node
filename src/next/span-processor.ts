import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { debug } from '../debug'
import { currentExecution } from '../execution'
import { type RequestState, requestState } from '../sensors/http'

// Next's span types (next/dist/server/lib/trace/constants.js), carried in the `next.span_type` attribute.
// Verified against Next 15.5 and 16.3; without NEXT_OTEL_VERBOSE only an allow-list of them is emitted.
const ROOT = 'BaseServer.handleRequest'
const MIDDLEWARE = 'Middleware.execute'
const APP_RENDER = 'AppRender.getBodyResult'
const APP_ROUTE = 'AppRouteRouteHandlers.runHandler'
const PAGES_RENDER = 'Render.renderDocument'
const PAGES_PROPS = 'Render.getServerSideProps'
const PAGES_API = 'Node.runHandler'

function micros(duration: [number, number] | undefined): number {
  if (!Array.isArray(duration)) return 0
  return Math.max(Math.round(duration[0] * 1_000_000 + duration[1] / 1000), 0)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `/api/hello/route` (Next 15) and `/api/hello` (Next 16) are the same route handler. */
function withoutSuffix(route: string, suffix: string): string {
  if (route === suffix) return '/'
  return route.endsWith(suffix) ? route.slice(0, -suffix.length) : route
}

function modulePath(root: string, route: string, leaf: string): string {
  const base = route === '/' ? '' : route
  return leaf === '' ? `${root}${base === '' ? '/index' : base}` : `${root}${base}/${leaf}`
}

function isServerAction(state: RequestState): boolean {
  return state.request.method === 'POST' && state.request.headers['next-action'] !== undefined
}

/**
 * Reads Next's own OpenTelemetry spans — nothing is exported anywhere. Each span is tied to the request execution
 * it started in; when it ends, its route and timing go onto that request:
 *
 * - `BaseServer.handleRequest` (root): `next.route` → `route_path`
 * - `AppRender.getBodyResult`, `Render.renderDocument`: duration → `render`; kind `page`
 * - `AppRouteRouteHandlers.runHandler`, `Node.runHandler`: kind `route`
 * - `Middleware.execute`: duration → `before_middleware`
 *
 * `register()` from `@doxa-innovations/watch/next` installs it on a provider of its own. An app that already runs OpenTelemetry
 * adds it to its provider instead: `new NodeTracerProvider({ spanProcessors: [new DoxaWatchSpanProcessor(), …] })`.
 */
export class DoxaWatchSpanProcessor implements SpanProcessor {
  private readonly states = new WeakMap<object, RequestState>()

  onStart(span: Span, _parentContext: Context): void {
    try {
      const state = requestState(currentExecution())
      if (state === undefined) return
      this.states.set(span, state)
      state.openSpans++
    } catch (error) {
      debug('span start failed:', error)
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const state = this.states.get(span)
      if (state === undefined) return
      this.states.delete(span)
      this.read(span, state)
      state.openSpans--
      if (state.openSpans <= 0) state.onIdle?.()
    } catch (error) {
      debug('span end failed:', error)
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  private read(span: ReadableSpan, state: RequestState): void {
    const attributes = span.attributes ?? {}
    const type = text(attributes['next.span_type'])
    const route = text(attributes['next.route'])
    const set = (kind: string, path: string, module: string): void => {
      // The first span that knows wins, except that a server action is always an action.
      if (state.routeKind === '' || state.routeKind === 'middleware') {
        state.routeKind = kind
        state.routeModule = module
      }
      if (path !== '') state.routePath = path
    }

    switch (type) {
      case APP_RENDER: {
        state.renderMicros += micros(span.duration)
        if (route !== '') set(isServerAction(state) ? 'action' : 'page', route, modulePath('app', route, 'page'))
        break
      }
      case APP_ROUTE: {
        const path = withoutSuffix(route, '/route')
        if (route !== '') set('route', path, modulePath('app', path, 'route'))
        break
      }
      case PAGES_RENDER: {
        state.renderMicros += micros(span.duration)
        if (route !== '') set('page', route, modulePath('pages', route, ''))
        break
      }
      case PAGES_PROPS: {
        if (route !== '') set('page', route, modulePath('pages', route, ''))
        break
      }
      case PAGES_API: {
        if (route !== '') set('route', route, modulePath('pages', route, ''))
        break
      }
      case MIDDLEWARE: {
        state.middlewareMicros += micros(span.duration)
        if (state.routeKind === '') state.routeKind = 'middleware'
        break
      }
      case ROOT: {
        // The root span learns the route last; it is authoritative when nothing more specific was seen.
        if (state.routePath === '' && route !== '') {
          const path = withoutSuffix(route, '/route')
          state.routePath = path
          if (state.routeKind === '' || state.routeKind === 'middleware') {
            state.routeKind = isServerAction(state) ? 'action' : 'page'
            state.routeModule = modulePath('app', path, 'page')
          }
        }
        break
      }
      default:
        break
    }
  }
}
