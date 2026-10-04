declare const __DOXA_WATCH_VERSION__: string

/** Replaced at build time (tsup `define`) and in tests (vitest `define`). */
export const SDK_VERSION: string = typeof __DOXA_WATCH_VERSION__ === 'string' ? __DOXA_WATCH_VERSION__ : '0.0.0'

/** PROTOCOL §9.1: `DoxaWatchNode/{sdk version} (next/{version}; node/{version})`. */
export function userAgent(framework: { name: string; version: string }): string {
  const parts: string[] = []
  if (framework.name !== '') parts.push(`${framework.name}/${framework.version || 'unknown'}`)
  parts.push(`node/${process.versions.node}`)
  return `DoxaWatchNode/${SDK_VERSION} (${parts.join('; ')})`
}
