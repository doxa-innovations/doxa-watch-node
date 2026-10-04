import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type RecordContext,
  type WireRecord,
  buildException,
  buildLog,
  buildOutgoingRequest,
  buildRequest,
  buildUser,
  emptyCounters,
  encodeTrace,
  group,
  redactHeaders,
  stripUserInfo,
  truncate,
} from '../src/records'

const md5 = (text: string): string => createHash('md5').update(text).digest('hex')

const context: RecordContext = {
  deploy: 'v1.2.3',
  server: 'web-01',
  traceId: '00000000-0000-0000-0000-000000000000',
  executionSource: 'request',
  executionId: '00000000-0000-0000-0000-000000000001',
  executionPreview: 'GET /users',
  executionStage: 'action',
  user: '',
}

const CHILD = ['deploy', 'server', '_group', 'trace_id', 'execution_source', 'execution_id', 'execution_preview', 'execution_stage', 'user']
const COUNTERS = ['exceptions', 'logs', 'queries', 'lazy_loads', 'jobs_queued', 'mail', 'notifications', 'outgoing_requests', 'files_read', 'files_written', 'cache_events', 'hydrated_models', 'peak_memory_usage', 'exception_preview', 'context']

const request = buildRequest({
  timestamp: 946688523.456789,
  deploy: 'v1.2.3',
  server: 'web-01',
  traceId: context.traceId,
  user: '',
  method: 'GET',
  url: 'http://localhost/users',
  routePath: '/users',
  routeAction: 'page app/users/page',
  ip: '127.0.0.1',
  statusCode: 200,
  requestSize: 0,
  responseSize: 2,
  beforeMiddleware: 100,
  action: 2000,
  render: 300,
  counters: { ...emptyCounters(), queries: 2 },
  peakMemoryUsage: 1234,
  exceptionPreview: '',
  headers: { host: ['localhost'] },
})

const exception = buildException(context, {
  class: 'TypeError',
  message: 'Whoops!',
  code: '',
  stack: {
    file: 'app/boom/page.tsx',
    line: 4,
    frames: [
      { file: 'app/boom/page.tsx', line: 4, column: 9, function: 'explode', code: { '3': 'function explode() {', '4': "  throw new TypeError('Whoops!')", '5': '}' }, vendor: false, resolved: true },
      { file: 'app/boom/page.tsx', line: 9, column: 3, function: 'Page', code: null, vendor: false, resolved: true },
      { file: 'node_modules/next/dist/server/render.js', line: 54, column: 1, function: 'renderToHTML', code: null, vendor: true, resolved: false },
    ],
  },
  handled: false,
  runtime: 'node',
  runtimeVersion: '22.11.0',
  framework: { name: 'next', version: '15.5.27' },
  timestamp: 946688523.456789,
})

const outgoing = buildOutgoingRequest(
  { ...context, executionPreview: 'POST /users' },
  { timestamp: 946688523.459289, host: 'laravel.com', method: 'POST', url: 'https://user:secret@laravel.com/a?b=1', duration: 1234000, requestSize: 2000, responseSize: 3000, statusCode: 200 },
)

const log = buildLog(context, { level: 'info', message: 'hello world', timestamp: 1758400000.123456 })
const user = buildUser({ id: 567, name: 'Tim MacDonald', username: 'tim@laravel.com' }, 946688523.456789)

// PROTOCOL.md's shapes: the exact key list of each record type, in wire order.
const shapes: { name: string; record: WireRecord; keys: string[]; v: number }[] = [
  {
    name: 'request (§4.3)',
    record: request,
    v: 1,
    keys: ['v', 't', 'timestamp', 'deploy', 'server', '_group', 'trace_id', 'user', 'method', 'url', 'route_name', 'route_methods', 'route_domain', 'route_path', 'route_action', 'ip', 'duration', 'status_code', 'request_size', 'response_size', 'bootstrap', 'before_middleware', 'action', 'render', 'after_middleware', 'sending', 'terminating', ...COUNTERS, 'headers', 'payload'],
  },
  {
    name: 'exception (§4.13 + §9.3)',
    record: exception,
    v: 3,
    keys: ['v', 't', 'timestamp', ...CHILD, 'class', 'file', 'line', 'message', 'code', 'trace', 'handled', 'php_version', 'laravel_version', 'runtime', 'runtime_version', 'framework', 'framework_version'],
  },
  {
    name: 'outgoing-request (§4.10)',
    record: outgoing,
    v: 1,
    keys: ['v', 't', 'timestamp', ...CHILD, 'host', 'method', 'url', 'duration', 'request_size', 'response_size', 'status_code'],
  },
  {
    name: 'log (§4.14)',
    record: log,
    v: 1,
    keys: ['v', 't', 'timestamp', ...CHILD.filter((key) => key !== '_group'), 'level', 'message', 'context', 'extra'],
  },
  { name: 'user (§4.15)', record: user, v: 1, keys: ['v', 't', 'timestamp', 'id', 'name', 'username'] },
]

describe('record shapes', () => {
  it.each(shapes)('$name carries exactly the protocol keys, none null', ({ record, keys, v }) => {
    expect(Object.keys(record)).toEqual(keys)
    expect(record.v).toBe(v)
    for (const [key, value] of Object.entries(record)) {
      expect(value, key).not.toBeNull()
      expect(value, key).not.toBeUndefined()
    }
    expect(typeof record.timestamp).toBe('number')
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })
})

describe('request', () => {
  it('matches the protocol example apart from the Node differences (§9.6)', () => {
    expect(request).toMatchObject({
      t: 'request',
      timestamp: 946688523.456789,
      _group: md5('GET,,/users'),
      route_methods: ['GET'],
      route_domain: '',
      route_name: '',
      route_path: '/users',
      route_action: 'page app/users/page',
      duration: 2400,
      bootstrap: 0,
      before_middleware: 100,
      action: 2000,
      render: 300,
      after_middleware: 0,
      sending: 0,
      terminating: 0,
      queries: 2,
      lazy_loads: 0,
      peak_memory_usage: 1234,
      context: '{}',
      headers: '{"host":["localhost"]}',
      payload: '',
    })
  })

  it('hashes ",," and sends no methods when no route matched', () => {
    const unmatched = buildRequest({ ...baseRequest(), routePath: '', routeAction: '' })
    expect(unmatched._group).toBe(md5(',,'))
    expect(unmatched.route_methods).toEqual([])
    expect(unmatched.route_path).toBe('')
  })

  function baseRequest(): Parameters<typeof buildRequest>[0] {
    return { timestamp: 1, deploy: '', server: '', traceId: 't', user: '', method: 'GET', url: 'http://x/', routePath: '/', routeAction: 'page', ip: '', statusCode: 404, requestSize: 0, responseSize: 0, beforeMiddleware: 0, action: 1, render: 0, counters: emptyCounters(), peakMemoryUsage: 0, exceptionPreview: '', headers: {} }
  }

  it.each([
    ['authorization keeps a known scheme', { authorization: 'Bearer abcdef' }, { authorization: ['Bearer [6 bytes redacted]'] }],
    ['authorization without a scheme', { authorization: 'abcdef' }, { authorization: ['[6 bytes redacted]'] }],
    ['cookie keeps the names', { cookie: 'a=12345; session=xyz' }, { cookie: ['a=[5 bytes redacted]; session=[3 bytes redacted]'] }],
    ['other redacted headers', { 'x-xsrf-token': 'tok' }, { 'x-xsrf-token': ['[3 bytes redacted]'] }],
    ['untouched headers become arrays', { Accept: 'text/html', 'set-cookie': ['a', 'b'] }, { accept: ['text/html'], 'set-cookie': ['a', 'b'] }],
  ])('redacts headers: %s', (_name, input, expected) => {
    expect(redactHeaders(input, ['authorization', 'cookie', 'proxy-authorization', 'x-xsrf-token'])).toEqual(expected)
  })
})

describe('exception', () => {
  it('groups by class, code, file and line', () => {
    expect(exception._group).toBe(md5('TypeError,,app/boom/page.tsx,4'))
    expect(exception).toMatchObject({ class: 'TypeError', file: 'app/boom/page.tsx', line: 4, code: '', handled: false, php_version: '', laravel_version: '', runtime: 'node', runtime_version: '22.11.0', framework: 'next', framework_version: '15.5.27' })
  })

  it('ends the group string with a comma when the line is unknown', () => {
    const record = buildException(context, { class: 'Error', message: 'x', code: '999', stack: { file: 'a.ts', line: 0, frames: [] }, handled: true, runtime: 'node', runtimeVersion: '22', framework: { name: '', version: '' } })
    expect(record._group).toBe(md5('Error,999,a.ts,'))
    expect(record.trace).toBe('[]')
  })

  it('writes the trace as a JSON string with function names shifted down by one: `source` is what was called from that frame', () => {
    const trace = JSON.parse(exception.trace as string) as { file: string; source: string; code: unknown }[]
    expect(trace).toEqual([
      { file: 'app/boom/page.tsx:4', source: '', code: { '3': 'function explode() {', '4': "  throw new TypeError('Whoops!')", '5': '}' } },
      { file: 'app/boom/page.tsx:9', source: 'explode', code: null },
      { file: 'node_modules/next/dist/server/render.js:54', source: 'Page', code: null },
    ])
  })

  it('omits the line suffix when a frame has no line', () => {
    expect(JSON.parse(encodeTrace([{ file: 'node:internal', line: 0, column: 0, function: '', code: null, vendor: true, resolved: false }]))).toEqual([{ file: 'node:internal', source: '', code: null }])
  })
})

describe('outgoing-request, log, user', () => {
  it('matches the protocol example', () => {
    expect(outgoing).toMatchObject({ _group: md5('laravel.com'), host: 'laravel.com', method: 'POST', url: 'https://laravel.com/a?b=1', duration: 1234000, request_size: 2000, response_size: 3000, status_code: 200, execution_preview: 'POST /users' })
    expect(stripUserInfo('http://a:b@host/p?x=y@z')).toBe('http://host/p?x=y@z')
  })

  it('logs carry JSON strings for context and extra', () => {
    expect(log).toMatchObject({ level: 'info', message: 'hello world', context: '{}', extra: '{}', timestamp: 1758400000.123456 })
    const withError = buildLog(context, { level: 'error', message: 'x', context: { exception: { class: 'TypeError', message: 'y' }, big: 10n } })
    expect(JSON.parse(withError.context as string)).toEqual({ exception: { class: 'TypeError', message: 'y' }, big: '10' })
  })

  it('a context that cannot be serialised is survivable', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(JSON.parse(buildLog(context, { level: 'info', message: 'x', context: circular }).context as string)).toEqual({ self: '[Circular]' })
  })

  it('user ids are strings', () => {
    expect(user).toEqual({ v: 1, t: 'user', timestamp: 946688523.456789, id: '567', name: 'Tim MacDonald', username: 'tim@laravel.com' })
    expect(buildUser({ id: 'u1' })).toMatchObject({ id: 'u1', name: '', username: '' })
  })
})

describe('common', () => {
  it('group is the MD5 hex of the identity string', () => {
    expect(group('GET,,/users')).toMatch(/^[0-9a-f]{32}$/)
    expect(group('x')).toBe(md5('x'))
  })

  it.each([
    ['short strings are untouched', 'abc', 10, 'abc'],
    ['cuts by bytes', 'abcdef', 3, 'abc'],
    ['never leaves half a character', 'aé', 2, 'a'],
    ['null becomes empty', null, 5, ''],
  ])('truncate: %s', (_name, input, bytes, expected) => {
    expect(truncate(input, bytes)).toBe(expected)
  })
})
