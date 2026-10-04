import { SDK_VERSION } from '../version'
import { parseArgs } from './args'
import { deploy } from './deploy'
import { postbuild } from './postbuild'
import { status } from './status'

const USAGE = `doxa-watch ${SDK_VERSION}

Usage:
  doxa-watch deploy [deploy] [--ref <git ref>] [--name <name>] [--url <link>]
      Tell Doxa Watch that a deploy happened. Always exits 0.
  doxa-watch postbuild [--dist-dir .next]
      Run after \`next build\`: copies the server source maps into the standalone output.
  doxa-watch status
      Check that Doxa Watch is reachable and accepts DOXA_WATCH_TOKEN.

Environment: DOXA_WATCH_TOKEN, DOXA_WATCH_BASE_URL, DOXA_WATCH_DEPLOY (or GIT_SHA, SOURCE_COMMIT).`

// Commands by name.
const commands: Record<string, (argv: string[]) => Promise<number>> = {
  deploy: (argv) => deploy(parseArgs(argv)),
  postbuild: (argv) => postbuild(parseArgs(argv)),
  status: () => status(),
}

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2)
  const command = name === undefined ? undefined : commands[name]
  if (command === undefined) {
    console.log(USAGE)
    process.exitCode = name === undefined || name === 'help' || name === '--help' ? 0 : 1
    return
  }
  process.exitCode = await command(rest)
}

main().catch((error) => {
  console.error(`doxa-watch: ${error instanceof Error ? error.message : String(error)}`)
  // `deploy` must never fail a pipeline.
  process.exitCode = process.argv[2] === 'deploy' ? 0 : 1
})
