import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ParsedArgs } from './args'

function walk(dir: string, visit: (path: string) => void, skip: (name: string) => boolean = () => false): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (skip(name)) continue
    const path = join(dir, name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (stats.isDirectory()) walk(path, visit, skip)
    else visit(path)
  }
}

/** The app's directory inside `<dist>/standalone`: the one holding `<dist>/server` (deeper than the top in a monorepo). */
function standaloneApps(standalone: string, distDir: string): string[] {
  const found: string[] = []
  const look = (dir: string, depth: number): void => {
    if (existsSync(join(dir, distDir, 'server'))) {
      found.push(dir)
      return
    }
    if (depth >= 6) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const path = join(dir, name)
      try {
        if (statSync(path).isDirectory()) look(path, depth + 1)
      } catch {
        // unreadable: skip
      }
    }
  }
  look(standalone, 0)
  return found
}

/**
 * Copies `<dist>/server/**\/*.map` into the standalone output. A webpack build already has them there; a Turbopack
 * build (the default from Next 16) leaves the server chunks' maps out, and without them the SDK could only report
 * built locations. Returns how many files were copied.
 */
export function copyServerSourceMaps(projectDir: string, distDir = '.next'): number {
  const server = join(projectDir, distDir, 'server')
  const standalone = join(projectDir, distDir, 'standalone')
  if (!existsSync(server) || !existsSync(standalone)) return 0

  let copied = 0
  for (const app of standaloneApps(standalone, distDir)) {
    const target = join(app, distDir, 'server')
    walk(server, (path) => {
      if (!path.endsWith('.map')) return
      const destination = join(target, relative(server, path))
      if (existsSync(destination)) return
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(path, destination)
      copied++
    })
  }
  return copied
}

/** Where the browser source maps go, inside the dist directory: never served, read by the tunnel. */
export const BROWSER_MAPS = join('doxa-watch', 'maps')

// The trailing comment a bundler leaves in a built file: `//# sourceMappingURL=x.js.map` or `/*# sourceMappingURL=x.css.map */`.
const SOURCE_MAPPING_URL = /\n?(?:\/\/[#@] *sourceMappingURL=([^\n]*)|\/\*[#@] *sourceMappingURL=([^*\n]*)\*\/)[ \t\r\n]*$/

/**
 * Removes the `sourceMappingURL` comment at the end of a built `.js`/`.css` file. Returns the URL it named (`""` for
 * an inline `data:` map), or null when the file had no such comment and was left untouched.
 */
export function stripSourceMappingUrl(path: string): string | null {
  const content = readFileSync(path, 'utf8')
  const match = SOURCE_MAPPING_URL.exec(content)
  if (match === null) return null
  writeFileSync(path, content.slice(0, match.index))
  const url = (match[1] ?? match[2] ?? '').trim()
  return url.startsWith('data:') ? '' : url
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    // another file system: copy, then remove
    copyFileSync(from, to)
    rmSync(from)
  }
}

export interface BrowserMapsResult {
  /** `.map` files taken out of the public folder(s). */
  moved: number
  /** Built files whose `sourceMappingURL` comment was removed. */
  stripped: number
}

/**
 * Takes the browser source maps out of the public folder. The map of `<dist>/static/chunks/a.js` ends up at
 * `<dist>/doxa-watch/maps/chunks/a.js.map` — named after the built file, whatever the bundler called the map
 * (Turbopack hashes the two names separately), because the tunnel finds a frame's map by the end of the script's URL
 * path. The `sourceMappingURL` comments are removed from the `.js`/`.css` files. The same is done to a copy of
 * `static` inside the standalone output, and `<dist>/doxa-watch` is copied into the standalone output so the image
 * has the maps. Running it again changes nothing.
 */
export function moveBrowserSourceMaps(projectDir: string, distDir = '.next'): BrowserMapsResult {
  const dist = join(projectDir, distDir)
  const maps = join(dist, BROWSER_MAPS)
  const standalone = join(dist, 'standalone')
  const apps = existsSync(standalone) ? standaloneApps(standalone, distDir) : []
  const result: BrowserMapsResult = { moved: 0, stripped: 0 }

  // Where each map went, for the rare map that two built files name.
  const taken = new Map<string, string>()
  const take = (map: string, destination: string): void => {
    const earlier = taken.get(map)
    if (earlier !== undefined) {
      if (earlier !== destination && !existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(earlier, destination)
      }
      return
    }
    // A copy inside the standalone output is the same file: keep the one already moved.
    if (existsSync(destination)) rmSync(map)
    else move(map, destination)
    taken.set(map, destination)
    result.moved++
  }

  for (const staticDir of [join(dist, 'static'), ...apps.map((app) => join(app, distDir, 'static'))]) {
    // First the built files: each takes the map its comment names.
    walk(staticDir, (path) => {
      if (!path.endsWith('.js') && !path.endsWith('.css')) return
      try {
        const url = stripSourceMappingUrl(path)
        if (url === null) return
        result.stripped++
        if (url === '' || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return
        const map = resolve(dirname(path), decodeURIComponent(url.replace(/[?#].*$/, '')))
        const inside = relative(staticDir, map)
        if (inside.startsWith('..') || isAbsolute(inside) || (!existsSync(map) && !taken.has(map))) return
        take(map, join(maps, `${relative(staticDir, path)}.map`))
      } catch {
        // one unreadable file must not stop the build
      }
    })
    // Then whatever map is left (no built file names it): out of the public folder all the same.
    walk(staticDir, (path) => {
      if (!path.endsWith('.map')) return
      try {
        take(path, join(maps, relative(staticDir, path)))
      } catch {
        // as above
      }
    })
  }

  if (existsSync(join(dist, 'doxa-watch'))) {
    for (const app of apps) cpSync(join(dist, 'doxa-watch'), join(app, distDir, 'doxa-watch'), { recursive: true, force: true })
  }
  return result
}

/**
 * `doxa-watch postbuild [--dist-dir .next]` — run after `next build` (`"build": "next build && doxa-watch postbuild"`).
 * Copies the server source maps into the standalone output and takes the browser source maps out of the public folder.
 */
export async function postbuild(args: ParsedArgs, print: (line: string) => void = console.log): Promise<number> {
  const projectDir = resolve(args.positional[0] ?? process.cwd())
  const distDir = args.options['dist-dir'] ?? '.next'
  if (!existsSync(join(projectDir, distDir))) {
    print(`doxa-watch: ${join(projectDir, distDir)} does not exist; run this after \`next build\`.`)
    return 1
  }
  const copied = copyServerSourceMaps(projectDir, distDir)
  print(`doxa-watch: ${copied} server source map${copied === 1 ? '' : 's'} copied into the standalone output.`)
  const browser = moveBrowserSourceMaps(projectDir, distDir)
  print(
    `doxa-watch: ${browser.moved} browser source map${browser.moved === 1 ? '' : 's'} moved to ${join(distDir, BROWSER_MAPS)} (not served); ` +
      `${browser.stripped} sourceMappingURL comment${browser.stripped === 1 ? '' : 's'} removed.`,
  )
  return 0
}
