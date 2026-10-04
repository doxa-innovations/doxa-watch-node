import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { loadConfig, isActive } from '../src/config'

describe('loadConfig', () => {
  it('has the documented defaults', () => {
    const config = loadConfig({}, {})
    expect(config).toMatchObject({
      token: '',
      baseUrl: 'https://watch-ingest.doxaplc.com',
      enabled: true,
      deploy: '',
      server: hostname(),
      requestSampleRate: 1,
      exceptionSampleRate: 1,
      vitalsSampleRate: 1,
      logLevel: 'warning',
      ignoreQueries: false,
      ignoreMail: false,
      ignoreOutgoingRequests: false,
      redactHeaders: ['authorization', 'cookie', 'proxy-authorization', 'x-xsrf-token'],
      captureExceptionSourceCode: true,
      flushIntervalMs: 5000,
      maxBatchRecords: 500,
      maxBatchBytes: 1_000_000,
      maxBufferRecords: 5000,
      maxInFlight: 2,
      shutdownBudgetMs: 2000,
    })
    expect(isActive(config)).toBe(false)
  })

  it.each([
    ['DOXA_WATCH_DEPLOY wins', { DOXA_WATCH_DEPLOY: 'a', GIT_SHA: 'b', SOURCE_COMMIT: 'c' }, 'a'],
    ['then GIT_SHA', { GIT_SHA: 'b', SOURCE_COMMIT: 'c' }, 'b'],
    ['then SOURCE_COMMIT', { SOURCE_COMMIT: 'c' }, 'c'],
    ['else empty', {}, ''],
  ])('deploy: %s', (_name, env, expected) => {
    expect(loadConfig({}, env).deploy).toBe(expected)
  })

  it('reads every environment variable', () => {
    const config = loadConfig({}, {
      DOXA_WATCH_TOKEN: 'tok',
      DOXA_WATCH_BASE_URL: 'http://localhost:8000/',
      DOXA_WATCH_SERVER: 'crm-web-0',
      DOXA_WATCH_REQUEST_SAMPLE_RATE: '0.5',
      DOXA_WATCH_EXCEPTION_SAMPLE_RATE: '2',
      DOXA_WATCH_VITALS_SAMPLE_RATE: 'abc',
      DOXA_WATCH_LOG_LEVEL: 'INFO',
      DOXA_WATCH_IGNORE_QUERIES: 'true',
      DOXA_WATCH_IGNORE_MAIL: '1',
      DOXA_WATCH_IGNORE_OUTGOING_REQUESTS: 'false',
      DOXA_WATCH_REDACT_HEADERS: 'Authorization, X-Api-Key',
      DOXA_WATCH_CAPTURE_EXCEPTION_SOURCE_CODE: '0',
      DOXA_WATCH_DEBUG: '1',
    })
    expect(config).toMatchObject({
      token: 'tok',
      baseUrl: 'http://localhost:8000',
      server: 'crm-web-0',
      requestSampleRate: 0.5,
      exceptionSampleRate: 0, // outside [0, 1] → 0
      vitalsSampleRate: 0,
      logLevel: 'info',
      ignoreQueries: true,
      ignoreMail: true,
      ignoreOutgoingRequests: false,
      redactHeaders: ['authorization', 'x-api-key'],
      captureExceptionSourceCode: false,
      debug: true,
    })
    expect(isActive(config)).toBe(true)
  })

  it('code overrides win over the environment; undefined is ignored; DOXA_WATCH_ENABLED=false makes it inert', () => {
    const resolveUser = (): null => null
    const config = loadConfig({ token: 'code', deploy: undefined, resolveUser, logLevel: 'error' }, { DOXA_WATCH_TOKEN: 'env', DOXA_WATCH_DEPLOY: 'd', DOXA_WATCH_ENABLED: 'false' })
    expect(config.token).toBe('code')
    expect(config.deploy).toBe('d')
    expect(config.logLevel).toBe('error')
    expect(config.resolveUser).toBe(resolveUser)
    expect(isActive(config)).toBe(false)
  })
})
