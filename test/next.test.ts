import { beforeEach, describe, expect, it } from 'vitest'
import { Execution } from '../src/execution'
import * as edge from '../src/next/edge'
import * as node from '../src/next/index'
import { onRequestError } from '../src/next/on-request-error'
import { DoxaWatchSpanProcessor } from '../src/next/span-processor'
import { withDoxaWatch } from '../src/next/with-doxa-watch'
import { getRuntime } from '../src/runtime'
import type { RequestState } from '../src/sensors/http'
import { type MemorySink, useMemorySink } from './helpers/sink'

const EXTERNAL = ['doxa-watch', '@opentelemetry/api', '@opentelemetry/sdk-trace-base', 'source-map-js', 'nodemailer']

describe('withDoxaWatch', () => {
  it('sets the source-map options and keeps the SDK external, leaving the rest alone', () => {
    const config = withDoxaWatch({ output: 'standalone', serverExternalPackages: ['pg', 'doxa-watch'], experimental: { typedRoutes: true }, productionBrowserSourceMaps: false })
    expect(config).toEqual({
      output: 'standalone',
      productionBrowserSourceMaps: true,
      serverExternalPackages: ['pg', ...EXTERNAL],
      experimental: { serverMinification: false, typedRoutes: true, serverSourceMaps: true },
    })
  })

  it.each([
    ['an empty config', {}],
    ['undefined', undefined],
  ])('accepts %s', (_name, input) => {
    expect(withDoxaWatch(input as Record<string, unknown>)).toEqual({ productionBrowserSourceMaps: true, serverExternalPackages: EXTERNAL, experimental: { serverMinification: false, serverSourceMaps: true } })
  })

  it('turns server minification off for readable stack traces, unless the app chose a value itself', () => {
    const experimental = (config: Record<string, unknown>): unknown => withDoxaWatch(config).experimental
    expect(experimental({})).toEqual({ serverMinification: false, serverSourceMaps: true })
    expect(experimental({ experimental: { serverMinification: true } })).toEqual({ serverMinification: true, serverSourceMaps: true })
    expect(experimental({ experimental: { serverMinification: false } })).toEqual({ serverMinification: false, serverSourceMaps: true })
  })

  it('wraps a config function, sync or async, passing its arguments through', async () => {
    const sync = withDoxaWatch((phase: string) => ({ env: { phase } }))
    expect(sync('phase-production-build')).toMatchObject({ env: { phase: 'phase-production-build' }, productionBrowserSourceMaps: true })
    const asynchronous = withDoxaWatch(async () => ({ basePath: '/crm' }))
    expect(await asynchronous()).toMatchObject({ basePath: '/crm', experimental: { serverSourceMaps: true } })
  })
})

describe('edge stub', () => {
  it('exports the same names as the Node entry point, and they do nothing', async () => {
    expect(Object.keys(edge).sort()).toEqual(Object.keys(node).sort())
    expect(edge.register()).toBeUndefined()
    await expect(edge.onRequestError(new Error('x'))).resolves.toBeUndefined()
  })
})

function requestExecution(method = 'GET', headers: Record<string, string> = {}): { execution: Execution; state: RequestState } {
  const execution = new Execution({ source: 'request', preview: `${method} /x`, sampled: true })
  const state: RequestState = {
    request: { method, path: '/x', url: 'http://localhost/x', headers, ip: '' },
    routePath: '',
    routeKind: '',
    routeModule: '',
    middlewareMicros: 0,
    renderMicros: 0,
    openSpans: 0,
    onIdle: null,
  }
  execution.meta.request = state
  return { execution, state }
}

describe('DoxaWatchSpanProcessor', () => {
  beforeEach(() => void useMemorySink())

  /** Starts and ends spans inside the execution, the way Next's tracer does while handling a request. */
  function feed(spans: { type: string; route?: string; ms?: number }[], method = 'GET', headers: Record<string, string> = {}): RequestState {
    const { execution, state } = requestExecution(method, headers)
    const processor = new DoxaWatchSpanProcessor()
    getRuntime().als.run(execution, () => {
      for (const span of spans) {
        const object = { attributes: { 'next.span_type': span.type, ...(span.route === undefined ? {} : { 'next.route': span.route }) }, duration: [0, (span.ms ?? 0) * 1_000_000] }
        processor.onStart(object as never, {} as never)
        expect(state.openSpans).toBe(1)
        processor.onEnd(object as never)
      }
    })
    expect(state.openSpans).toBe(0)
    return state
  }

  it.each([
    ['an App Router page', [{ type: 'AppRender.getBodyResult', route: '/deals/[id]', ms: 12 }, { type: 'BaseServer.handleRequest', route: '/deals/[id]' }], { routePath: '/deals/[id]', routeKind: 'page', routeModule: 'app/deals/[id]/page', renderMicros: 12_000 }],
    ['the home page', [{ type: 'AppRender.getBodyResult', route: '/', ms: 1 }], { routePath: '/', routeKind: 'page', routeModule: 'app/page' }],
    ['a route handler as Next 15 names it', [{ type: 'AppRouteRouteHandlers.runHandler', route: '/api/hello/route' }, { type: 'BaseServer.handleRequest', route: '/api/hello/route' }], { routePath: '/api/hello', routeKind: 'route', routeModule: 'app/api/hello/route', renderMicros: 0 }],
    ['a route handler as Next 16 names it', [{ type: 'AppRouteRouteHandlers.runHandler', route: '/api/hello' }], { routePath: '/api/hello', routeKind: 'route', routeModule: 'app/api/hello/route' }],
    ['middleware before a page', [{ type: 'Middleware.execute', ms: 3 }, { type: 'AppRender.getBodyResult', route: '/a', ms: 5 }], { routeKind: 'page', middlewareMicros: 3000, renderMicros: 5000 }],
    ['a request answered by middleware', [{ type: 'Middleware.execute', ms: 3 }, { type: 'BaseServer.handleRequest' }], { routePath: '', routeKind: 'middleware', routeModule: '', middlewareMicros: 3000 }],
    ['only the root span knows the route', [{ type: 'BaseServer.handleRequest', route: '/cached' }], { routePath: '/cached', routeKind: 'page', routeModule: 'app/cached/page' }],
    ['a Pages Router page', [{ type: 'Render.getServerSideProps', route: '/posts/[slug]' }, { type: 'Render.renderDocument', route: '/posts/[slug]', ms: 2 }], { routePath: '/posts/[slug]', routeKind: 'page', routeModule: 'pages/posts/[slug]', renderMicros: 2000 }],
    ['a Pages Router API route', [{ type: 'Node.runHandler', route: '/api/legacy' }], { routePath: '/api/legacy', routeKind: 'route', routeModule: 'pages/api/legacy' }],
    ['spans it does not know', [{ type: 'NextNodeServer.findPageComponents', route: '/x' }, { type: 'ResolveMetadata.generateMetadata' }], { routePath: '', routeKind: '' }],
  ])('%s', (_name, spans, expected) => {
    expect(feed(spans)).toMatchObject(expected)
  })

  it('a POST with a next-action header is a server action', () => {
    expect(feed([{ type: 'AppRender.getBodyResult', route: '/action', ms: 1 }], 'POST', { 'next-action': 'abc' })).toMatchObject({ routePath: '/action', routeKind: 'action', routeModule: 'app/action/page' })
  })

  it('calls onIdle when the last open span ends, and ignores spans outside a request', () => {
    const { execution, state } = requestExecution()
    const processor = new DoxaWatchSpanProcessor()
    let idle = 0
    state.onIdle = () => idle++
    const a = { attributes: {}, duration: [0, 0] }
    const b = { attributes: {}, duration: [0, 0] }
    getRuntime().als.run(execution, () => {
      processor.onStart(a as never, {} as never)
      processor.onStart(b as never, {} as never)
    })
    processor.onEnd(a as never)
    expect(idle).toBe(0)
    processor.onEnd(b as never)
    expect(idle).toBe(1)

    const outside = { attributes: { 'next.span_type': 'BaseServer.handleRequest' }, duration: [0, 0] }
    expect(() => {
      processor.onStart(outside as never, {} as never)
      processor.onEnd(outside as never)
      processor.onEnd({ attributes: undefined, duration: undefined } as never)
    }).not.toThrow()
  })
})

describe('onRequestError', () => {
  let sink: MemorySink
  beforeEach(() => {
    sink = useMemorySink().sink
  })

  it.each([
    ['a page', { routerKind: 'App Router', routePath: '/boom', routeType: 'render' }, { routePath: '/boom', routeKind: 'page', routeModule: 'app/boom/page' }],
    ['a route handler', { routerKind: 'App Router', routePath: '/api/boom/route', routeType: 'route' }, { routePath: '/api/boom', routeKind: 'route', routeModule: 'app/api/boom/route' }],
    ['a server action', { routerKind: 'App Router', routePath: '/action', routeType: 'action' }, { routePath: '/action', routeKind: 'action', routeModule: 'app/action/page' }],
    ['middleware (Next 15)', { routerKind: 'App Router', routePath: '/middleware', routeType: 'middleware' }, { routePath: '', routeKind: 'middleware', routeModule: '' }],
    ['proxy (Next 16)', { routerKind: 'App Router', routePath: '/proxy', routeType: 'proxy' }, { routePath: '', routeKind: 'middleware', routeModule: '' }],
    ['a Pages Router page', { routerKind: 'Pages Router', routePath: '/posts/[slug]', routeType: 'render' }, { routePath: '/posts/[slug]', routeKind: 'page', routeModule: 'pages/posts/[slug]' }],
  ])('reports an unhandled exception of the request and fills in the route: %s', async (_name, context, expected) => {
    const { execution, state } = requestExecution()
    await getRuntime().als.run(execution, () => onRequestError(Object.assign(new Error('boom'), { digest: '123' }), { path: '/x', method: 'GET', headers: {} }, context))
    expect(state).toMatchObject(expected)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ t: 'exception', handled: false, message: 'boom', code: '123', execution_id: execution.id })
    expect(execution.exceptionPreview).toBe('boom')
  })

  it('does not overwrite a route a span already supplied; works outside a request; never rejects', async () => {
    const { execution, state } = requestExecution()
    state.routePath = '/deals/[id]'
    state.routeKind = 'page'
    state.routeModule = 'app/deals/[id]/page'
    await getRuntime().als.run(execution, () => onRequestError(new Error('a'), {}, { routePath: '/other', routeType: 'route' }))
    expect(state).toMatchObject({ routePath: '/deals/[id]', routeKind: 'page', routeModule: 'app/deals/[id]/page' })

    await expect(onRequestError(new Error('b'))).resolves.toBeUndefined()
    expect(sink.records.at(-1)).toMatchObject({ message: 'b', execution_source: 'command' })
    await expect(onRequestError(undefined, undefined, undefined)).resolves.toBeUndefined()
  })
})
