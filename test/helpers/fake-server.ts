import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'

export interface Reply {
  status?: number
  body?: unknown
  /** Milliseconds to wait before answering. */
  delay?: number
  /** Never answer (the client times out). */
  hang?: boolean
}

export interface SeenRequest {
  path: string
  headers: IncomingMessage['headers']
  body: Buffer
}

export type WireRecord = Record<string, unknown> & { t: string }

/** A stand-in for Doxa Watch: `/api/agent-auth`, `/api/ingest`, `/api/deployments`, plus `/upstream/*` for fetch tests. */
export class FakeServer {
  server: Server
  url = ''
  auths: SeenRequest[] = []
  ingests: SeenRequest[] = []
  deployments: SeenRequest[] = []
  upstream: SeenRequest[] = []
  /** Every batch as received, decompressed and parsed. */
  batches: WireRecord[][] = []
  /** Override per test. */
  onAuth: (seen: SeenRequest, count: number) => Reply = () => ({ body: this.authBody() })
  onIngest: (seen: SeenRequest, count: number) => Reply = () => ({ body: {} })
  onDeployment: (seen: SeenRequest) => Reply = () => ({ body: {} })

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => this.handle(request, response, Buffer.concat(chunks)))
    })
  }

  get records(): WireRecord[] {
    return this.batches.flat()
  }

  of(type: string): WireRecord[] {
    return this.records.filter((record) => record.t === type)
  }

  authBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { token: 'short-lived', expires_in: 3600, refresh_in: 2700, ingest_url: `${this.url}/api/ingest`, ...extra }
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  reset(): void {
    this.auths = []
    this.ingests = []
    this.deployments = []
    this.upstream = []
    this.batches = []
  }

  /** Resolves once `predicate` holds, or rejects after `timeoutMs` with what was received. */
  async waitFor(predicate: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) {
        const summary = this.records.map((r) => `${r.t}${r.t === 'request' ? `(${String(r.url)})` : ''}`).join(', ')
        throw new Error(`timed out waiting for ${what}; records so far: [${summary}]`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  private handle(request: IncomingMessage, response: ServerResponse, body: Buffer): void {
    const seen: SeenRequest = { path: request.url ?? '', headers: request.headers, body }
    let reply: Reply

    if (seen.path === '/api/agent-auth') {
      this.auths.push(seen)
      reply = this.onAuth(seen, this.auths.length)
    } else if (seen.path === '/api/ingest') {
      this.ingests.push(seen)
      try {
        const parsed = JSON.parse(gunzipSync(body).toString('utf8')) as { records: WireRecord[] }
        this.batches.push(parsed.records)
      } catch {
        this.batches.push([])
      }
      reply = this.onIngest(seen, this.ingests.length)
    } else if (seen.path === '/api/deployments') {
      this.deployments.push(seen)
      reply = this.onDeployment(seen)
    } else if (seen.path.startsWith('/upstream')) {
      this.upstream.push(seen)
      reply = { status: seen.path.includes('missing') ? 404 : 200, body: { ok: true } }
    } else {
      reply = { status: 404, body: { message: 'not found' } }
    }

    if (reply.hang) return
    const send = (): void => {
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    if (reply.delay) setTimeout(send, reply.delay)
    else send()
  }
}
