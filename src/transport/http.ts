import * as http from 'node:http'
import * as https from 'node:https'

export interface HttpResponse {
  status: number
  body: string
}

export interface PostOptions {
  headers: Record<string, string>
  body: Buffer | string
  connectTimeoutMs: number
  timeoutMs: number
}

const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * The SDK's own HTTP client. It uses `node:http(s)` on purpose: the outgoing-request sensor listens on undici's
 * channels (which `fetch` uses), so these calls can never be recorded as the app's outgoing requests.
 * Redirects are not followed (PROTOCOL §2.2: a compatible server must not redirect).
 */
export function post(url: string, options: PostOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, response?: HttpResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(total)
      clearTimeout(connect)
      if (error) {
        request.destroy()
        reject(error)
      } else {
        resolve(response as HttpResponse)
      }
    }

    const target = new URL(url)
    const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body
    const transport = target.protocol === 'https:' ? https : http

    const request = transport.request(
      target,
      { method: 'POST', headers: { ...options.headers, 'content-length': String(body.byteLength) } },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (size < MAX_RESPONSE_BYTES) chunks.push(chunk)
          size += chunk.byteLength
        })
        response.on('end', () => {
          finish(null, {
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8'),
          })
        })
        response.on('error', (error) => finish(error))
      },
    )

    const total = setTimeout(() => finish(new Error(`timed out after ${options.timeoutMs} ms`)), options.timeoutMs)
    const connect = setTimeout(
      () => finish(new Error(`connection timed out after ${options.connectTimeoutMs} ms`)),
      options.connectTimeoutMs,
    )
    request.on('socket', (socket) => {
      if (!socket.connecting) {
        clearTimeout(connect)
        return
      }
      socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connect))
    })
    request.on('error', (error) => finish(error))
    request.end(body)
  })
}

/** A JSON object body, or `{}` for anything else. */
export function parseObject(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function truncateMessage(message: unknown): string {
  if (typeof message !== 'string') return ''
  return message.length > 1000 ? `${message.slice(0, 1000)}[...]` : message
}
