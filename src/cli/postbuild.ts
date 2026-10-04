import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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

/**
 * `doxa-watch postbuild [--dist-dir .next]` — run after `next build` (`"build": "next build && doxa-watch postbuild"`).
 * Further post-build steps (moving the browser source maps out of the public folder) are added to this command.
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
  return 0
}
