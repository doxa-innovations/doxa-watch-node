// doxa-watch — core entry point (framework-free). See README.md for the manual API.
export { watch, type Watch } from './api'
export { register, type RegisterOptions } from './register'
export {
  loadConfig,
  isActive,
  LOG_LEVELS,
  DEFAULT_BASE_URL,
  DEFAULT_REDACT_HEADERS,
  type Config,
  type ConfigOverrides,
  type Framework,
  type LogLevel,
  type RedactableQuery,
  type RedactableRequest,
  type RequestInfo,
  type WatchUser,
} from './config'
export { Transport, type EnqueueOptions, type TransportStats } from './transport/transport'
export { AuthClient, backoffSeconds, type IngestDetails } from './transport/auth'
export {
  Execution,
  EXECUTION_BUFFER,
  runExecution,
  currentExecution,
  currentContext,
  emit,
  type ExecutionInit,
} from './execution'
export { getRuntime, processContext, type RecordSink, type Runtime } from './runtime'
export { captureError, type CaptureOptions } from './capture'
export * from './records'
export { parseStack, type RawFrame } from './stacktrace/parse'
export { resolveStack, isVendorPath, clearSourceMapCache, type ResolveOptions } from './stacktrace/sourcemaps'
export { instrumentPg } from './sensors/pg'
export { instrumentNodemailer } from './sensors/nodemailer'
export type { JobOptions, ScheduledTaskOptions } from './manual'
export { requestState, isIgnoredPath, TUNNEL_PATH, type RequestState } from './sensors/http'
export { SDK_VERSION, userAgent } from './version'
