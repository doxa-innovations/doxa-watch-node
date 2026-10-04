import { type WebVitalName, isWebVitalName } from '../../records/web-vital'

export interface BrowserError {
  name: string
  message: string
  stack: string
  handled: boolean
  code: string
  /** Route pattern; the concrete path when the browser did not know it. */
  route: string
  /** Concrete path without query string. */
  path: string
}

export interface BrowserVital {
  name: WebVitalName
  value: number
  /** As sent; the record builder decides whether to trust it. */
  rating: string
  navigationType: string
  route: string
  path: string
}

export interface BrowserReport {
  /** The page-load id. */
  id: string
  errors: BrowserError[]
  vitals: BrowserVital[]
}

/** Per post. The client sends at most 5 errors and 5 vitals at once; anything beyond these is ignored. */
export const MAX_ERRORS_PER_POST = 10
export const MAX_VITALS_PER_POST = 10

const LIMITS = { name: 255, message: 4000, stack: 16_000, code: 255, route: 255, path: 2048 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A day, in milliseconds: far beyond any real metric, close enough to reject garbage.
const MAX_VITAL_VALUE = 86_400_000

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A string no longer than `limit` (in characters); `fallback` when the key is absent; null when it is anything else. */
function text(value: unknown, limit: number, fallback?: string): string | null {
  if (value === undefined && fallback !== undefined) return fallback
  return typeof value === 'string' && value.length <= limit ? value : null
}

/** A URL path: starts with `/`, no control characters; a query string or fragment is cut off, never forwarded. */
function path(value: unknown, limit: number): string | null {
  const raw = text(value, limit)
  if (raw === null || !raw.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw)) return null
  return raw.replace(/[?#].*$/, '')
}

function parseError(item: unknown): BrowserError | null {
  if (!isObject(item)) return null
  const name = text(item.name, LIMITS.name)
  const message = text(item.message, LIMITS.message)
  const stack = text(item.stack, LIMITS.stack, '')
  const code = text(item.code, LIMITS.code, '')
  const concrete = path(item.path, LIMITS.path)
  const route = item.route === undefined || item.route === '' ? concrete : path(item.route, LIMITS.route)
  if (name === null || name === '' || message === null || stack === null || code === null || concrete === null || route === null) return null
  if (item.handled !== undefined && typeof item.handled !== 'boolean') return null
  return { name, message, stack, handled: item.handled === true, code, route, path: concrete }
}

function parseVital(item: unknown): BrowserVital | null {
  if (!isObject(item)) return null
  if (!isWebVitalName(item.name)) return null
  const value = item.value
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VITAL_VALUE) return null
  const rating = text(item.rating, 32, '')
  const navigationType = text(item.nav, 32, '')
  const concrete = path(item.path, LIMITS.path)
  const route = item.route === undefined || item.route === '' ? concrete : path(item.route, LIMITS.route)
  if (rating === null || navigationType === null || concrete === null || route === null) return null
  return {
    name: item.name,
    value,
    rating,
    navigationType: /^[a-z][a-z-]*$/.test(navigationType) ? navigationType : '',
    route,
    path: concrete,
  }
}

function list<T>(value: unknown, limit: number, parse: (item: unknown) => T | null): T[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const items: T[] = []
  for (const item of value.slice(0, limit)) {
    const parsed = parse(item)
    if (parsed !== null) items.push(parsed)
  }
  return items
}

/**
 * The body the browser client posts: `{ id, errors?: [...], vitals?: [...] }`. A body that is not that shape (not
 * JSON, no valid page-load id, `errors`/`vitals` not arrays) is refused as a whole and yields null. Inside the
 * arrays, an item with a wrong type, an unknown vital name, a non-finite value or an oversized string is dropped by
 * itself and the rest is kept.
 */
export function parseReport(body: string): BrowserReport | null {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id)) return null
  const errors = list(raw.errors, MAX_ERRORS_PER_POST, parseError)
  const vitals = list(raw.vitals, MAX_VITALS_PER_POST, parseVital)
  if (errors === null || vitals === null) return null
  return { id: raw.id.toLowerCase(), errors, vitals }
}
