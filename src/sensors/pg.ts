import { createRequire } from 'node:module'
import { join } from 'node:path'
import { debug } from '../debug'
import { type Execution, currentExecution } from '../execution'
import { micros, now } from '../records/common'
import { buildQuery } from '../records/query'
import { getRuntime, processContext } from '../runtime'
import { resolveStack } from '../stacktrace/sourcemaps'

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown

/** Marks a function this sensor put in place, so nothing is wrapped twice (also across copies of the package). */
export const WRAPPED = Symbol.for('doxa-watch.wrapped')

interface PgClientLike {
  database?: unknown
  connectionParameters?: { database?: unknown }
}

interface QueryConfigLike {
  text?: unknown
  callback?: unknown
  submit?: unknown
  emit?: unknown
  cursor?: { text?: unknown }
}

/** A captured call site: the stack is only formatted (and resolved) when the record is built. */
interface CallSite {
  stack?: string
}

const STACK_DEPTH = 30
const MAX_CALL_SITES = 1000
// Packages that sit between the application and the driver: never the "caller" of a query.
const DRIVER_FRAME = /(^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:pg|pg-pool|pg-cursor|pg-query-stream|doxa-watch)\//

// Raw stack text → caller. One source-map lookup per distinct call site; afterwards a query costs one map read.
const callSites = new Map<string, { file: string; line: number }>()

/** `pool.query()` runs the client's query from a later tick, where the app's frames are gone: it leaves them here. */
let handover: CallSite | undefined

function isFunction(value: unknown): value is AnyFunction {
  return typeof value === 'function'
}

function isWrapped(value: unknown): boolean {
  return isFunction(value) && (value as unknown as Record<symbol, unknown>)[WRAPPED] === true
}

function mark<T extends AnyFunction>(wrapper: T): T {
  Object.defineProperty(wrapper, WRAPPED, { value: true })
  return wrapper
}

function captureCallSite(above: AnyFunction): CallSite {
  const site: CallSite = {}
  const limit = Error.stackTraceLimit
  try {
    // An ORM puts a dozen of its own frames between the app and the driver.
    Error.stackTraceLimit = STACK_DEPTH
    Error.captureStackTrace(site, above)
  } catch {
    // no stack: the query is recorded without a location
  } finally {
    try {
      Error.stackTraceLimit = limit
    } catch {
      // frozen intrinsics
    }
  }
  return site
}

/** First application frame of a captured stack; else the first frame outside the driver; else unknown. */
export function callerOf(site: CallSite | undefined): { file: string; line: number } {
  const unknown = { file: '', line: 0 }
  try {
    const stack = site?.stack
    if (typeof stack !== 'string' || stack === '') return unknown
    const cached = callSites.get(stack)
    if (cached !== undefined) return cached

    const { config } = getRuntime()
    const { frames } = resolveStack({ stack }, { projectRoot: config.projectRoot, mapDirs: config.sourceMapDirs, captureSource: false })
    const frame =
      frames.find((candidate) => !candidate.vendor) ??
      frames.find((candidate) => candidate.resolved && !DRIVER_FRAME.test(candidate.file) && !candidate.file.startsWith('node:'))
    const caller = frame === undefined ? unknown : { file: frame.file, line: frame.line }

    if (callSites.size >= MAX_CALL_SITES) callSites.delete(callSites.keys().next().value as string)
    callSites.set(stack, caller)
    return caller
  } catch (error) {
    debug('query caller lookup failed:', error)
    return unknown
  }
}

function databaseOf(client: PgClientLike): string {
  const name = client.database ?? client.connectionParameters?.database
  return typeof name === 'string' ? name : ''
}

/** Runs `callback` with the execution its query was started in: the driver calls back from the socket's context. */
function inExecution(execution: Execution | undefined, callback: AnyFunction, self: unknown, args: unknown[]): unknown {
  return getRuntime().als.run(execution as Execution, () => callback.apply(self, args))
}

interface Observation {
  /** The arguments to call the driver with (a callback, when there is one, is replaced by a reporting one). */
  args: unknown[]
  /** Called once the driver's `query` returned (or threw). */
  after: () => void
  /** Records the query; only the first call counts. */
  finish: () => void
  /** No callback anywhere: the driver returns a promise. */
  promised: boolean
}

function observe(client: PgClientLike, args: unknown[], wrapper: AnyFunction): Observation | undefined {
  const runtime = getRuntime()
  if (runtime.sink === null || runtime.config.ignoreQueries) {
    handover = undefined
    return undefined
  }

  const first = args[0]
  const config = first !== null && typeof first === 'object' ? (first as QueryConfigLike) : undefined
  const submittable = config !== undefined && isFunction(config.submit)
  const text = typeof first === 'string' ? first : (config?.text ?? config?.cursor?.text)
  if (typeof text !== 'string') {
    handover = undefined
    return undefined
  }

  const site = handover ?? captureCallSite(wrapper)
  handover = undefined
  const execution = currentExecution()
  const timestamp = now()
  const started = micros()
  let done = false

  const finish = (): void => {
    if (done) return
    done = true
    try {
      const { sink, config: settings } = getRuntime()
      if (sink === null) return
      const duration = micros() - started
      const query = { sql: text }
      // A redaction that fails must not let the unredacted statement out: the record is dropped instead.
      const sql = settings.redactQuery === undefined ? text : ((settings.redactQuery(query) ?? query).sql ?? '')
      const record = buildQuery(execution?.context() ?? processContext(), {
        timestamp,
        sql: String(sql),
        ...callerOf(site),
        duration,
        connection: databaseOf(client),
      })
      if (execution !== undefined) execution.add(record)
      else sink.enqueue([record])
    } catch (error) {
      debug('recording a query failed:', error)
    }
  }

  const reporting = (callback: AnyFunction): AnyFunction =>
    function (this: unknown, ...results: unknown[]): unknown {
      finish()
      return inExecution(execution, callback, this, results)
    }

  // The driver takes the callback from the last function argument, else from the config object.
  const next = [...args]
  const index = isFunction(next[2]) ? 2 : isFunction(next[1]) ? 1 : -1
  let after = (): void => {}
  let promised = false

  if (index !== -1) {
    const wrapped = reporting(next[index] as AnyFunction)
    next[index] = wrapped
    if (config !== undefined && !submittable) {
      // The driver copies the callback onto the app's config object: leave there what it would have left.
      const original = args[index]
      after = () => {
        try {
          if (config.callback === wrapped) config.callback = original
        } catch {
          // a frozen config object
        }
      }
    }
  } else if (config !== undefined && isFunction(config.callback)) {
    const original = config.callback
    try {
      config.callback = reporting(original)
    } catch {
      return undefined // a frozen config object: run the query untouched, unrecorded
    }
    // A plain config is read once, when the query is created; a submittable keeps its callback until it settles.
    if (!submittable) {
      after = () => {
        config.callback = original
      }
    }
  } else if (!submittable) {
    promised = true
  }

  if (submittable && isFunction(config?.emit)) {
    // A `Query`, cursor or stream handed to the client reports through its own events; listeners stay untouched.
    const emit = config.emit as AnyFunction
    const own = Object.prototype.hasOwnProperty.call(config, 'emit')
    try {
      config.emit = function (this: unknown, ...event: unknown[]): unknown {
        if (event[0] === 'end' || event[0] === 'error' || event[0] === 'close') {
          finish()
          // Settled: put back what was there.
          if (own) config.emit = emit
          else delete config.emit
        }
        return emit.apply(this, event)
      }
    } catch {
      // not patchable: the callback, when there is one, still reports
    }
  }

  return { args: next, after, finish, promised }
}

function wrapClientQuery(original: AnyFunction): AnyFunction {
  const query = function query(this: PgClientLike, ...args: unknown[]): unknown {
    let observation: Observation | undefined
    try {
      observation = observe(this, args, query as AnyFunction)
    } catch (error) {
      debug('observing a query failed:', error)
    }
    if (observation === undefined) return original.apply(this, args)

    let result: unknown
    try {
      result = original.apply(this, observation.args)
    } catch (error) {
      // The driver rejects malformed calls synchronously.
      observation.finish()
      throw error
    } finally {
      observation.after()
    }

    if (observation.promised && result !== null && typeof result === 'object' && isFunction((result as { then?: unknown }).then)) {
      const { finish } = observation
      return (result as Promise<unknown>).then(
        (value) => {
          finish()
          return value
        },
        (error: unknown) => {
          finish()
          throw error
        },
      )
    }
    return result
  }
  return mark(query as AnyFunction)
}

/** `pool.query(...)`: remembers the caller for the client query that the pool issues once it has a connection. */
function wrapPoolQuery(original: AnyFunction): AnyFunction {
  const query = function query(this: unknown, ...args: unknown[]): unknown {
    const runtime = getRuntime()
    if (runtime.sink === null || runtime.config.ignoreQueries) return original.apply(this, args)
    const previous = handover
    handover = captureCallSite(query as AnyFunction)
    try {
      return original.apply(this, args)
    } finally {
      handover = previous
    }
  }
  return mark(query as AnyFunction)
}

/**
 * `pool.connect(callback)`: the callback may run from another request's context (a client released there is handed
 * to the waiting caller), so it is run with the execution — and the pending `pool.query` call site — of its caller.
 */
function wrapPoolConnect(original: AnyFunction): AnyFunction {
  const connect = function connect(this: unknown, ...args: unknown[]): unknown {
    const callback = args[0]
    if (!isFunction(callback) || getRuntime().sink === null) return original.apply(this, args)
    const site = handover
    handover = undefined
    const execution = currentExecution()
    const bound = function (this: unknown, ...results: unknown[]): unknown {
      const previous = handover
      handover = site
      try {
        return inExecution(execution, callback, this, results)
      } finally {
        handover = previous
      }
    }
    return original.apply(this, [bound, ...args.slice(1)])
  }
  return mark(connect as AnyFunction)
}

/** The object on the prototype chain that owns `method` (pg's `Pool` is a subclass of pg-pool's). */
function ownerOf(prototype: unknown, method: string): Record<string, unknown> | undefined {
  let current = prototype as Record<string, unknown> | null | undefined
  while (current !== null && current !== undefined && current !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(current, method)) return current
    current = Object.getPrototypeOf(current) as Record<string, unknown> | null
  }
  return undefined
}

function patch(prototype: unknown, method: string, wrap: (original: AnyFunction) => AnyFunction): boolean {
  const owner = ownerOf(prototype, method)
  const original = owner?.[method]
  if (owner === undefined || !isFunction(original)) return false
  if (!isWrapped(original)) owner[method] = wrap(original)
  return true
}

/**
 * Records every query that goes through `pg` as a `query` record: the statement text with its placeholders (bind
 * values never leave the process), the database name, the duration and the application frame that issued it.
 * `register()` does this by itself when `pg` can be resolved from the app; call it with your own `pg` import when
 * `pg` is bundled into the server. Safe to call more than once. Returns whether `pg` was instrumented.
 */
export function instrumentPg(pg: unknown): boolean {
  try {
    const candidates = [pg, (pg as { default?: unknown } | null | undefined)?.default]
    const module = candidates.find(
      (candidate) => candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function') && isFunction((candidate as { Client?: unknown }).Client),
    ) as { Client: { prototype: unknown }; Pool?: { prototype: unknown } } | undefined
    if (module === undefined) return false

    if (!patch(module.Client.prototype, 'query', wrapClientQuery)) return false
    // Pooled queries reach the client's `query` exactly once; the pool is only patched to carry the caller across.
    if (isFunction(module.Pool)) {
      patch(module.Pool.prototype, 'query', wrapPoolQuery)
      patch(module.Pool.prototype, 'connect', wrapPoolConnect)
    }
    return true
  } catch (error) {
    debug('instrumenting pg failed:', error)
    return false
  }
}

/** Loads an optional peer the way the app would: from the project root, the working directory, then next to the SDK. */
export function requireFromApp(name: string): unknown {
  const bases: string[] = []
  try {
    bases.push(join(getRuntime().config.projectRoot, 'package.json'), join(process.cwd(), 'package.json'))
  } catch {
    // no working directory
  }
  try {
    bases.push(__filename)
  } catch {
    // no __filename in this module format
  }
  for (const base of bases) {
    try {
      return createRequire(base)(name)
    } catch {
      // not installed there
    }
  }
  return undefined
}

/** Instruments `pg` when the app has it; silently does nothing otherwise (`pg` is an optional peer). */
export function installPgSensor(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('pg')) return
  runtime.installed.add('pg')
  const pg = requireFromApp('pg')
  if (pg === undefined) return
  if (instrumentPg(pg)) debug('pg instrumented')
}
