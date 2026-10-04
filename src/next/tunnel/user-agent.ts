import type { Device } from '../../records/web-vital'

export interface ParsedUserAgent {
  device: Device
  /** Name + major version (`Chrome 141`), `""` when the browser is not recognised. */
  browser: string
}

// Order matters: almost every browser also says `Chrome` and `Safari`, so the specific tokens come first.
const BROWSERS: [RegExp, string][] = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\/(\d+)/, 'Edge'],
  [/\b(?:OPR|OPiOS|Opera)\/(\d+)/, 'Opera'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/\b(?:Chrome|HeadlessChrome|CriOS|Chromium)\/(\d+)/, 'Chrome'],
  // Safari's own version is in `Version/`; the number after `Safari/` is WebKit's build.
  [/\bVersion\/(\d+)[\d.]*(?: Mobile\/\w+)? Safari\//, 'Safari'],
]

/**
 * A device class and a browser name from a `user-agent` header — deliberately small: three device classes and the
 * browsers that matter for web vitals. Tablets: iPad, Android without `Mobile`, Kindle/Silk, `Tablet`. An iPad that
 * asks for the desktop site sends a Mac user agent and is counted as desktop.
 */
export function parseUserAgent(header: unknown): ParsedUserAgent {
  const ua = typeof header === 'string' ? header.slice(0, 1024) : ''

  let device: Device = 'desktop'
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobi)/.test(ua)) device = 'tablet'
  else if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/.test(ua)) device = 'mobile'

  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(ua)
    if (match !== null) return { device, browser: `${name} ${match[1] as string}` }
  }
  return { device, browser: '' }
}
