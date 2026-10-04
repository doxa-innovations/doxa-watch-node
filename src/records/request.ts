import {
  type ParentTail,
  TEXT,
  TINY_TEXT,
  type WireRecord,
  group,
  int,
  jsonText,
  parentTail,
  truncate,
} from './common'

export interface RequestInput extends ParentTail {
  /** Start of the request, epoch seconds. */
  timestamp: number
  deploy: string
  server: string
  traceId: string
  user: string
  method: string
  url: string
  /** Route pattern (`/deals/[id]`); `""` when no route matched. */
  routePath: string
  /** `page` | `route` | `action` | `middleware` + module path; `""` when unknown. */
  routeAction: string
  routeName?: string
  routeDomain?: string
  ip: string
  statusCode: number
  requestSize: number
  responseSize: number
  /** Stage durations in microseconds. `duration` is their sum. */
  beforeMiddleware: number
  action: number
  render: number
  /** Redacted headers, lower-cased names. */
  headers: Record<string, string[]>
}

/** PROTOCOL §4.3 with the §9.6 differences. */
export function buildRequest(input: RequestInput): WireRecord {
  const matched = input.routePath !== ''
  const methods = matched ? [input.method] : []
  const domain = input.routeDomain ?? ''
  const beforeMiddleware = int(input.beforeMiddleware)
  const action = int(input.action)
  const render = int(input.render)

  return {
    v: 1,
    t: 'request',
    timestamp: input.timestamp,
    deploy: truncate(input.deploy, TINY_TEXT),
    server: truncate(input.server, TINY_TEXT),
    _group: group(`${[...methods].sort().join('|')},${domain},${input.routePath}`),
    trace_id: input.traceId,
    user: truncate(input.user, TINY_TEXT),
    method: input.method,
    url: input.url,
    route_name: input.routeName ?? '',
    route_methods: methods,
    route_domain: domain,
    route_path: input.routePath,
    route_action: input.routeAction,
    ip: input.ip,
    duration: beforeMiddleware + action + render,
    status_code: int(input.statusCode),
    request_size: int(input.requestSize),
    response_size: int(input.responseSize),
    bootstrap: 0,
    before_middleware: beforeMiddleware,
    action,
    render,
    after_middleware: 0,
    sending: 0,
    terminating: 0,
    ...parentTail(input),
    headers: jsonText(input.headers, TEXT, 'headers'),
    payload: '',
  }
}

const AUTH_SCHEMES = ['basic', 'bearer', 'digest', 'hoba', 'mutual', 'negotiate', 'ntlm', 'vapid', 'scram', 'aws4-hmac-sha256']

function redacted(value: string): string {
  return `[${Buffer.byteLength(value)} bytes redacted]`
}

/**
 * PROTOCOL §5.3. Value → `[N bytes redacted]`; `Authorization`/`Proxy-Authorization` keep a known scheme word;
 * `Cookie` keeps the names and redacts each value.
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  names: string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {}

  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue
    const name = rawName.toLowerCase()
    const values = Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)]

    if (!names.includes(name)) {
      result[name] = values
      continue
    }

    result[name] = values.map((value) => {
      if (name === 'authorization' || name === 'proxy-authorization') {
        const space = value.indexOf(' ')
        if (space > 0 && AUTH_SCHEMES.includes(value.slice(0, space).toLowerCase())) {
          return `${value.slice(0, space)} ${redacted(value.slice(space + 1))}`
        }
        return redacted(value)
      }
      if (name === 'cookie') {
        return value
          .split(';')
          .map((pair) => {
            const trimmed = pair.trim()
            const equals = trimmed.indexOf('=')
            return equals === -1 ? redacted(trimmed) : `${trimmed.slice(0, equals)}=${redacted(trimmed.slice(equals + 1))}`
          })
          .join('; ')
      }
      return redacted(value)
    })
  }

  return result
}
