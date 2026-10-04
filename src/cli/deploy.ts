import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { parseObject, post, truncateMessage } from '../transport/http'
import { SDK_VERSION } from '../version'
import type { ParsedArgs } from './args'

/** `Y-m-d H:i:s.u`, UTC (PROTOCOL §3). */
export function deployTimestamp(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 23).replace('T', ' ')}000`
}

function buildId(cwd: string): string {
  try {
    return readFileSync(join(cwd, '.next', 'BUILD_ID'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * `doxa-watch deploy [deploy] [--ref] [--name] [--url]` — PROTOCOL §3. Always resolves to exit code 0, so it can
 * never break a deploy pipeline.
 */
export async function deploy(args: ParsedArgs, print: (line: string) => void = console.log): Promise<number> {
  try {
    const config = loadConfig()
    const name = args.positional[0] ?? (config.deploy || buildId(process.cwd()))

    if (config.token === '') {
      print('doxa-watch: DOXA_WATCH_TOKEN is not set; the deploy was not reported.')
      return 0
    }
    if (name === '') {
      print('doxa-watch: no deploy value (argument, DOXA_WATCH_DEPLOY, GIT_SHA, SOURCE_COMMIT or .next/BUILD_ID); the deploy was not reported.')
      return 0
    }

    const response = await post(`${config.baseUrl}/api/deployments`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'user-agent': `DoxaWatchNode/${SDK_VERSION} (node/${process.versions.node})`,
      },
      body: JSON.stringify({
        timestamp: deployTimestamp(),
        deploy: name,
        ref: args.options.ref ?? null,
        name: args.options.name ?? null,
        url: args.options.url ?? null,
      }),
      connectTimeoutMs: config.connectTimeoutMs,
      timeoutMs: config.requestTimeoutMs,
    })

    if (response.status >= 200 && response.status < 300) {
      print(`doxa-watch: deploy "${name}" reported.`)
    } else {
      const message = truncateMessage(parseObject(response.body).message)
      print(`doxa-watch: the deploy was not reported: ${message || `[${response.status}] ${response.body.slice(0, 1000)}`}`)
    }
  } catch (error) {
    print(`doxa-watch: the deploy was not reported: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 0
}
