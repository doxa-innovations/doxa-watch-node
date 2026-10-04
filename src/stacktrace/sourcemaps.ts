import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SourceMapConsumer } from 'source-map-js'
import { debug } from '../debug'
import type { ResolvedStack, StackFrame } from '../records/exception'
import { type RawFrame, parseStack } from './parse'

export interface ResolveOptions {
  /** Paths are reported relative to this directory. */
  projectRoot: string
  /** Extra directories searched for `<file>.map` when no map sits next to the built file. */
  mapDirs?: string[]
  /** Attach the ±5-line code window to application frames. Default true. */
  captureSource?: boolean
  /**
   * The stack was reported by another machine (a visitor's browser), so its paths are not to be trusted: maps are
   * looked up under `mapDirs` only, and no file is ever read because a frame names it.
   */
  remote?: boolean
}

const CODE_WINDOW = 5
const MAX_CODE_FRAMES = 10
const MAX_FRAMES = 100
const MAX_CACHED_MAPS = 40
const MAX_MAP_BYTES = 64 * 1024 * 1024

interface LoadedMap {
  consumer: SourceMapConsumer
  /** Directory the map's relative `sources` are resolved against. */
  base: string
}

// Insertion-ordered: the first key is the least recently used. `null` remembers a missing or corrupt map.
const maps = new Map<string, LoadedMap | null>()
const files = new Map<string, string[] | null>()

/** Test helper. */
export function clearSourceMapCache(): void {
  maps.clear()
  files.clear()
}

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > limit) cache.delete(cache.keys().next().value as string)
  return value
}

function loadMap(path: string): LoadedMap | null {
  const cached = maps.get(path)
  if (cached !== undefined) return remember(maps, path, cached, MAX_CACHED_MAPS)

  let loaded: LoadedMap | null = null
  try {
    if (existsSync(path) && statSync(path).size <= MAX_MAP_BYTES) {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        loaded = { consumer: new SourceMapConsumer(raw as never), base: dirname(path) }
      }
    }
  } catch (error) {
    debug(`source map ${path} is unreadable:`, error instanceof Error ? error.message : error)
  }
  return remember(maps, path, loaded, MAX_CACHED_MAPS)
}

function toPath(file: string): string {
  if (file.startsWith('file://')) {
    try {
      return fileURLToPath(file)
    } catch {
      return file
    }
  }
  return file
}

/** Where the map of a built file may be: next to it, or under one of `mapDirs` by a suffix of its path. */
function mapCandidates(file: string, options: ResolveOptions): string[] {
  const candidates: string[] = []
  let pathname = file
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    // A browser URL: only its path can be matched against `mapDirs`.
    try {
      pathname = decodeURIComponent(new URL(file).pathname)
    } catch {
      return candidates
    }
  } else if (options.remote === true) {
    // only `mapDirs`, below
  } else if (isAbsolute(file)) {
    candidates.push(`${file}.map`)
  } else {
    candidates.push(`${resolve(options.projectRoot, file)}.map`)
  }

  const segments = pathname.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  for (const dir of options.mapDirs ?? []) {
    for (let start = 0; start < segments.length; start++) {
      candidates.push(`${join(dir, ...segments.slice(start))}.map`)
    }
  }
  return candidates
}

const BUNDLER_PREFIX = /^(?:webpack(?:-internal)?:\/\/\/?(?:[^/]*\/)?|turbopack:\/\/\/?(?:\[project\]\/)?|file:\/\/)/

/** A map's `source` entry → a path relative to the project root when it lies inside it. */
function sourcePath(source: string, map: LoadedMap, projectRoot: string): string {
  let path = source
  if (path.startsWith('file://')) {
    path = toPath(path)
  } else if (BUNDLER_PREFIX.test(path)) {
    // `webpack://_N_E/./app/page.tsx`, `turbopack:///[project]/app/page.tsx`: already project-relative.
    path = path.replace(BUNDLER_PREFIX, '').replace(/^(\.\/)+/, '')
    return path.replace(/\?.*$/, '')
  }
  path = path.replace(/\?.*$/, '')
  const absolute = isAbsolute(path) ? path : resolve(map.base, path)
  return relativeToRoot(absolute, projectRoot)
}

function relativeToRoot(absolute: string, projectRoot: string): string {
  const rel = relative(projectRoot, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return absolute
  return rel.split(sep).join('/')
}

/** Vendor: dependencies, Node's own modules, Next's build output and runtime, bundler glue (PROTOCOL §9.3). */
export function isVendorPath(file: string): boolean {
  if (file === '') return true
  return (
    file.startsWith('node:') ||
    file.startsWith('.next/') ||
    file.startsWith('webpack/') ||
    file.startsWith('[') ||
    file.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(file) ||
    /(^|\/)node_modules\//.test(file) ||
    /(^|\/)next\/dist\//.test(file)
  )
}

function codeWindow(lines: string[], line: number): Record<string, string> | null {
  if (line < 1 || line > lines.length) return null
  const code: Record<string, string> = {}
  for (let n = Math.max(1, line - CODE_WINDOW); n <= Math.min(lines.length, line + CODE_WINDOW); n++) {
    code[String(n)] = (lines[n - 1] as string).replace(/\r$/, '').slice(0, 2000)
  }
  return code
}

function fileLines(path: string): string[] | null {
  const cached = files.get(path)
  if (cached !== undefined) return cached
  let lines: string[] | null = null
  try {
    if (statSync(path).size <= 2 * 1024 * 1024) lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    lines = null
  }
  return remember(files, path, lines, 50)
}

function resolveFrame(raw: RawFrame, options: ResolveOptions, wantCode: boolean): StackFrame {
  const unresolved = (file: string): StackFrame => ({
    file,
    line: raw.line,
    column: raw.column,
    function: raw.function,
    code: null,
    vendor: isVendorPath(file),
    resolved: false,
  })

  if (raw.file === '' || raw.file.startsWith('node:')) return unresolved(raw.file === '' ? '[unknown file]' : raw.file)

  const remote = options.remote === true
  const builtPath = remote ? raw.file : toPath(raw.file)

  if (raw.line > 0) {
    for (const candidate of mapCandidates(builtPath, options)) {
      const map = loadMap(candidate)
      if (map === null) continue
      try {
        const original = map.consumer.originalPositionFor({ line: raw.line, column: Math.max(raw.column - 1, 0) })
        if (original.source === null || original.line === null) break
        const file = sourcePath(original.source, map, options.projectRoot)
        const vendor = isVendorPath(file)
        let code: Record<string, string> | null = null
        if (wantCode && !vendor) {
          const content = map.consumer.sourceContentFor(original.source, true)
          if (typeof content === 'string') code = codeWindow(content.split('\n'), original.line)
        }
        return {
          file,
          line: original.line,
          column: (original.column ?? 0) + 1,
          function: raw.function,
          code,
          vendor,
          resolved: true,
        }
      } catch (error) {
        debug(`source map lookup in ${candidate} failed:`, error instanceof Error ? error.message : error)
        break
      }
    }
  }

  // No usable map: the frame is still sent, with the location as built (spec §7).
  if (remote || /^[a-z][a-z0-9+.-]*:\/\//i.test(builtPath)) return unresolved(builtPath)
  const absolute = isAbsolute(builtPath) ? builtPath : resolve(options.projectRoot, builtPath)
  const frame = unresolved(relativeToRoot(absolute, options.projectRoot))
  // Plain Node (no bundler): the file on disk IS the source.
  if (wantCode && !frame.vendor && raw.line > 0) {
    const lines = fileLines(absolute)
    if (lines !== null) frame.code = codeWindow(lines, raw.line)
  }
  return frame
}

/**
 * Turns an error's stack into frames that point at original files: each built location is looked up in the source
 * map next to the built file (or under `mapDirs`), and the code window is cut from the map's embedded sources, so
 * no source tree is needed at run time. A frame whose map is missing or corrupt is kept, unresolved.
 * `file`/`line` are the first application frame, falling back to the throw site.
 */
export function resolveStack(error: unknown, options: ResolveOptions): ResolvedStack {
  const stack = error !== null && typeof error === 'object' ? (error as { stack?: unknown }).stack : undefined
  const raw = parseStack(stack).slice(0, MAX_FRAMES)
  const frames: StackFrame[] = []
  let withCode = 0

  for (const rawFrame of raw) {
    let frame: StackFrame
    try {
      frame = resolveFrame(rawFrame, options, options.captureSource !== false && withCode < MAX_CODE_FRAMES)
    } catch (failure) {
      debug('frame resolution failed:', failure)
      frame = {
        file: rawFrame.file || '[unknown file]',
        line: rawFrame.line,
        column: rawFrame.column,
        function: rawFrame.function,
        code: null,
        vendor: true,
        resolved: false,
      }
    }
    if (frame.code !== null) withCode++
    frames.push(frame)
  }

  const first = frames.find((frame) => !frame.vendor) ?? frames[0]
  return { file: first?.file ?? '', line: first?.line ?? 0, frames }
}

/** Name of a map file as `mapCandidates` expects it; used by tooling that moves maps around. */
export function mapFileName(builtFile: string): string {
  return `${basename(builtFile)}.map`
}
