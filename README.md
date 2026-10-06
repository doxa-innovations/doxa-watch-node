# @doxa-innovations/watch

The Node / Next.js collector for Doxa Watch. It reports requests, exceptions, outgoing
requests, queries, mail, jobs, logs and users from a Next.js server straight to Doxa Watch — there is no local agent to run.

- Next.js 15 or 16, Node.js 18.18 or newer, Node.js runtime only.
- Without `DOXA_WATCH_TOKEN` it prints one line at start-up and does nothing else.
- Nothing it does can throw into your app; a Doxa Watch outage costs you the records of that moment, nothing more.

## Install

```sh
npm install @doxa-innovations/watch
```

### 1. `instrumentation.ts`

```ts
export { register, onRequestError } from '@doxa-innovations/watch/next'
```

To pass options or callbacks, call it yourself:

```ts
import { register as registerDoxaWatch } from '@doxa-innovations/watch/next'
export { onRequestError } from '@doxa-innovations/watch/next'

export function register() {
  registerDoxaWatch({
    // Who made this request? Return null for guests.
    resolveUser: async (request) => {
      const session = await getSession(request.headers) // your own code
      return session ? { id: session.userId, name: session.name, username: session.email } : null
    },
    // Rewrite what is sent about a request (headers are already redacted).
    redactRequest: (request) => ({ ...request, url: request.url.replace(/token=[^&]+/, 'token=[redacted]') }),
    // Return true to leave a request unrecorded.
    ignore: (request) => request.path.startsWith('/internal/'),
  })
}
```

In the Edge runtime both hooks do nothing, so the same file works for both runtimes.

If `resolveUser` needs code that only runs on Node.js (a `pg` pool, better-auth, an ORM), a top-level import of it
breaks the build of an app that has a `middleware.ts`: Next compiles `instrumentation.ts` for the Edge runtime as
well. Import it inside the Node.js branch, which Next leaves out of the Edge build:

```ts
export { onRequestError } from '@doxa-innovations/watch/next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { register: registerDoxaWatch } = await import('@doxa-innovations/watch/next')
    const { resolveUser } = await import('./lib/watch-user') // imports your session code
    registerDoxaWatch({ resolveUser })
  }
}
```

`resolveUser` runs for every recorded request: return `null` early when there is no session cookie, and remember a
looked-up session for a short while instead of querying the database each time.

### 2. `next.config.ts`

```ts
import { withDoxaWatch } from '@doxa-innovations/watch/next'

export default withDoxaWatch(nextConfig)
```

`withDoxaWatch` turns on `experimental.serverSourceMaps` and `productionBrowserSourceMaps`, and adds `@doxa-innovations/watch`,
`@opentelemetry/api`, `@opentelemetry/sdk-trace-base` and `source-map-js` to `serverExternalPackages`, so that
`output: "standalone"` copies them into the image. It accepts a config object, a function or an async function.

It also keeps `nodemailer` external (like `pg`, which Next keeps external by itself), so that the SDK patches the
copy your app uses, and sets `experimental.serverMinification: false` so that stack traces carry your function names
instead of the minifier's. Set `experimental.serverMinification` yourself to keep your own value.

### 3. Build script

```json
{ "scripts": { "build": "next build && doxa-watch postbuild" } }
```

`doxa-watch postbuild` does two things after `next build`:

- It copies the server source maps into `.next/standalone`. Turbopack builds (the default from Next 16) leave the
  maps of the server chunks out of the standalone output; without them an exception is still reported, but with the
  location in the built file instead of your source file. With webpack the maps are already there.
- It takes the browser source maps out of the public folder: every `.next/static/**/*.map` moves to
  `.next/doxa-watch/maps/` (and into `.next/standalone/.next/doxa-watch/maps/`), and the `sourceMappingURL` comments
  are removed from the built `.js` and `.css` files. See *Browser errors and web vitals* below.

Running it twice changes nothing. Do not leave it out: `withDoxaWatch` makes Next write browser source maps, and
without `postbuild` they stay in `.next/static`, where anybody can download them.

### 4. Environment

Set `DOXA_WATCH_TOKEN` (the environment token from Doxa Watch) where the server runs. That is the only required
variable.

## Browser errors and web vitals

Three small files report what happens in the visitor's browser: uncaught errors, unhandled promise rejections,
errors caught by your error boundaries, and the web vitals LCP, INP, CLS, FCP and TTFB.

```tsx
// app/doxa-watch.tsx
'use client'

export { DoxaWatchClient } from '@doxa-innovations/watch/next/client'
```

```tsx
// app/layout.tsx
import { DoxaWatchClient } from './doxa-watch'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DoxaWatchClient />
        {children}
      </body>
    </html>
  )
}
```

```ts
// app/api/doxa-watch/route.ts
export { POST } from '@doxa-innovations/watch/next/tunnel'
```

```tsx
// app/error.tsx and app/global-error.tsx
'use client'

import { captureException } from '@doxa-innovations/watch/next/client'
import { useEffect } from 'react'

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => captureException(error), [error])
  return <p>Something went wrong.</p> // global-error.tsx renders its own <html> and <body>
}
```

The first file is needed because `withDoxaWatch` keeps `@doxa-innovations/watch` out of the server bundle: a layout is a server
component, and it can only hand a client component to the browser through a `'use client'` file of your own app.
Importing `DoxaWatchClient` from `@doxa-innovations/watch/next/client` directly in a layout renders nothing and reports nothing.
`captureException` can be imported directly, because `error.tsx` is itself a client file.

**How it works.** The browser never talks to Doxa Watch. `<DoxaWatchClient />` (about 1.8 kB gzipped, no
dependencies) posts small JSON batches to the route above with `navigator.sendBeacon` (or `fetch` with `keepalive`):
shortly after an error, and when the page is hidden or left. The route builds the records on the server and sends
them with everything else. Everything a page load reports carries one page-load id, so its errors and vitals can be
read together.

- **Errors.** At most 10 per page load; an error with the same name, message and top frame is sent once.
  `Script error.` (a cross-origin script, nothing to report) and errors thrown from a browser extension's code are
  dropped. So is the error `error.tsx` receives when a Server Component failed: in a production build it is React's
  stand-in without the message, and the server has already reported the real error with its request.
  Errors from `captureException` are reported as handled, the others as unhandled. Stack frames are
  resolved to your source files, with code lines, from the maps `postbuild` moved; a frame without a map is kept as
  it was built.
- **Web vitals** come from Next's own `useReportWebVitals`. Each metric is sent once per page load and belongs to
  the route the document was loaded on. The rating is the browser's; device class and browser name come from the
  user agent.
- **Route.** The route pattern (`/deals/[id]`) is rebuilt from `usePathname()` and `useParams()`, because Next has
  no client API for it. An optional catch-all (`[[...slug]]`) reads as `[...slug]`; a parameter whose value equals
  an earlier static segment of the path replaces that segment; without a match the concrete path is used.
- **User.** The `resolveUser` callback given to `register()` is applied to the tunnel request (it carries the
  visitor's cookies).
- **Sampling.** `DOXA_WATCH_VITALS_SAMPLE_RATE` is applied by the tunnel, once per page load: the decision is a
  function of the page-load id, so a page load reports all of its vitals or none. It is read where the server runs,
  so it needs no rebuild. Optionally pass the same number as `<DoxaWatchClient vitalsSampleRate={0.25} />`: the
  browser then makes the same decision itself and unsampled visitors send no vitals at all. Browser errors follow
  `DOXA_WATCH_EXCEPTION_SAMPLE_RATE`.

**The tunnel** answers `204` with an empty body whatever happens. It forwards nothing when the post is not from a
page of the same origin (`sec-fetch-site`, else `Origin` against the request's host), is larger than 64 kB, comes
from an IP that already sent 60 posts in the last minute (counted in memory, per server process), or is not the
expected shape; inside a valid post, a single invalid item is dropped by itself. Without `DOXA_WATCH_TOKEN` it does
nothing. To change the defaults:

```ts
// app/api/doxa-watch/route.ts
import { createTunnel } from '@doxa-innovations/watch/next/tunnel'

export const POST = createTunnel({
  resolveUser: async (request) => null, // instead of the one given to register()
  rateLimit: 60,                        // posts per IP per minute
  maxBodyBytes: 64 * 1024,
  mapsDir: '.next/doxa-watch/maps',     // if your dist directory is not .next
})
```

If the route lives elsewhere, tell the client: `<DoxaWatchClient endpoint="/api/telemetry" />` (it must be on the
same origin; only `/api/doxa-watch` is left out of the request records automatically — use `ignore` for another
path).

**Docker.** `postbuild` has already copied the maps into `.next/standalone`, and `.next/static` no longer contains
any, so the usual two lines are enough:

```dockerfile
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
```

If your Dockerfile does not take `.next/standalone` as a whole, or runs `next build` in one stage and `doxa-watch
postbuild` nowhere, add the build script from step 3 and this line:

```dockerfile
COPY --from=builder /app/.next/doxa-watch ./.next/doxa-watch
```

Without the maps folder browser errors are still reported, with the locations in the built files.

**Privacy.**

- The environment token never reaches the browser; the browser only knows the same-origin route.
- Query strings and fragments are never sent: the client reports `location.pathname`, and the tunnel cuts anything
  after `?` or `#` again.
- Source maps are not published: after `postbuild` no `.map` file is under `/_next/static`, and `.next/doxa-watch`
  is not served by Next.
- The tunnel reads no file because a reported stack names it: maps are looked up only inside the maps folder.
- No cookies, storage or fingerprinting: the page-load id is random and lives as long as the document.

## What is recorded

| Record | From |
|---|---|
| Requests | Every request the Node HTTP server receives: method, URL, status, duration, sizes, IP (`x-forwarded-for`), redacted headers, the route pattern (`/deals/[id]`) and render time from Next's own OpenTelemetry spans. Static assets, `/_next/*`, health checks (`/health`, `/healthz`, `/api/health`, …) and `/api/doxa-watch` are skipped. |
| Exceptions | `onRequestError` (unhandled, in a request), `watch.captureException` (handled), `uncaughtException` and `unhandledRejection` (the process behaves exactly as it would without the SDK). Stack frames are resolved to your source files and carry ±5 lines of code, taken from the source maps — the image needs no source tree. |
| Outgoing requests | Everything sent with `fetch` (undici), including connection failures (`status_code: 0`). |
| Logs | `console.warn` / `console.error` (see `DOXA_WATCH_LOG_LEVEL`) and `watch.log.<level>()`. |
| Users | `watch.setUser()` or the `resolveUser` callback. |
| Browser exceptions | `<DoxaWatchClient />` (uncaught errors, unhandled rejections) and `captureException` from `@doxa-innovations/watch/next/client`, through the tunnel route. |
| Web vitals | LCP, INP, CLS, FCP, TTFB per page load, with route, device class and browser. |
| Queries | Everything sent through [`pg`](https://node-postgres.com) — also by drizzle, better-auth and other libraries that run on it: the statement with its placeholders, the database name, the duration and the line of your code that issued it. Bind values never leave the process. |
| Mail | Every message sent through [nodemailer](https://nodemailer.com): transport, subject, the number of recipients and attachments, the duration and whether sending failed. Addresses are never sent. |
| Jobs, scheduled tasks, commands | What you wrap in `watch.job`, `watch.scheduledTask` and `watch.command` (see *Manual API*). |

### Queries

Nothing to set up: when `pg` is installed, `register()` instruments it. A query made with `pool.query` is recorded
once, as are queries on a client you checked out yourself; failed queries are recorded too.

Values written into the statement text itself are part of the statement. Rewrite it with `redactQuery`:

```ts
registerDoxaWatch({
  redactQuery: (query) => ({ sql: query.sql.replace(/'[^']*'/g, "'?'") }),
})
```

If your server bundles `pg` (you removed it from `serverExternalPackages`, or you bundle a plain Node app), hand
the SDK the copy you import:

```ts
import pg from 'pg'
import { instrumentPg } from '@doxa-innovations/watch'

instrumentPg(pg)
```

### Mail

Nothing to set up either: every transporter made with `nodemailer.createTransport` reports its `sendMail` calls.
To tell your messages apart in Doxa Watch, name them — the `watch` key is removed before nodemailer sees the options:

```ts
const message = { to, subject: 'Welcome aboard', html, watch: { name: 'WelcomeMail' } }
await transporter.sendMail(message)
```

(With TypeScript, build the options in a variable as above: nodemailer's types do not know the `watch` key and
reject it in an object written directly inside the call.)

For a bundled nodemailer: `instrumentNodemailer(nodemailer)` with the module's default export, or with a transporter
you already created.

## Environment variables

| Variable | Default | |
|---|---|---|
| `DOXA_WATCH_TOKEN` | — | Environment token. Without it the SDK is inert. |
| `DOXA_WATCH_BASE_URL` | `https://watch-ingest.doxaplc.com` | Where Doxa Watch is. |
| `DOXA_WATCH_ENABLED` | `true` | `false` switches everything off. |
| `DOXA_WATCH_DEPLOY` | `GIT_SHA`, then `SOURCE_COMMIT`, then Next's build id | The deploy the records belong to. |
| `DOXA_WATCH_SERVER` | host name | Server name shown in Doxa Watch. |
| `DOXA_WATCH_REQUEST_SAMPLE_RATE` | `1.0` | Share of requests recorded (0–1). |
| `DOXA_WATCH_EXCEPTION_SAMPLE_RATE` | `1.0` | Chance that an exception in an unsampled request is recorded anyway, with its request. |
| `DOXA_WATCH_VITALS_SAMPLE_RATE` | `1.0` | Share of page loads whose web vitals are recorded (0–1). |
| `DOXA_WATCH_LOG_LEVEL` | `warning` | Lowest level captured from `console.*` (`debug`, `info`, `warning`, `error`). `watch.log` always sends. |
| `DOXA_WATCH_IGNORE_OUTGOING_REQUESTS` | `false` | Do not record outgoing requests. |
| `DOXA_WATCH_IGNORE_QUERIES`, `DOXA_WATCH_IGNORE_MAIL` | `false` | Do not record queries / mail. |
| `DOXA_WATCH_REDACT_HEADERS` | `authorization,cookie,proxy-authorization,x-xsrf-token` | Request headers whose values are replaced by `[N bytes redacted]`. |
| `DOXA_WATCH_CAPTURE_EXCEPTION_SOURCE_CODE` | `true` | Send the code lines around each application frame. |
| `DOXA_WATCH_DEBUG` | `false` | Print what the SDK is doing, and its own failures. |

Every value can also be passed to `register({ … })` in camelCase (`requestSampleRate`, `logLevel`, …); code wins over
the environment.

## Manual API

```ts
import { watch } from '@doxa-innovations/watch'

watch.captureException(error)                         // a handled error; attaches to the current request
watch.setUser({ id, name, username })                 // who the current request belongs to
watch.log.info('invoice sent', { invoice: 42 })       // debug, info, notice, warning, error, critical, alert, emergency
await watch.flush()                                   // send what is buffered now and wait for it
```

Work that is not a request — a queue worker, a cron job, a script — is recorded when you wrap it:

```ts
// One attempt of a job. The options are optional: queue, connection, attempt (1-based), jobId.
await watch.job('SendInvoice', { queue: 'default' }, async () => { … })

// One run of a scheduled task, with its cron expression. Optional fourth argument: { timezone }.
await watch.scheduledTask('nightly-sync', '0 2 * * *', async () => { … })

// A standalone script (node scripts/import.js). Starts the collector if nothing did, and sends before it returns.
await watch.command('import-contacts', async () => { … })
```

Each wrapper returns what your function returns. Queries, fetches, mail, logs and exceptions inside belong to the
job, task or command. If your function throws, the run is recorded as failed (exit code 1 for a command) together
with the exception, and the error is thrown on to you. A job run inside a request stays on that request's trace.

All of it is safe to call when the SDK is inert, and nothing the SDK does throws.

Outside Next.js, start the collector yourself:

```ts
import { register } from '@doxa-innovations/watch'

register() // reads the environment; accepts the same options as above
```

## If you already use OpenTelemetry

`register()` installs a tracer provider with a single span processor and no exporter, only to read Next's own spans.
If your app registers its own provider, pass `tracing: false` and add the processor to yours:

```ts
import { DoxaWatchSpanProcessor, register } from '@doxa-innovations/watch/next'

register({ tracing: false })
new NodeTracerProvider({ spanProcessors: [new DoxaWatchSpanProcessor(), /* yours */] }).register()
```

## Command line

```sh
npx doxa-watch deploy [deploy] [--ref <git ref>] [--name <name>] [--url <link>]
npx doxa-watch postbuild [--dist-dir .next]
npx doxa-watch status
```

- `deploy` tells Doxa Watch that a deploy happened (run it from CI after the image is pushed). The deploy value is
  the argument, else `DOXA_WATCH_DEPLOY` / `GIT_SHA` / `SOURCE_COMMIT`, else `.next/BUILD_ID`. It always exits 0.
- `postbuild` is described under *Build script*.
- `status` checks that Doxa Watch is reachable and accepts the token; exit code 0 or 1.

## How it sends

Records are buffered in the process and posted gzip-compressed every 5 seconds, at 500 records or at 1 MB, with at
most two requests in flight. A batch that fails is dropped, never retried. At most 5,000 records wait in memory; beyond
that the oldest are dropped. Exceptions are sent at once. On `SIGTERM` and when the process ends, what is still
buffered is sent with a 2 second budget.

## Limits

- Edge runtime: nothing is recorded. Middleware on the Edge runtime (the default on Next 15) is not timed; Next 16's
  `proxy.ts` runs on Node.js and is.
- Turbopack builds (the default from Next 16) minify server code whatever `experimental.serverMinification` says, so
  function names in a stack trace are the minified ones there; files, lines and code are the original ones.
- Queries are recorded for `pg` only; `pg-native` and other drivers are not. Mail is recorded for nodemailer only.
- Request bodies are never sent.
- Browser reporting is written for the App Router. With a `basePath`, pass the full path of the route as
  `endpoint`. The tunnel's rate limit is per server process, not shared between replicas.

## Development

```sh
npm test            # unit tests (Vitest)
npm run typecheck
npm run test:e2e    # packs the SDK, builds fixtures/next15 and fixtures/next16, runs their standalone servers
```

The end-to-end tests drive a real browser: run `npx playwright install chromium` once.
The end-to-end run starts a throwaway Postgres container (`postgres:16-alpine`, or `E2E_POSTGRES_IMAGE`) on a free
local port and removes it afterwards; without Docker the cases that need a database are skipped and say so.

## Licence

MIT © Doxa Innovations PLC
