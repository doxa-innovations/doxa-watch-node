// Runs inside next.config at build and start time. Keep it free of imports: it is also part of the Edge stub.

/** Kept out of the server bundle so Next's output tracing copies them into `.next/standalone/node_modules`. */
export const EXTERNAL_PACKAGES = ['doxa-watch', '@opentelemetry/api', '@opentelemetry/sdk-trace-base', 'source-map-js']

type AnyConfig = Record<string, unknown>
type ConfigFunction = (...args: unknown[]) => AnyConfig | Promise<AnyConfig>

function apply(config: AnyConfig | undefined | null): AnyConfig {
  const base = config ?? {}
  const experimental = (base.experimental as AnyConfig | undefined) ?? {}
  const external = Array.isArray(base.serverExternalPackages) ? (base.serverExternalPackages as string[]) : []
  return {
    ...base,
    // Browser frames are resolved by the tunnel from these maps; `doxa-watch postbuild` moves them out of the
    // public folder so they are never served.
    productionBrowserSourceMaps: true,
    // `serverExternalPackages` is the name in Next 15 and 16 (it was experimental.serverComponentsExternalPackages
    // in 14, which this package does not support).
    serverExternalPackages: [...new Set([...external, ...EXTERNAL_PACKAGES])],
    experimental: {
      ...experimental,
      // Server stack frames are resolved in-process from the maps next to the built files (Next 15 and 16).
      serverSourceMaps: true,
    },
  }
}

/**
 * Wraps a Next config (object, function or async function):
 * `experimental.serverSourceMaps`, `productionBrowserSourceMaps`, and `doxa-watch` plus its OpenTelemetry packages
 * kept external to the server bundle. Everything else is passed through untouched.
 */
export function withDoxaWatch<T>(config: T): T {
  if (typeof config === 'function') {
    const original = config as unknown as ConfigFunction
    const wrapped = (...args: unknown[]): AnyConfig | Promise<AnyConfig> => {
      const result = original(...args)
      return result instanceof Promise ? result.then(apply) : apply(result)
    }
    return wrapped as unknown as T
  }
  return apply(config as unknown as AnyConfig) as unknown as T
}
