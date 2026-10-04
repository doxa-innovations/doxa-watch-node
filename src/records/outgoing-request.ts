import { type RecordContext, TEXT, TINY_TEXT, type WireRecord, childFields, group, int, truncate } from './common'

export interface OutgoingRequestInput {
  /** Start of the request, epoch seconds. */
  timestamp: number
  host: string
  method: string
  url: string
  /** Microseconds. */
  duration: number
  requestSize: number
  responseSize: number
  /** 0 for a connection failure (PROTOCOL §9.6). */
  statusCode: number
}

/** `user:pass@` never goes on the wire; the query string stays. */
export function stripUserInfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1')
}

/** PROTOCOL §4.10. */
export function buildOutgoingRequest(context: RecordContext, input: OutgoingRequestInput): WireRecord {
  return {
    v: 1,
    t: 'outgoing-request',
    timestamp: input.timestamp,
    ...childFields(context, group(input.host)),
    host: truncate(input.host, TINY_TEXT),
    method: truncate(input.method, TINY_TEXT),
    url: truncate(stripUserInfo(input.url), TEXT),
    duration: int(input.duration),
    request_size: int(input.requestSize),
    response_size: int(input.responseSize),
    status_code: int(input.statusCode),
  }
}
