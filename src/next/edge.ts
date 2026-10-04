// doxa-watch/next for the Edge runtime (the `edge-light` export condition): the same names, doing nothing.
// `instrumentation.ts` is compiled for both runtimes; this keeps Node-only code out of the Edge bundle.
export { withDoxaWatch, EXTERNAL_PACKAGES } from './with-doxa-watch'

export function register(_options?: Record<string, unknown>): void {}

export async function onRequestError(_error?: unknown, _request?: unknown, _context?: unknown): Promise<void> {}

export class DoxaWatchSpanProcessor {
  onStart(): void {}
  onEnd(): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

export type NextRegisterOptions = Record<string, unknown>
