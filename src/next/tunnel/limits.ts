/** Spec §5: the tunnel accepts at most 64 kB per post and 60 posts per minute from one IP. */
export const MAX_BODY_BYTES = 64 * 1024
export const RATE_LIMIT_PER_MINUTE = 60
const WINDOW_MS = 60_000
const MAX_TRACKED_CLIENTS = 10_000

/**
 * A fixed-window counter per client, in memory. The map is bounded: when it is full, finished windows are removed,
 * and if that frees nothing the longest-tracked client is forgotten (it starts a new window on its next post).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly limit: number = RATE_LIMIT_PER_MINUTE,
    private readonly maxClients: number = MAX_TRACKED_CLIENTS,
  ) {}

  /** Counts one post from `client`; false when it is over the limit. */
  allow(client: string, nowMs: number = Date.now()): boolean {
    const current = this.windows.get(client)
    if (current !== undefined && nowMs - current.start < WINDOW_MS) {
      current.count++
      return current.count <= this.limit
    }

    this.windows.delete(client)
    if (this.windows.size >= this.maxClients) {
      for (const [key, window] of this.windows) {
        if (nowMs - window.start >= WINDOW_MS) this.windows.delete(key)
      }
      if (this.windows.size >= this.maxClients) this.windows.delete(this.windows.keys().next().value as string)
    }
    this.windows.set(client, { start: nowMs, count: 1 })
    return this.limit >= 1
  }

  get size(): number {
    return this.windows.size
  }
}

/**
 * The request body as text, or null when it is larger than `maxBytes` (by `content-length`, or once that many bytes
 * were read — the rest is not consumed) or unreadable.
 */
export async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (request.body === null) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Whether the post comes from a page of this site. A browser's `sec-fetch-site` cannot be set by scripts, so
 * `same-origin` is accepted and any other value refused. Without that header (older browsers), `Origin` must name the
 * host the request was sent to; a post with neither is refused.
 */
export function isSameOrigin(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'

  const origin = headers.get('origin')
  if (origin === null) return false
  // Behind a proxy the public host is in `x-forwarded-host`; either name counts as "the host of the request".
  const hosts = [headers.get('x-forwarded-host'), headers.get('host')]
    .map((value) => (value ?? '').split(',')[0]?.trim().toLowerCase() ?? '')
    .filter((value) => value !== '')
  try {
    return hosts.includes(new URL(origin).host.toLowerCase())
  } catch {
    return false
  }
}
