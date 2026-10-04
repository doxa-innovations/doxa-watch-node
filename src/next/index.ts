// doxa-watch/next — the Next.js server hook-in (Node.js runtime). The Edge runtime resolves `./edge` instead.
//
//   // instrumentation.ts
//   export { register, onRequestError } from 'doxa-watch/next'
//
//   // next.config.ts
//   export default withDoxaWatch(nextConfig)
export { register, type NextRegisterOptions } from './register'
export { onRequestError, type ErrorRequest, type RequestErrorContext } from './on-request-error'
export { withDoxaWatch, EXTERNAL_PACKAGES } from './with-doxa-watch'
export { DoxaWatchSpanProcessor } from './span-processor'
