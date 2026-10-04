import type { Config } from '../config'
import { debug } from '../debug'
import { userAgent } from '../version'
import { parseObject, post, truncateMessage } from './http'

export interface IngestDetails {
  token: string
  ingestUrl: string
  /** `Date.now()` value after which the token must not be used. */
  expiresAt: number
}

const FIRST_BOOT_BACKOFF = [2.5, 5, 10, 15, 30, 60, 120, 240]

/**
 * Seconds before the next auth attempt (PROTOCOL §2.2).
 * Never authenticated: 2.5, 5, 10, 15, 30, 60, 120, 240, then 300 × 12, then 3600.
 * Authenticated at least once: 300 while there are fewer than 13 consecutive failures, then 3600.
 */
export function backoffSeconds(consecutiveFailures: number, everAuthenticated: boolean): number {
  if (everAuthenticated) return consecutiveFailures < 13 ? 300 : 3600
  const index = Math.max(consecutiveFailures, 1) - 1
  if (index < FIRST_BOOT_BACKOFF.length) return FIRST_BOOT_BACKOFF[index] as number
  return index < FIRST_BOOT_BACKOFF.length + 12 ? 300 : 3600
}

/** PROTOCOL §2.2: `POST {baseUrl}/api/agent-auth`, timer refresh, on-demand refresh, `stop`, back-off. */
export class AuthClient {
  private current: IngestDetails | null = null
  private timer: NodeJS.Timeout | null = null
  private pending: Promise<void> | null = null
  private failures = 0
  private everAuthenticated = false
  private stopped = false
  /** Set by `stop` (auth or ingest); cleared by the next successful auth. */
  paused = false
  onResume: (() => void) | null = null
  /** How many auth calls were made; exposed for tests and `status`. */
  attempts = 0
  lastError = ''

  constructor(private readonly config: Config) {}

  /** First call at start-up, before any records exist. */
  start(): Promise<void> {
    return this.authenticate()
  }

  /** Stops the timers; the client can still be used on demand until the process ends. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The token as it is right now, without triggering anything. */
  peek(): IngestDetails | null {
    return this.current !== null && this.current.expiresAt > Date.now() ? this.current : null
  }

  /**
   * Valid details for one ingest request, or null (the batch is then dropped).
   * Waits for an auth call that is under way; re-authenticates on demand once the token has expired.
   */
  async details(): Promise<IngestDetails | null> {
    if (this.pending) await this.pending
    if (this.paused) return null
    if (this.current !== null && this.current.expiresAt <= Date.now()) {
      await this.authenticate()
    }
    return this.peek()
  }

  /** Ingest answered `stop`: drop the token and try to authenticate again after `refreshIn` seconds (default 900). */
  pause(refreshInSeconds?: number): void {
    this.paused = true
    this.current = null
    this.schedule(typeof refreshInSeconds === 'number' && refreshInSeconds >= 0 ? refreshInSeconds : 900)
  }

  authenticate(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.run().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async run(): Promise<void> {
    this.attempts++
    let body: Record<string, unknown> = {}
    let failure = ''

    try {
      const response = await post(`${this.config.baseUrl}/api/agent-auth`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
          'nightwatch-server': this.config.server,
          'user-agent': userAgent(this.config.framework),
        },
        body: '{}',
        connectTimeoutMs: this.config.connectTimeoutMs,
        timeoutMs: this.config.requestTimeoutMs,
      })
      body = parseObject(response.body)

      if (response.status >= 200 && response.status < 300) {
        const { token, expires_in: expiresIn, refresh_in: refreshIn, ingest_url: ingestUrl } = body
        // Strict types, like the agent: integers for the two durations, strings for the rest.
        if (
          typeof token === 'string' &&
          typeof ingestUrl === 'string' &&
          Number.isInteger(expiresIn) &&
          Number.isInteger(refreshIn)
        ) {
          this.current = { token, ingestUrl, expiresAt: Date.now() + (expiresIn as number) * 1000 }
          this.failures = 0
          this.everAuthenticated = true
          this.lastError = ''
          const wasPaused = this.paused
          this.paused = false
          this.schedule(refreshIn as number)
          debug('authenticated; next refresh in', refreshIn, 's')
          if (wasPaused) this.onResume?.()
          return
        }
        failure = 'Invalid authentication response'
        body = {}
      } else {
        failure = `${response.status} [${truncateMessage(body.message)}]`
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    this.failures++
    this.lastError = failure
    // `stop` drops the current token at once; without it the old token stays in use until it expires by itself.
    if (body.stop === true) {
      this.current = null
      this.paused = true
    }
    const refreshIn = body.refresh_in
    const delay =
      typeof refreshIn === 'number' && Number.isFinite(refreshIn) && refreshIn >= 0
        ? refreshIn
        : backoffSeconds(this.failures, this.everAuthenticated)
    debug(`authentication failed (${failure}); next attempt in ${delay} s`)
    this.schedule(delay)
  }

  private schedule(seconds: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped) return
    // setTimeout overflows above 2^31-1 ms.
    this.timer = setTimeout(() => void this.authenticate(), Math.min(seconds * 1000, 2_147_483_647))
    this.timer.unref()
  }
}
