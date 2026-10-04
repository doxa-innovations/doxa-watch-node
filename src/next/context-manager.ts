import { AsyncLocalStorage } from 'node:async_hooks'
import { type Context, type ContextManager, ROOT_CONTEXT } from '@opentelemetry/api'

/**
 * The smallest OpenTelemetry context manager that works: without one, `context.active()` is always the root, Next
 * cannot find its own root span from inside a request, and `next.route` never reaches it.
 */
export class AlsContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>()

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(context, () => fn.call(thisArg, ...args))
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target !== 'function') return target
    const manager = this
    const original = target as unknown as (...args: unknown[]) => unknown
    return function bound(this: unknown, ...args: unknown[]): unknown {
      return manager.storage.run(context, () => original.apply(this, args))
    } as unknown as T
  }

  enable(): this {
    return this
  }

  disable(): this {
    this.storage.disable()
    return this
  }
}
