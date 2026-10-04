import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceMapGenerator } from 'source-map-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearSourceMapCache, isVendorPath, resolveStack } from '../src/stacktrace/sourcemaps'
import { parseStack } from '../src/stacktrace/parse'

let root: string

const SOURCE = Array.from({ length: 20 }, (_, n) => `// original line ${n + 1}`).join('\n')

/** Writes `<root>/<built>` (unless `map` only) and `<mapPath>` mapping built line:column → source line. */
function writeMap(mapPath: string, source: string, mappings: [number, number, number][], content: string | null = SOURCE): void {
  const generator = new SourceMapGenerator({ file: 'built.js' })
  for (const [line, column, originalLine] of mappings) {
    generator.addMapping({ generated: { line, column }, original: { line: originalLine, column: 2 }, source })
  }
  if (content !== null) generator.setSourceContent(source, content)
  mkdirSync(join(mapPath, '..'), { recursive: true })
  writeFileSync(mapPath, generator.toString())
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'doxa-watch-stack-'))
  const server = join(root, '.next/server/app')
  mkdirSync(server, { recursive: true })

  // webpack-style source names
  writeMap(join(server, 'boom/page.js.map'), 'webpack://fixture/./app/boom/page.tsx', [[1, 100, 7], [1, 200, 12]])
  // turbopack-style source names
  writeMap(join(root, '.next/server/chunks/ssr/chunk.js.map'), 'turbopack:///[project]/app/api/boom/route.ts', [[5, 10, 3]])
  // a dependency inside a bundle
  writeMap(join(server, 'vendor.js.map'), 'webpack://fixture/./node_modules/left-pad/index.js', [[1, 0, 1]])
  // a relative source, as tsup/esbuild write them
  writeMap(join(root, 'dist/job.js.map'), '../src/job.ts', [[3, 0, 9]])
  // a map without embedded sources
  writeMap(join(server, 'nocontent.js.map'), 'webpack://fixture/./app/nocontent.ts', [[1, 0, 4]], null)
  // corrupt and empty maps
  writeFileSync(join(server, 'corrupt.js.map'), '{"version":3,"sources":["a.ts"],"mappings":"AAAA;;;%%%%not base64 vlq')
  writeFileSync(join(server, 'garbage.js.map'), 'this is not json')
  writeFileSync(join(server, 'null.js.map'), 'null')
  // browser maps moved away from the public folder
  writeMap(join(root, '.next/doxa-watch/maps/static/chunks/app/page-abc123.js.map'), 'webpack://_N_E/./app/page.tsx', [[1, 5000, 15]])
  // a plain Node script: no bundler, no map
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts/import.js'), Array.from({ length: 8 }, (_, n) => `const line${n + 1} = ${n + 1}`).join('\n'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => clearSourceMapCache())

const stackOf = (...frames: string[]) => ({ stack: ['Error: boom', ...frames.map((frame) => `    at ${frame}`)].join('\n') })
const built = (file: string) => join(root, '.next/server/app', file)

describe('parseStack', () => {
  it.each([
    ['a named function', 'Page (/app/.next/server/app/page.js:1:234)', { file: '/app/.next/server/app/page.js', line: 1, column: 234, function: 'Page' }],
    ['an async function', 'async Page (/app/a.js:10:5)', { file: '/app/a.js', line: 10, column: 5, function: 'Page' }],
    ['an anonymous location', '/app/a.js:10:5', { file: '/app/a.js', line: 10, column: 5, function: '' }],
    ['an async anonymous location', 'async /app/a.js:10:5', { file: '/app/a.js', line: 10, column: 5, function: '' }],
    ['a constructor', 'new Foo (/app/a.js:1:1)', { file: '/app/a.js', line: 1, column: 1, function: 'new Foo' }],
    ['a method', 'Object.handler [as GET] (file:///app/a.mjs:3:7)', { file: 'file:///app/a.mjs', line: 3, column: 7, function: 'Object.handler [as GET]' }],
    ['a Node internal', 'process.processTicksAndRejections (node:internal/process/task_queues:105:5)', { file: 'node:internal/process/task_queues', line: 105, column: 5, function: 'process.processTicksAndRejections' }],
    ['<anonymous>', 'Array.map (<anonymous>)', { file: '', line: 0, column: 0, function: 'Array.map' }],
    ['an eval frame', 'eval (eval at run (/app/a.js:4:9), <anonymous>:1:1)', { file: '/app/a.js', line: 4, column: 9, function: 'eval' }],
    ['a browser URL', 'onClick (https://crm.example.com/_next/static/chunks/app/page-abc123.js:1:5001)', { file: 'https://crm.example.com/_next/static/chunks/app/page-abc123.js', line: 1, column: 5001, function: 'onClick' }],
    ['a Windows path', 'run (C:\\app\\a.js:4:9)', { file: 'C:\\app\\a.js', line: 4, column: 9, function: 'run' }],
  ])('parses %s', (_name, line, expected) => {
    expect(parseStack(`Error: x\n    at ${line}`)).toEqual([expected])
  })

  it('parses Firefox/Safari frames and skips lines that are not frames', () => {
    expect(parseStack('onClick@https://x.test/a.js:10:20\n@https://x.test/b.js:1:2\nsome message line')).toEqual([
      { file: 'https://x.test/a.js', line: 10, column: 20, function: 'onClick' },
      { file: 'https://x.test/b.js', line: 1, column: 2, function: '' },
    ])
  })

  it.each([[undefined], [''], [42], [null]])('returns nothing for %s', (stack) => {
    expect(parseStack(stack)).toEqual([])
  })
})

describe('resolveStack', () => {
  it('resolves built frames to the original file and line, with the code window from the map', () => {
    const stack = resolveStack(
      stackOf(`explode (${built('boom/page.js')}:1:101)`, `Page (${built('boom/page.js')}:1:201)`, 'process.processTicksAndRejections (node:internal/process/task_queues:105:5)'),
      { projectRoot: root },
    )
    expect(stack.file).toBe('app/boom/page.tsx')
    expect(stack.line).toBe(7)
    expect(stack.frames).toHaveLength(3)
    expect(stack.frames[0]).toMatchObject({ file: 'app/boom/page.tsx', line: 7, column: 3, function: 'explode', vendor: false, resolved: true })
    // ±5 lines around line 7: 2..12
    expect(Object.keys(stack.frames[0]!.code!)).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(stack.frames[0]!.code!['7']).toBe('// original line 7')
    expect(stack.frames[1]).toMatchObject({ file: 'app/boom/page.tsx', line: 12, function: 'Page', resolved: true })
    expect(stack.frames[2]).toMatchObject({ file: 'node:internal/process/task_queues', line: 105, vendor: true, resolved: false, code: null })
  })

  it('understands turbopack source names', () => {
    const stack = resolveStack(stackOf(`GET (${join(root, '.next/server/chunks/ssr/chunk.js')}:5:11)`), { projectRoot: root })
    expect(stack).toMatchObject({ file: 'app/api/boom/route.ts', line: 3 })
    // The window is clipped at the start of the file.
    expect(Object.keys(stack.frames[0]!.code!)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('resolves relative sources against the map and reports them relative to the project root', () => {
    expect(resolveStack(stackOf(`run (${join(root, 'dist/job.js')}:3:1)`), { projectRoot: root })).toMatchObject({ file: 'src/job.ts', line: 9 })
  })

  it('a dependency inside a bundle is a vendor frame without code; the first application frame is reported', () => {
    const stack = resolveStack(stackOf(`pad (${built('vendor.js')}:1:1)`, `Page (${built('boom/page.js')}:1:201)`), { projectRoot: root })
    expect(stack.frames[0]).toMatchObject({ file: 'node_modules/left-pad/index.js', vendor: true, code: null, resolved: true })
    expect(stack).toMatchObject({ file: 'app/boom/page.tsx', line: 12 })
  })

  it.each([
    ['a missing map', 'missing.js'],
    ['a truncated map', 'corrupt.js'],
    ['a map that is not JSON', 'garbage.js'],
    ['a map that is JSON null', 'null.js'],
  ])('%s: the frame is sent unresolved, never dropped', (_name, file) => {
    const stack = resolveStack(stackOf(`Page (${built(file)}:1:101)`, `next (${built('boom/page.js')}:1:201)`), { projectRoot: root })
    expect(stack.frames).toHaveLength(2)
    expect(stack.frames[0]).toMatchObject({ file: `.next/server/app/${file}`, line: 1, column: 101, function: 'Page', code: null, vendor: true, resolved: false })
    // The neighbour with a good map is unaffected.
    expect(stack.frames[1]).toMatchObject({ file: 'app/boom/page.tsx', resolved: true })
  })

  it('a position the map does not cover stays unresolved', () => {
    const stack = resolveStack(stackOf(`Page (${built('nocontent.js')}:99:1)`), { projectRoot: root })
    expect(stack.frames[0]).toMatchObject({ file: '.next/server/app/nocontent.js', line: 99, resolved: false })
    expect(stack).toMatchObject({ file: '.next/server/app/nocontent.js', line: 99 })
  })

  it('a map without embedded sources resolves the location but has no code', () => {
    expect(resolveStack(stackOf(`f (${built('nocontent.js')}:1:1)`), { projectRoot: root }).frames[0]).toMatchObject({ file: 'app/nocontent.ts', line: 4, code: null, resolved: true })
  })

  it('captureSource: false sends no code', () => {
    expect(resolveStack(stackOf(`explode (${built('boom/page.js')}:1:101)`), { projectRoot: root, captureSource: false }).frames[0]).toMatchObject({ file: 'app/boom/page.tsx', line: 7, code: null })
  })

  it('at most 10 frames carry code', () => {
    const frames = Array.from({ length: 14 }, () => `f (${built('boom/page.js')}:1:101)`)
    const stack = resolveStack(stackOf(...frames), { projectRoot: root })
    expect(stack.frames.filter((frame) => frame.code !== null)).toHaveLength(10)
    expect(stack.frames).toHaveLength(14)
  })

  it('finds maps for browser URLs under mapDirs', () => {
    const stack = resolveStack(stackOf('onClick (https://crm.example.com/_next/static/chunks/app/page-abc123.js:1:5001)'), { projectRoot: root, mapDirs: [join(root, '.next/doxa-watch/maps')] })
    expect(stack).toMatchObject({ file: 'app/page.tsx', line: 15 })
    expect(stack.frames[0]!.code!['15']).toBe('// original line 15')
    // Without the directory the URL is kept as it is.
    clearSourceMapCache()
    expect(resolveStack(stackOf('onClick (https://crm.example.com/_next/static/chunks/app/page-abc123.js:1:5001)'), { projectRoot: root }).frames[0]).toMatchObject({ file: 'https://crm.example.com/_next/static/chunks/app/page-abc123.js', line: 1, resolved: false, vendor: true })
  })

  it('plain Node without a bundler: code comes from the file itself', () => {
    const stack = resolveStack(stackOf(`main (${join(root, 'scripts/import.js')}:3:7)`), { projectRoot: root })
    expect(stack).toMatchObject({ file: 'scripts/import.js', line: 3 })
    expect(stack.frames[0]).toMatchObject({ vendor: false, resolved: false })
    expect(stack.frames[0]!.code!['3']).toBe('const line3 = 3')
  })

  it.each([
    ['an error without a stack', {}],
    ['a string', 'boom'],
    ['null', null],
  ])('survives %s', (_name, error) => {
    expect(resolveStack(error, { projectRoot: root })).toEqual({ file: '', line: 0, frames: [] })
  })

  it('a real error thrown here resolves to this test file', () => {
    const stack = resolveStack(new Error('real'), { projectRoot: process.cwd() })
    expect(stack.file).toBe('test/stacktrace.test.ts')
    expect(stack.line).toBeGreaterThan(0)
  })
})

describe('isVendorPath', () => {
  it.each([
    ['node_modules/next/dist/server/render.js', true],
    ['packages/web/node_modules/x/index.js', true],
    ['node:internal/process/task_queues', true],
    ['.next/server/app/page.js', true],
    ['webpack/bootstrap', true],
    ['/usr/lib/outside.js', true],
    ['[unknown file]', true],
    ['https://cdn.example.com/x.js', true],
    ['app/deals/[id]/page.tsx', false],
    ['src/lib/db.ts', false],
  ])('%s → %s', (file, vendor) => {
    expect(isVendorPath(file)).toBe(vendor)
  })
})
