import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cli/args'
import { moveBrowserSourceMaps, postbuild, stripSourceMappingUrl } from '../src/cli/postbuild'

let dir: string

function write(path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}
const read = (path: string) => readFileSync(join(dir, path), 'utf8')
const has = (path: string) => existsSync(join(dir, path))

function tree(root: string): string[] {
  const base = join(dir, root)
  const walk = (at: string): string[] =>
    !existsSync(at) ? [] : readdirSync(at).flatMap((name) => (statSync(join(at, name)).isDirectory() ? walk(join(at, name)) : [relative(base, join(at, name)).split('\\').join('/')]))
  return walk(base).sort()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doxa-watch-postbuild-'))
  // What `next build` leaves with productionBrowserSourceMaps (webpack naming; Turbopack below).
  write('.next/static/chunks/app/page-abc.js', 'console.log("page")\n//# sourceMappingURL=page-abc.js.map')
  write('.next/static/chunks/app/page-abc.js.map', '{"version":3,"file":"page"}')
  write('.next/static/chunks/main-123.js', 'console.log("main")\n//# sourceMappingURL=main-123.js.map\n')
  write('.next/static/chunks/main-123.js.map', '{"version":3,"file":"main"}')
  write('.next/static/css/app.css', 'body{color:red}\n/*# sourceMappingURL=app.css.map */')
  write('.next/static/css/app.css.map', '{"version":3,"file":"css"}')
  write('.next/static/chunks/plain.js', 'const url = "//# sourceMappingURL=not-a-comment.map"; console.log(url)')
  write('.next/static/media/font.woff2', 'font')
  write('.next/static/BUILDID/_buildManifest.js', 'self.__BUILD_MANIFEST={}')
  write('.next/server/app/page.js', 'server\n//# sourceMappingURL=page.js.map')
  write('.next/server/app/page.js.map', '{"version":3,"file":"server"}')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('moveBrowserSourceMaps', () => {
  it('moves every map out of .next/static, keeps the relative paths, and strips the comments', () => {
    expect(moveBrowserSourceMaps(dir)).toEqual({ moved: 3, stripped: 3 })
    expect(tree('.next/doxa-watch/maps')).toEqual(['chunks/app/page-abc.js.map', 'chunks/main-123.js.map', 'css/app.css.map'])
    expect(tree('.next/static')).toEqual(['BUILDID/_buildManifest.js', 'chunks/app/page-abc.js', 'chunks/main-123.js', 'chunks/plain.js', 'css/app.css', 'media/font.woff2'])
    expect(read('.next/doxa-watch/maps/chunks/app/page-abc.js.map')).toBe('{"version":3,"file":"page"}')
    expect(read('.next/static/chunks/app/page-abc.js')).toBe('console.log("page")')
    expect(read('.next/static/chunks/main-123.js')).toBe('console.log("main")')
    expect(read('.next/static/css/app.css')).toBe('body{color:red}')
    // not a trailing comment: untouched
    expect(read('.next/static/chunks/plain.js')).toContain('sourceMappingURL=not-a-comment.map')
    // the server's files are not this step's business
    expect(read('.next/server/app/page.js')).toContain('sourceMappingURL=page.js.map')
    expect(has('.next/server/app/page.js.map')).toBe(true)
  })

  it('is idempotent', () => {
    moveBrowserSourceMaps(dir)
    const before = [tree('.next'), read('.next/static/chunks/main-123.js')]
    expect(moveBrowserSourceMaps(dir)).toEqual({ moved: 0, stripped: 0 })
    expect([tree('.next'), read('.next/static/chunks/main-123.js')]).toEqual(before)
  })

  it('names a map after the built file that points to it (Turbopack hashes the two separately)', () => {
    write('.next/static/chunks/0abc.js', 'chunk\n\n//# sourceMappingURL=9xyz.js.map')
    write('.next/static/chunks/9xyz.js.map', '{"version":3,"file":"turbopack"}')
    write('.next/static/chunks/1def.js', 'chunk\n//# sourceMappingURL=with%20space.js.map?v=1')
    write('.next/static/chunks/with space.js.map', '{"version":3,"file":"encoded"}')
    write('.next/static/chunks/orphan.js.map', '{"version":3,"file":"orphan"}')
    moveBrowserSourceMaps(dir)
    expect(read('.next/doxa-watch/maps/chunks/0abc.js.map')).toBe('{"version":3,"file":"turbopack"}')
    expect(read('.next/doxa-watch/maps/chunks/1def.js.map')).toBe('{"version":3,"file":"encoded"}')
    // a map nothing points to still leaves the public folder
    expect(read('.next/doxa-watch/maps/chunks/orphan.js.map')).toBe('{"version":3,"file":"orphan"}')
    expect(tree('.next/static').filter((path) => path.endsWith('.map'))).toEqual([])
    expect(has('.next/doxa-watch/maps/chunks/9xyz.js.map')).toBe(false)
  })

  it('two built files that name the same map each get it', () => {
    write('.next/static/chunks/a.js', 'a\n//# sourceMappingURL=shared.map')
    write('.next/static/chunks/b.js', 'b\n//# sourceMappingURL=shared.map')
    write('.next/static/chunks/shared.map', '{"version":3,"file":"shared"}')
    moveBrowserSourceMaps(dir)
    expect(read('.next/doxa-watch/maps/chunks/a.js.map')).toBe('{"version":3,"file":"shared"}')
    expect(read('.next/doxa-watch/maps/chunks/b.js.map')).toBe('{"version":3,"file":"shared"}')
    expect(has('.next/static/chunks/shared.map')).toBe(false)
  })

  it('leaves alone what is not a file of the static folder: inline maps, absolute URLs, paths that climb out', () => {
    write('.next/static/chunks/inline.js', 'x\n//# sourceMappingURL=data:application/json;base64,e30=')
    write('.next/static/chunks/remote.js', 'x\n//# sourceMappingURL=https://cdn.example/remote.js.map')
    write('.next/static/chunks/climb.js', 'x\n//# sourceMappingURL=../../server/app/page.js.map')
    expect(moveBrowserSourceMaps(dir)).toEqual({ moved: 3, stripped: 6 })
    for (const file of ['inline', 'remote', 'climb']) expect(read(`.next/static/chunks/${file}.js`)).toBe('x')
    expect(has('.next/server/app/page.js.map')).toBe(true)
    expect(tree('.next/doxa-watch/maps')).toHaveLength(3)
  })

  it('copies the maps into the standalone output and cleans a copy of static inside it', () => {
    write('.next/standalone/server.js', 'server')
    write('.next/standalone/.next/server/app/page.js', 'server')
    // some pipelines copy static into standalone before this step runs
    write('.next/standalone/.next/static/chunks/main-123.js', 'console.log("main")\n//# sourceMappingURL=main-123.js.map\n')
    write('.next/standalone/.next/static/chunks/main-123.js.map', '{"version":3,"file":"main"}')
    write('.next/standalone/.next/static/chunks/only-here.js', 'x\n//# sourceMappingURL=only-here.js.map')
    write('.next/standalone/.next/static/chunks/only-here.js.map', '{"version":3,"file":"only-here"}')

    moveBrowserSourceMaps(dir)
    expect(tree('.next/standalone/.next/static')).toEqual(['chunks/main-123.js', 'chunks/only-here.js'])
    expect(read('.next/standalone/.next/static/chunks/main-123.js')).toBe('console.log("main")')
    expect(tree('.next/standalone/.next/doxa-watch/maps')).toEqual(['chunks/app/page-abc.js.map', 'chunks/main-123.js.map', 'chunks/only-here.js.map', 'css/app.css.map'])
    expect(tree('.next/standalone/.next/doxa-watch/maps')).toEqual(tree('.next/doxa-watch/maps'))

    const before = tree('.next')
    expect(moveBrowserSourceMaps(dir)).toEqual({ moved: 0, stripped: 0 })
    expect(tree('.next')).toEqual(before)
  })

  it('finds the app inside a monorepo standalone output and honours a custom dist directory', () => {
    rmSync(join(dir, '.next'), { recursive: true })
    write('build/static/chunks/a.js', 'a\n//# sourceMappingURL=a.js.map')
    write('build/static/chunks/a.js.map', '{}')
    write('build/standalone/apps/web/build/server/app/page.js', 'server')
    expect(moveBrowserSourceMaps(dir, 'build')).toEqual({ moved: 1, stripped: 1 })
    expect(tree('build/doxa-watch/maps')).toEqual(['chunks/a.js.map'])
    expect(tree('build/standalone/apps/web/build/doxa-watch/maps')).toEqual(['chunks/a.js.map'])
  })

  it('does nothing without a static folder', () => {
    rmSync(join(dir, '.next/static'), { recursive: true })
    expect(moveBrowserSourceMaps(dir)).toEqual({ moved: 0, stripped: 0 })
    expect(has('.next/doxa-watch')).toBe(false)
  })
})

describe('stripSourceMappingUrl', () => {
  it.each([
    ['code\n//# sourceMappingURL=a.js.map', 'code', 'a.js.map'],
    ['code\n//# sourceMappingURL=a.js.map\n\n', 'code', 'a.js.map'],
    ['code\r\n//# sourceMappingURL=a.js.map\r\n', 'code\r', 'a.js.map'],
    ['code\n//@ sourceMappingURL=a.js.map', 'code', 'a.js.map'],
    ['a{}\n/*# sourceMappingURL=a.css.map */', 'a{}', 'a.css.map'],
    ['a{}/*# sourceMappingURL=a.css.map */\n', 'a{}', 'a.css.map'],
    ['x\n//# sourceMappingURL=data:application/json;base64,e30=', 'x', ''],
  ])('%j', (content, expected, url) => {
    write('file.js', content)
    expect(stripSourceMappingUrl(join(dir, 'file.js'))).toBe(url)
    expect(read('file.js')).toBe(expected)
  })

  it('leaves a file without a trailing comment untouched', () => {
    write('file.js', '//# sourceMappingURL=first.map\ncode()')
    expect(stripSourceMappingUrl(join(dir, 'file.js'))).toBeNull()
    expect(read('file.js')).toBe('//# sourceMappingURL=first.map\ncode()')
  })
})

describe('postbuild command', () => {
  it('reports both steps and exits 0', async () => {
    const lines: string[] = []
    expect(await postbuild(parseArgs([dir]), (line) => void lines.push(line))).toBe(0)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('3 browser source maps moved to .next/doxa-watch/maps')
    expect(lines[1]).toContain('3 sourceMappingURL comments removed')
    expect(has('.next/static/chunks/main-123.js.map')).toBe(false)
  })
})
