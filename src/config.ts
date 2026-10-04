import { hostname } from 'node:os'

export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const DEFAULT_BASE_URL = 'https://watch-ingest.doxaplc.com'
export const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-xsrf-token']

export interface WatchUser {
  id: string | number
  name?: string
  username?: string
}

/** What `resolveUser`, `ignore` and `redactRequest` see of an incoming request. */
export interface RequestInfo {
  method: string
  /** Path without the query string. */
  path: string
  /** Full URL: scheme, host, path and query string. */
  url: string
  /** Lower-cased header names, raw (unredacted) values. */
  headers: Record<string, string | string[] | undefined>
  ip: string
}

/** The fields of a `request` record an app may rewrite before it is sent. */
export interface RedactableRequest {
  url: string
  ip: string
  /** Already redacted per `redactHeaders`. */
  headers: Record<string, string[]>
}

export interface RedactableQuery {
  sql: string
}

export interface Framework {
  name: string
  version: string
}

export interface Config {
  token: string
  baseUrl: string
  enabled: boolean
  deploy: string
  server: string
  requestSampleRate: number
  exceptionSampleRate: number
  vitalsSampleRate: number
  /** Minimum level for `console.*` capture. `watch.log.<level>` always sends. */
  logLevel: LogLevel
  ignoreQueries: boolean
  ignoreMail: boolean
  ignoreOutgoingRequests: boolean
  /** Lower-cased header names. */
  redactHeaders: string[]
  captureExceptionSourceCode: boolean
  debug: boolean
  /** Paths in stack traces are made relative to this directory. */
  projectRoot: string
  /** Extra directories searched for `<file>.map` when a map is not next to the built file. */
  sourceMapDirs: string[]
  /** `""` name for plain Node. Sent on exception records and in the user agent. */
  framework: Framework
  resolveUser?: (request: RequestInfo) => WatchUser | null | undefined | Promise<WatchUser | null | undefined>
  redactRequest?: (request: RedactableRequest) => RedactableRequest | void
  redactQuery?: (query: RedactableQuery) => RedactableQuery | void
  /** Return true to leave a request unrecorded (on top of the built-in static/health/tunnel rules). */
  ignore?: (request: RequestInfo) => boolean
  /** Transport tuning. The defaults are the contract (spec §3.1); tests shorten them. */
  flushIntervalMs: number
  maxBatchRecords: number
  maxBatchBytes: number
  maxBufferRecords: number
  maxInFlight: number
  connectTimeoutMs: number
  requestTimeoutMs: number
  shutdownBudgetMs: number
}

export type ConfigOverrides = Partial<Config>

type Env = Record<string, string | undefined>

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
}

/** Rates outside [0, 1] (or unparsable) are treated as 0, like the PHP collector (PROTOCOL §5.1). */
export function rate(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
}

function level(value: string | undefined, fallback: LogLevel): LogLevel {
  const candidate = (value ?? '').trim().toLowerCase()
  if (candidate === 'warn') return 'warning'
  return (LOG_LEVELS as readonly string[]).includes(candidate) ? (candidate as LogLevel) : fallback
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return ''
}

function safeHostname(): string {
  try {
    return hostname()
  } catch {
    return ''
  }
}

/**
 * Environment first, then `overrides` (values passed to `register({...})`) on top. `undefined` overrides are ignored.
 * `env` is injectable for tests.
 */
export function loadConfig(overrides: ConfigOverrides = {}, env: Env = process.env): Config {
  const fromEnv: Config = {
    token: firstNonEmpty(env.DOXA_WATCH_TOKEN),
    baseUrl: firstNonEmpty(env.DOXA_WATCH_BASE_URL) || DEFAULT_BASE_URL,
    enabled: bool(env.DOXA_WATCH_ENABLED, true),
    deploy: firstNonEmpty(env.DOXA_WATCH_DEPLOY, env.GIT_SHA, env.SOURCE_COMMIT),
    server: firstNonEmpty(env.DOXA_WATCH_SERVER) || safeHostname(),
    requestSampleRate: rate(env.DOXA_WATCH_REQUEST_SAMPLE_RATE, 1),
    exceptionSampleRate: rate(env.DOXA_WATCH_EXCEPTION_SAMPLE_RATE, 1),
    vitalsSampleRate: rate(env.DOXA_WATCH_VITALS_SAMPLE_RATE, 1),
    logLevel: level(env.DOXA_WATCH_LOG_LEVEL, 'warning'),
    ignoreQueries: bool(env.DOXA_WATCH_IGNORE_QUERIES, false),
    ignoreMail: bool(env.DOXA_WATCH_IGNORE_MAIL, false),
    ignoreOutgoingRequests: bool(env.DOXA_WATCH_IGNORE_OUTGOING_REQUESTS, false),
    redactHeaders: list(env.DOXA_WATCH_REDACT_HEADERS, DEFAULT_REDACT_HEADERS),
    captureExceptionSourceCode: bool(env.DOXA_WATCH_CAPTURE_EXCEPTION_SOURCE_CODE, true),
    debug: bool(env.DOXA_WATCH_DEBUG, false),
    projectRoot: process.cwd(),
    sourceMapDirs: [],
    framework: { name: '', version: '' },
    flushIntervalMs: 5_000,
    maxBatchRecords: 500,
    maxBatchBytes: 1_000_000,
    maxBufferRecords: 5_000,
    maxInFlight: 2,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    shutdownBudgetMs: 2_000,
  }

  const config: Config = { ...fromEnv }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value
  }

  config.baseUrl = config.baseUrl.replace(/\/+$/, '')
  config.requestSampleRate = rate(config.requestSampleRate, 1)
  config.exceptionSampleRate = rate(config.exceptionSampleRate, 1)
  config.vitalsSampleRate = rate(config.vitalsSampleRate, 1)
  config.logLevel = level(config.logLevel, 'warning')
  config.redactHeaders = config.redactHeaders.map((name) => name.toLowerCase())

  return config
}

/** True when the SDK should do anything at all. */
export function isActive(config: Config): boolean {
  return config.enabled && config.token !== ''
}
