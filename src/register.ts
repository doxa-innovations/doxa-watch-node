import { type Config, type ConfigOverrides, isActive, loadConfig } from './config'
import { debug, notice, setDebug } from './debug'
import { type Runtime, getRuntime } from './runtime'
import { installConsoleSensor } from './sensors/console'
import { installHttpSensor } from './sensors/http'
import { installNodemailerSensor } from './sensors/nodemailer'
import { installPgSensor } from './sensors/pg'
import { installProcessSensor, installShutdownHooks } from './sensors/process'
import { installUndiciSensor } from './sensors/undici'
import { Transport } from './transport/transport'
import { SDK_VERSION } from './version'

export type RegisterOptions = ConfigOverrides

/**
 * Starts the collector for this process: loads the configuration (environment, then `options`), authenticates, and
 * installs the sensors. Framework-free; `doxa-watch/next` wraps it. Safe to call more than once (the first call
 * wins) and never throws. Without `DOXA_WATCH_TOKEN` it prints one line and does nothing else.
 */
export function register(options: RegisterOptions = {}): Runtime {
  const runtime = getRuntime()
  if (runtime.registered) return runtime

  try {
    const config: Config = loadConfig(options)
    runtime.config = config
    runtime.registered = true
    setDebug(config.debug)

    if (!isActive(config)) {
      notice(
        config.enabled
          ? 'DOXA_WATCH_TOKEN is not set: nothing is collected or sent.'
          : 'DOXA_WATCH_ENABLED is false: nothing is collected or sent.',
      )
      return runtime
    }

    const transport = new Transport(config)
    runtime.sink = transport
    transport.start()

    // Sensors. Each is idempotent and wraps its own failures.
    installHttpSensor()
    installUndiciSensor()
    installConsoleSensor()
    installProcessSensor()
    installShutdownHooks()
    installPgSensor()
    installNodemailerSensor()

    debug(`doxa-watch ${SDK_VERSION} registered; reporting to ${config.baseUrl} as "${config.server}"`)
  } catch (error) {
    debug('register failed:', error)
  }
  return runtime
}
