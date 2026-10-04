import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURES = ['next15', 'next16'] as const
export type Fixture = (typeof FIXTURES)[number]

export function fixtureDir(fixture: Fixture): string {
  return join(ROOT, 'fixtures', fixture)
}

export function standaloneDir(fixture: Fixture): string {
  return join(fixtureDir(fixture), '.next', 'standalone')
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1' } })
}

/** Builds the SDK and packs it to `.pack/doxa-watch.tgz`, the path the fixtures depend on. */
export function packSdk(): void {
  const pack = join(ROOT, '.pack')
  mkdirSync(pack, { recursive: true })
  for (const file of readdirSync(pack)) rmSync(join(pack, file))
  run('npm', ['pack', '--pack-destination', pack], ROOT) // `prepack` runs the build
  const tarball = readdirSync(pack).find((file) => file.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('npm pack produced no tarball')
  renameSync(join(pack, tarball), join(pack, 'doxa-watch.tgz'))
}

/** Installs the freshly packed SDK into the fixture and builds it (`output: "standalone"`). */
export function buildFixture(fixture: Fixture): void {
  const dir = fixtureDir(fixture)
  // Same version, new content: make npm unpack the tarball again.
  rmSync(join(dir, 'node_modules', 'doxa-watch'), { recursive: true, force: true })
  rmSync(join(dir, '.next'), { recursive: true, force: true })
  run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', '--prefer-offline'], dir)
  run('npm', ['run', 'build'], dir) // next build && doxa-watch postbuild
  if (!existsSync(join(standaloneDir(fixture), 'server.js'))) throw new Error(`${fixture}: no standalone server.js after the build`)
}

export function nextVersion(fixture: Fixture): string {
  return (JSON.parse(readFileSync(join(fixtureDir(fixture), 'node_modules/next/package.json'), 'utf8')) as { version: string }).version
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolvePort(port))
    })
  })
}

export interface RunningApp {
  url: string
  process: ChildProcess
  /** stdout and stderr so far. */
  output: () => string
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>
  stop: () => Promise<void>
}

/** Runs `node server.js` from the fixture's standalone output, the way the production image does. */
export async function startApp(fixture: Fixture, env: Record<string, string>): Promise<RunningApp> {
  const port = await freePort()
  let output = ''
  // Only what a container would have: no DOXA_WATCH_* or CI variables leaking in from the developer's shell.
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('DOXA_WATCH_') && !['GIT_SHA', 'SOURCE_COMMIT', 'NODE_OPTIONS'].includes(key)) clean[key] = value
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: standaloneDir(fixture),
    env: { ...clean, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)))

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${fixture} server exited with ${child.exitCode}:\n${output}`)
    try {
      await fetch(`${url}/favicon.ico`)
      break
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error(`${fixture} server did not start:\n${output}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  return {
    url,
    process: child,
    output: () => output,
    exited,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    },
  }
}

const POSTGRES_LABEL = 'doxa-watch-e2e'
const POSTGRES_IMAGE = process.env.E2E_POSTGRES_IMAGE ?? 'postgres:16-alpine'

function docker(args: string[], timeout = 120_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim()
}

export interface ThrowawayPostgres {
  url: string
  stop: () => void
}

/**
 * Starts a throwaway Postgres container on a free local port and waits until it accepts connections.
 * Returns null — with the reason on stderr — when Docker cannot be used; the cases that need a database then skip.
 */
export function startPostgres(): ThrowawayPostgres | null {
  try {
    docker(['info', '--format', '{{.ServerVersion}}'], 15_000)
  } catch {
    console.warn('[e2e] Docker is not available: the pg cases are skipped.')
    return null
  }

  let id = ''
  const stop = (): void => {
    try {
      if (id !== '') docker(['rm', '-f', '-v', id], 30_000)
    } catch {
      // already gone
    }
  }

  try {
    // Containers a killed earlier run left behind.
    const stale = docker(['ps', '-aq', '--filter', `label=${POSTGRES_LABEL}`])
    if (stale !== '') docker(['rm', '-f', '-v', ...stale.split(/\s+/)], 30_000)

    id = docker(['run', '-d', '--rm', '--label', POSTGRES_LABEL, '-e', 'POSTGRES_PASSWORD=fixture', '-e', 'POSTGRES_DB=fixture_crm', '-p', '127.0.0.1::5432', POSTGRES_IMAGE])
    const port = /:(\d+)\s*$/m.exec(docker(['port', id, '5432/tcp']))?.[1]
    if (port === undefined) throw new Error('no published port')

    // During initialisation the server only listens on its socket, so a TCP answer means it is the real one.
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        docker(['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'fixture_crm'], 10_000)
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        execFileSync('sleep', ['0.3'])
      }
    }
    return { url: `postgres://postgres:fixture@127.0.0.1:${port}/fixture_crm`, stop }
  } catch (error) {
    stop()
    console.warn(`[e2e] Postgres could not be started (${error instanceof Error ? error.message.split('\n')[0] : String(error)}): the pg cases are skipped.`)
    return null
  }
}
