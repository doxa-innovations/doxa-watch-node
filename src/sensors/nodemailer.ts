import { debug } from '../debug'
import { currentExecution } from '../execution'
import { micros, now } from '../records/common'
import { buildMail } from '../records/mail'
import { getRuntime, processContext } from '../runtime'
import { WRAPPED, requireFromApp } from './pg'

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown

interface TransporterLike {
  sendMail?: unknown
  transporter?: { name?: unknown }
}

interface MailOptionsLike {
  subject?: unknown
  to?: unknown
  cc?: unknown
  bcc?: unknown
  attachments?: unknown
  watch?: unknown
}

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

/** Addresses in one header value: commas (and semicolons) separate, except inside quotes, `<…>` and comments. */
function countInText(text: string): number {
  let count = 0
  let pending = false
  let quoted = false
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (quoted) {
      if (char === '\\') index++
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      pending = true
    } else if (char === '<' || char === '(') {
      depth++
      pending = true
    } else if (char === '>' || char === ')') {
      depth = Math.max(0, depth - 1)
    } else if ((char === ',' || char === ';') && depth === 0) {
      if (pending) count++
      pending = false
    } else if (char === ':' && depth === 0) {
      // `Group name: a@x, b@y;` — the name is not an address.
      pending = false
    } else if (char.trim() !== '') {
      pending = true
    }
  }
  return pending ? count + 1 : count
}

/**
 * How many recipients a nodemailer address field holds: a string (`"a@x, B <b@y>"`), an address object
 * (`{ name, address }`) or an array of either. Only the number is used; the addresses stay in the process.
 */
export function countAddresses(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return countInText(value)
  if (Array.isArray(value)) return value.reduce((total: number, item: unknown) => total + countAddresses(item), 0)
  if (typeof value === 'object') {
    const address = (value as { address?: unknown }).address
    return typeof address === 'string' ? countInText(address) : 0
  }
  return 0
}

function wrapSendMail(original: AnyFunction): AnyFunction {
  const sendMail = function sendMail(this: TransporterLike, ...args: unknown[]): unknown {
    let finish: ((failed: boolean) => void) | undefined
    let next = args
    let viaCallback = false

    try {
      const data = args[0]
      let name = ''
      if (data !== null && typeof data === 'object' && 'watch' in data) {
        // `watch: { name }` is for this SDK only: nodemailer never sees it.
        const { watch: meta, ...rest } = data as MailOptionsLike & Record<string, unknown>
        next = [rest, ...args.slice(1)]
        const given = meta !== null && typeof meta === 'object' ? (meta as { name?: unknown }).name : undefined
        if (typeof given === 'string') name = given
      }

      const runtime = getRuntime()
      if (runtime.sink !== null && !runtime.config.ignoreMail) {
        const options = (data !== null && typeof data === 'object' ? data : {}) as MailOptionsLike
        const execution = currentExecution()
        const started = micros()
        const transport = this.transporter?.name
        let done = false

        finish = (failed) => {
          if (done) return
          done = true
          try {
            const { sink } = getRuntime()
            if (sink === null) return
            const record = buildMail(execution?.context() ?? processContext(), {
              timestamp: now(),
              mailer: typeof transport === 'string' ? transport : '',
              class: name,
              subject: typeof options.subject === 'string' ? options.subject : '',
              to: countAddresses(options.to),
              cc: countAddresses(options.cc),
              bcc: countAddresses(options.bcc),
              attachments: Array.isArray(options.attachments) ? options.attachments.length : 0,
              duration: micros() - started,
              failed,
            })
            if (execution !== undefined) execution.add(record)
            else sink.enqueue([record])
          } catch (error) {
            debug('recording a mail failed:', error)
          }
        }

        const index = next.findIndex((arg, position) => position > 0 && isFunction(arg))
        if (index !== -1) {
          const callback = next[index] as AnyFunction
          const report = finish
          next = [...next]
          next[index] = function (this: unknown, ...results: unknown[]): unknown {
            report(results[0] !== null && results[0] !== undefined)
            return callback.apply(this, results)
          }
          viaCallback = true
        }
      }
    } catch (error) {
      debug('observing a mail failed:', error)
      finish = undefined
    }

    if (finish === undefined) return original.apply(this, next)

    const report = finish
    let result: unknown
    try {
      result = original.apply(this, next)
    } catch (error) {
      report(true)
      throw error
    }
    if (!viaCallback && result !== null && typeof result === 'object' && isFunction((result as { then?: unknown }).then)) {
      return (result as Promise<unknown>).then(
        (value) => {
          report(false)
          return value
        },
        (error: unknown) => {
          report(true)
          throw error
        },
      )
    }
    return result
  }
  return mark(sendMail as AnyFunction)
}

function instrumentTransporter(transporter: unknown): boolean {
  if (transporter === null || typeof transporter !== 'object') return false
  // `sendMail` lives on the transporter's class: patched once, it covers every transporter of that copy of nodemailer.
  let owner = transporter as Record<string, unknown> | null
  while (owner !== null && owner !== Object.prototype && !Object.prototype.hasOwnProperty.call(owner, 'sendMail')) {
    owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null
  }
  if (owner === null || owner === Object.prototype) return false
  const original = owner.sendMail
  if (!isFunction(original)) return false
  if (!isWrapped(original)) owner.sendMail = wrapSendMail(original)
  return true
}

/**
 * Records every message sent through nodemailer as a `mail` record: transport name, subject, the number of
 * recipients and attachments, the duration and whether sending failed — never an address. `register()` does this by
 * itself when `nodemailer` can be resolved from the app; call it with your own `nodemailer` import (or with a
 * transporter) when nodemailer is bundled into the server. Safe to call more than once. Returns whether it worked.
 *
 * Name a message with `watch: { name: 'Welcome' }` in the mail options; the key is removed before nodemailer sees it.
 */
export function instrumentNodemailer(nodemailer: unknown): boolean {
  try {
    if (nodemailer === null || nodemailer === undefined) return false
    if (isFunction((nodemailer as TransporterLike).sendMail)) return instrumentTransporter(nodemailer)

    // The CommonJS exports object first: an ES module namespace (`import * as nodemailer`) cannot be assigned to.
    const candidates = [(nodemailer as { default?: unknown }).default, nodemailer]
    for (const candidate of candidates) {
      if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function')) continue
      const module = candidate as { createTransport?: unknown }
      const original = module.createTransport
      if (!isFunction(original)) continue
      if (isWrapped(original)) return true
      const createTransport = function createTransport(this: unknown, ...args: unknown[]): unknown {
        const transporter = original.apply(this, args)
        try {
          instrumentTransporter(transporter)
        } catch (error) {
          debug('instrumenting a nodemailer transporter failed:', error)
        }
        return transporter
      }
      try {
        module.createTransport = mark(createTransport as AnyFunction)
        return true
      } catch {
        // read-only: try the next candidate
      }
    }
    return false
  } catch (error) {
    debug('instrumenting nodemailer failed:', error)
    return false
  }
}

/** Instruments nodemailer when the app has it; silently does nothing otherwise (it is an optional peer). */
export function installNodemailerSensor(): void {
  const runtime = getRuntime()
  if (runtime.installed.has('nodemailer')) return
  runtime.installed.add('nodemailer')
  const nodemailer = requireFromApp('nodemailer')
  if (nodemailer === undefined) return
  if (instrumentNodemailer(nodemailer)) debug('nodemailer instrumented')
}
