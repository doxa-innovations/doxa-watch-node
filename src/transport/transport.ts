import { spawnSync } from 'node:child_process'
import { gzip, gzipSync } from 'node:zlib'
import type { Config } from '../config'
import { debug } from '../debug'
import type { WireRecord } from '../records/common'
import { userAgent } from '../version'
import { AuthClient } from './auth'
import { parseObject, post, truncateMessage } from './http'

export interface TransportStats {
  /** Records accepted by the server (2xx without `stop`). */
  sent: number
  /** Records lost: buffer overflow, failed batch, no token, paused. */
  dropped: number
  batches: number
  failedBatches: number
}

export interface EnqueueOptions {
  /** Send these records now, as their own request, instead of waiting for the next flush (exceptions). */
  immediate?: boolean
}

function compress(payload: string): Promise<Buffer> {
  return new Promise((resolve, reject) => gzip(payload, (error, result) => (error ? reject(error) : resolve(result))))
}

// Run by `flushSync` in a child process: one POST of the gzip body on stdin, then exit.
const SYNC_SENDER = `
const o = JSON.parse(process.env.DOXA_WATCH_SYNC_REQUEST);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const u = new URL(o.url);
  const req = require(u.protocol === 'https:' ? 'node:https' : 'node:http').request(u, { method: 'POST', headers: { ...o.headers, 'content-length': String(body.length) } }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(1));
  req.end(body);
});
`

/**
 * In-process replacement for the local agent (spec §3.1, PROTOCOL §9.1): buffers serialised records and POSTs
 * gzip `{"records":[…]}` to `ingest_url`. A failed batch is dropped, never retried.
 */
export class Transport {
  readonly auth: AuthClient
  readonly stats: TransportStats = { sent: 0, dropped: 0, batches: 0, failedBatches: 0 }
  private buffer: string[] = []
  private bufferBytes = 0
  private timer: NodeJS.Timeout | null = null
  private inFlight = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly config: Config, auth?: AuthClient) {
    this.auth = auth ?? new AuthClient(config)
  }

  /** Authenticates for the first time. Records enqueued meanwhile wait for the answer. */
  start(): void {
    void this.auth.start().catch((error) => debug('auth start failed:', error))
  }

  get paused(): boolean {
    return this.auth.paused
  }

  get buffered(): number {
    return this.buffer.length
  }

  enqueue(records: WireRecord[], options: EnqueueOptions = {}): void {
    if (records.length === 0) return
    if (this.closed || this.auth.paused) {
      this.stats.dropped += records.length
      return
    }

    const serialised: string[] = []
    for (const record of records) {
      try {
        serialised.push(JSON.stringify(record))
      } catch (error) {
        this.stats.dropped++
        debug('record could not be serialised:', error)
      }
    }
    if (serialised.length === 0) return

    if (options.immediate && this.inFlight.size < this.config.maxInFlight) {
      this.send(serialised)
      return
    }

    for (const json of serialised) {
      this.buffer.push(json)
      this.bufferBytes += Buffer.byteLength(json)
    }
    while (this.buffer.length > this.config.maxBufferRecords) {
      const oldest = this.buffer.shift() as string
      this.bufferBytes -= Buffer.byteLength(oldest)
      this.stats.dropped++
    }

    if (
      options.immediate ||
      this.buffer.length >= this.config.maxBatchRecords ||
      this.bufferBytes >= this.config.maxBatchBytes
    ) {
      this.pump(true)
    } else if (this.timer === null) {
      // 5 s after the first record entered an empty buffer.
      this.timer = setTimeout(() => {
        this.timer = null
        this.pump(true)
      }, this.config.flushIntervalMs)
      this.timer.unref()
    }
  }

  /**
   * Sends everything buffered and waits for the requests to finish, for at most `budgetMs` (no limit when omitted).
   * Never rejects.
   */
  async flush(budgetMs?: number): Promise<void> {
    const deadline = budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + budgetMs
    try {
      for (;;) {
        this.pump(true)
        if (this.inFlight.size === 0 && this.buffer.length === 0) return
        const remaining = deadline - Date.now()
        if (remaining <= 0) return
        let timeout: NodeJS.Timeout | undefined
        const waits: Promise<unknown>[] = [...this.inFlight]
        if (Number.isFinite(remaining)) {
          waits.push(
            new Promise((resolve) => {
              timeout = setTimeout(resolve, remaining)
            }),
          )
        }
        await Promise.race(waits)
        if (timeout) clearTimeout(timeout)
      }
    } catch (error) {
      debug('flush failed:', error)
    }
  }

  /** Final flush with the shutdown budget (2 s), then stops the timers. Later records are dropped. */
  async shutdown(): Promise<void> {
    await this.flush(this.config.shutdownBudgetMs)
    this.close()
  }

  /**
   * Last resort for the `exit` event, where nothing asynchronous can run any more: posts what is still buffered from
   * a short-lived child process and waits for it, for at most `budgetMs`.
   */
  flushSync(budgetMs: number = this.config.shutdownBudgetMs): void {
    try {
      const details = this.auth.peek()
      if (this.buffer.length === 0 || details === null) return
      const records = this.buffer
      this.buffer = []
      this.bufferBytes = 0
      const body = gzipSync(`{"records":[${records.join(',')}]}`)
      spawnSync(process.execPath, ['-e', SYNC_SENDER], {
        input: body,
        timeout: budgetMs,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          DOXA_WATCH_SYNC_REQUEST: JSON.stringify({ url: details.ingestUrl, headers: this.headers(details.token) }),
        },
      })
    } catch (error) {
      debug('synchronous flush failed:', error)
    }
  }

  private close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.auth.stop()
  }

  /** Starts as many requests as the concurrency limit allows. `force` sends a partial batch. */
  private pump(force: boolean): void {
    while (this.buffer.length > 0 && this.inFlight.size < this.config.maxInFlight) {
      const due =
        force || this.buffer.length >= this.config.maxBatchRecords || this.bufferBytes >= this.config.maxBatchBytes
      if (!due) return

      const batch: string[] = []
      let bytes = 0
      while (this.buffer.length > 0 && batch.length < this.config.maxBatchRecords) {
        const size = Buffer.byteLength(this.buffer[0] as string)
        // 1 MB is soft: a single larger record still goes out on its own.
        if (batch.length > 0 && bytes + size > this.config.maxBatchBytes) break
        batch.push(this.buffer.shift() as string)
        bytes += size
      }
      this.bufferBytes -= bytes
      this.send(batch)
    }

    if (this.buffer.length === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private send(batch: string[]): void {
    const request: Promise<void> = this.post(batch)
      .catch((error) => {
        this.stats.failedBatches++
        this.stats.dropped += batch.length
        debug('ingest failed:', error instanceof Error ? error.message : error)
      })
      .finally(() => {
        this.inFlight.delete(request)
        // Whatever piled up behind the concurrency limit goes next; only full batches unless a timer is due.
        if (this.buffer.length > 0) this.pump(this.timer === null)
      })
    this.inFlight.add(request)
  }

  private headers(token: string): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-encoding': 'gzip',
      'content-type': 'application/json',
      'nightwatch-server': this.config.server,
      'user-agent': userAgent(this.config.framework),
    }
  }

  private async post(batch: string[]): Promise<void> {
    const details = await this.auth.details()
    if (details === null) throw new Error('No authentication details')

    const body = await compress(`{"records":[${batch.join(',')}]}`)
    this.stats.batches++
    const response = await post(details.ingestUrl, {
      headers: this.headers(details.token),
      body,
      connectTimeoutMs: this.config.connectTimeoutMs,
      timeoutMs: this.config.requestTimeoutMs,
    })
    const answer = parseObject(response.body)

    // `stop` pauses ingestion whatever the status code: discard the buffer and wait for the next successful auth.
    if (answer.stop === true) {
      this.stats.dropped += this.buffer.length
      this.buffer = []
      this.bufferBytes = 0
      this.auth.pause(typeof answer.refresh_in === 'number' ? answer.refresh_in : undefined)
      throw new Error(`paused by the server: ${response.status} [${truncateMessage(answer.message)}]`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${response.status} [${truncateMessage(answer.message)}]`)
    }
    this.stats.sent += batch.length
    debug(`ingest successful: ${batch.length} records`)
  }
}
