import { EventEmitter } from 'node:events'

type Callback = (error: Error | undefined | null, result?: unknown) => void

interface QueryConfig {
  text?: string
  values?: unknown[]
  callback?: Callback
  name?: string
}

/** What `pg`'s `Query` does with its arguments, including writing the callback onto the config object. */
export class FakeQuery extends EventEmitter {
  text: string
  values: unknown[] | undefined
  callback: Callback | undefined

  constructor(config: string | QueryConfig, values?: unknown[] | Callback, callback?: Callback) {
    super()
    const normalised: QueryConfig = typeof config === 'string' ? { text: config } : config
    if (values) {
      if (typeof values === 'function') normalised.callback = values
      else normalised.values = values
    }
    if (callback) normalised.callback = callback
    this.text = normalised.text as string
    this.values = normalised.values
    this.callback = normalised.callback
  }

  submit(): void {}

  settle(): void {
    if (this.text.includes('no_such_table')) {
      const error = Object.assign(new Error('relation "no_such_table" does not exist'), { code: '42P01' })
      if (this.callback) this.callback(error)
      else this.emit('error', error)
      return
    }
    const result = { rows: [{ text: this.text }], rowCount: 1 }
    if (this.callback) this.callback(null, result)
    this.emit('end', result)
  }
}

/**
 * The call semantics of `pg.Client#query` (pg 8, lib/client.js) without a database: the same argument handling,
 * the same return values, and results delivered from a context that is not the caller's.
 */
export class FakeClient {
  database = 'crm'
  /** Everything the "server" was sent. */
  static received: { text: string; values: unknown[] | undefined }[] = []

  query(config: unknown, values?: unknown, callback?: unknown): any {
    let query: FakeQuery
    let result: unknown
    if (config === null || config === undefined) throw new TypeError('Client was passed a null or undefined query')
    if (typeof (config as FakeQuery).submit === 'function') {
      result = query = config as FakeQuery
      if (typeof values === 'function') query.callback = query.callback || (values as Callback)
    } else {
      query = new FakeQuery(config as QueryConfig, values as unknown[], callback as Callback)
      if (!query.callback) {
        result = new Promise((resolve, reject) => {
          query.callback = (error, rows) => (error ? reject(error) : resolve(rows))
        })
      }
    }
    FakeClient.received.push({ text: query.text, values: query.values })
    dispatcher.push(() => query.settle())
    return result
  }
}

/** Runs queued work from a timer created outside every execution, like a socket that was opened earlier. */
class Dispatcher {
  private queue: (() => void)[] = []
  private timer: NodeJS.Timeout | undefined

  start(): void {
    this.timer ??= setInterval(() => {
      const work = this.queue
      this.queue = []
      for (const item of work) item()
    }, 1)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  push(work: () => void): void {
    this.queue.push(work)
  }
}

export const dispatcher = new Dispatcher()

/** pg-pool's `connect` and `query`: `query` checks a client out and calls ITS `query`, from a later tick. */
class BasePool {
  Client = FakeClient

  connect(callback?: (error: Error | undefined, client?: FakeClient, release?: () => void) => void): unknown {
    const client = new this.Client()
    if (callback === undefined) return new Promise((resolve) => dispatcher.push(() => resolve(client)))
    dispatcher.push(() => callback(undefined, client, () => {}))
    return undefined
  }

  query(text: unknown, values?: unknown, callback?: Callback): unknown {
    let done = callback
    let parameters = values
    if (typeof values === 'function') {
      done = values as Callback
      parameters = undefined
    }
    let result: unknown
    if (done === undefined) {
      result = new Promise((resolve, reject) => {
        done = (error, rows) => (error ? reject(error) : resolve(rows))
      })
    }
    this.connect((error, client) => {
      if (error || client === undefined) return (done as Callback)(error)
      client.query(text, parameters, (failure: Error | undefined, rows: unknown) => (done as Callback)(failure, rows))
    })
    return result
  }
}

/** Like `pg.Pool`: a subclass, so `connect` and `query` are not its own properties. */
export class FakePool extends BasePool {}

export const fakePg = { Client: FakeClient, Pool: FakePool, Query: FakeQuery }
