import { isActive, loadConfig } from '../config'
import { AuthClient } from '../transport/auth'

/**
 * `doxa-watch status` — checks that Doxa Watch is reachable and accepts the token (one `/api/agent-auth` call).
 * Exit code 0 when it does, 1 otherwise.
 */
export async function status(print: (line: string) => void = console.log): Promise<number> {
  const config = loadConfig()
  if (!config.enabled) {
    print('doxa-watch: disabled (DOXA_WATCH_ENABLED is false).')
    return 1
  }
  if (!isActive(config)) {
    print('doxa-watch: DOXA_WATCH_TOKEN is not set.')
    return 1
  }

  const auth = new AuthClient(config)
  try {
    await auth.start()
    const details = auth.peek()
    if (details !== null) {
      print(`doxa-watch: ${config.baseUrl} accepted the token; records go to ${details.ingestUrl}.`)
      return 0
    }
    print(`doxa-watch: ${config.baseUrl} did not accept the token: ${auth.lastError || 'unknown error'}`)
    return 1
  } finally {
    auth.stop()
  }
}
