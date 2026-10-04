type Params = Record<string, string | string[] | undefined> | null | undefined

function encode(value: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * The route pattern of the current page (`/deals/[id]`), rebuilt from what a client component can see in the App
 * Router: `usePathname()` and `useParams()`. Each parameter's value is found among the path's segments and replaced by
 * its name (`[id]`, or `[...slug]` for a catch-all). Next has no public client API for the pattern itself, so:
 * - an optional catch-all (`[[...slug]]`) reads as `[...slug]`, and as nothing at all when it matched no segment;
 * - a parameter whose value equals a static segment earlier in the path replaces that segment instead;
 * - route groups and parallel-route slots do not appear (they are not part of the URL either).
 * Without a pathname the result is `""`; the caller falls back to the concrete path.
 */
export function routePattern(pathname: string | null | undefined, params: Params): string {
  if (!pathname) return ''
  if (!params) return pathname
  try {
    const segments = pathname.split('/')
    const entries = Object.entries(params)
    // Single segments first, then catch-alls, so `[id]` is not swallowed by a `[...rest]` that starts with it.
    for (const wantArray of [false, true]) {
      for (const [key, value] of entries) {
        if (value === undefined || Array.isArray(value) !== wantArray) continue
        const parts = Array.isArray(value) ? value : [value]
        if (parts.length === 0) continue
        for (let start = 1; start + parts.length <= segments.length; start++) {
          // `useParams` values may be decoded while the pathname is not.
          if (parts.every((part, offset) => segments[start + offset] === part || segments[start + offset] === encode(part))) {
            segments.splice(start, parts.length, wantArray ? `[...${key}]` : `[${key}]`)
            break
          }
        }
      }
    }
    return segments.join('/')
  } catch {
    return pathname
  }
}
