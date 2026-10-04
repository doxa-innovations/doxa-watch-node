import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cli/args'
import { deploy, deployTimestamp } from '../src/cli/deploy'
import { status } from '../src/cli/status'
import { FakeServer } from './helpers/fake-server'

let server: FakeServer
let lines: string[]
const print = (line: string) => void lines.push(line)
const saved = { ...process.env }

beforeEach(async () => {
  server = await new FakeServer().start()
  lines = []
  for (const key of Object.keys(process.env)) if (key.startsWith('DOXA_WATCH_') || key === 'GIT_SHA' || key === 'SOURCE_COMMIT') delete process.env[key]
  process.env.DOXA_WATCH_BASE_URL = server.url
  process.env.DOXA_WATCH_TOKEN = 'env-token'
})
afterEach(async () => {
  process.env = { ...saved }
  await server.stop()
})

describe('parseArgs', () => {
  it.each([
    [['v1', '--ref', 'abc', '--name=Release 1', '--url', 'https://x.test/1'], { positional: ['v1'], options: { ref: 'abc', name: 'Release 1', url: 'https://x.test/1' } }],
    [['--force', '--ref', 'abc'], { positional: [], options: { force: 'true', ref: 'abc' } }],
    [[], { positional: [], options: {} }],
  ])('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected)
  })
})

describe('deploy', () => {
  it('posts PROTOCOL §3 with the environment token', async () => {
    expect(await deploy(parseArgs(['v1.2.3', '--ref', 'abcd1234', '--url', 'https://x.test/1']), print)).toBe(0)
    expect(server.deployments).toHaveLength(1)
    const request = server.deployments[0]!
    expect(request.headers).toMatchObject({ authorization: 'Bearer env-token', 'content-type': 'application/json', accept: 'application/json' })
    expect(request.headers['user-agent']).toMatch(/^DoxaWatchNode\//)
    const body = JSON.parse(request.body.toString()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['timestamp', 'deploy', 'ref', 'name', 'url'])
    expect(body).toMatchObject({ deploy: 'v1.2.3', ref: 'abcd1234', name: null, url: 'https://x.test/1' })
    expect(body.timestamp).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/)
    expect(lines[0]).toContain('reported')
  })

  it('formats the timestamp as Y-m-d H:i:s.u in UTC', () => {
    expect(deployTimestamp(new Date('2025-12-22T15:30:45.123Z'))).toBe('2025-12-22 15:30:45.123000')
  })

  it('takes the deploy value from the environment when no argument is given', async () => {
    process.env.GIT_SHA = 'sha-from-ci'
    await deploy(parseArgs([]), print)
    expect(JSON.parse(server.deployments[0]!.body.toString())).toMatchObject({ deploy: 'sha-from-ci', ref: null })
  })

  it.each([
    ['the server refuses', () => { server.onDeployment = () => ({ status: 422, body: { message: 'Unknown environment' } }) }, 'Unknown environment'],
    ['the server is unreachable', () => { process.env.DOXA_WATCH_BASE_URL = 'http://127.0.0.1:1' }, 'not reported'],
    ['the token is missing', () => { delete process.env.DOXA_WATCH_TOKEN }, 'DOXA_WATCH_TOKEN is not set'],
  ])('always exits 0: %s', async (_name, arrange, message) => {
    arrange()
    expect(await deploy(parseArgs(['v1']), print)).toBe(0)
    expect(lines.join('\n')).toContain(message)
  })
})

describe('status', () => {
  it('exits 0 when the token is accepted', async () => {
    expect(await status(print)).toBe(0)
    expect(lines[0]).toContain(`${server.url}/api/ingest`)
  })

  it.each([
    ['the token is refused', () => { server.onAuth = () => ({ status: 401, body: { message: 'Invalid environment token' } }) }, 'Invalid environment token'],
    ['the token is missing', () => { delete process.env.DOXA_WATCH_TOKEN }, 'DOXA_WATCH_TOKEN is not set'],
    ['it is disabled', () => { process.env.DOXA_WATCH_ENABLED = 'false' }, 'disabled'],
  ])('exits 1 when %s', async (_name, arrange, message) => {
    arrange()
    expect(await status(print)).toBe(1)
    expect(lines.join('\n')).toContain(message)
  })
})
