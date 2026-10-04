# doxa-watch

The Node / Next.js collector for Doxa Watch. It reports requests, exceptions, outgoing
requests, logs and users from a Next.js server straight to Doxa Watch — there is no local agent to run.

- Next.js 15 or 16, Node.js 18.18 or newer, Node.js runtime only.
- Without `DOXA_WATCH_TOKEN` it prints one line at start-up and does nothing else.
- Nothing it does can throw into your app; a Doxa Watch outage costs you the records of that moment, nothing more.

## Install

```sh
npm install doxa-watch
```

### 1. `instrumentation.ts`

```ts
export { register, onRequestError } from 'doxa-watch/next'
```

To pass options or callbacks, call it yourself:

```ts
import { register as registerDoxaWatch } from 'doxa-watch/next'
export { onRequestError } from 'doxa-watch/next'

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

### 2. `next.config.ts`

```ts
import { withDoxaWatch } from 'doxa-watch/next'

export default withDoxaWatch(nextConfig)
```

`withDoxaWatch` turns on `experimental.serverSourceMaps` and `productionBrowserSourceMaps`, and adds `doxa-watch`,
`@opentelemetry/api`, `@opentelemetry/sdk-trace-base` and `source-map-js` to `serverExternalPackages`, so that
`output: "standalone"` copies them into the image. It accepts a config object, a function or an async function.

### 3. Build script

```json
{ "scripts": { "build": "next build && doxa-watch postbuild" } }
```

`doxa-watch postbuild` copies the server source maps into `.next/standalone`. Turbopack builds (the default from
Next 16) leave the maps of the server chunks out of the standalone output; without them an exception is still
reported, but with the location in the built file instead of your source file. With webpack the maps are already
there and the command changes nothing.

### 4. Environment

Set `DOXA_WATCH_TOKEN` (the environment token from Doxa Watch) where the server runs. That is the only required
variable.

## What is recorded

| Record | From |
|---|---|
| Requests | Every request the Node HTTP server receives: method, URL, status, duration, sizes, IP (`x-forwarded-for`), redacted headers, the route pattern (`/deals/[id]`) and render time from Next's own OpenTelemetry spans. Static assets, `/_next/*`, health checks (`/health`, `/healthz`, `/api/health`, …) and `/api/doxa-watch` are skipped. |
| Exceptions | `onRequestError` (unhandled, in a request), `watch.captureException` (handled), `uncaughtException` and `unhandledRejection` (the process behaves exactly as it would without the SDK). Stack frames are resolved to your source files and carry ±5 lines of code, taken from the source maps — the image needs no source tree. |
| Outgoing requests | Everything sent with `fetch` (undici), including connection failures (`status_code: 0`). |
| Logs | `console.warn` / `console.error` (see `DOXA_WATCH_LOG_LEVEL`) and `watch.log.<level>()`. |
| Users | `watch.setUser()` or the `resolveUser` callback. |

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
| `DOXA_WATCH_VITALS_SAMPLE_RATE` | `1.0` | Reserved for web vitals. |
| `DOXA_WATCH_LOG_LEVEL` | `warning` | Lowest level captured from `console.*` (`debug`, `info`, `warning`, `error`). `watch.log` always sends. |
| `DOXA_WATCH_IGNORE_OUTGOING_REQUESTS` | `false` | Do not record outgoing requests. |
| `DOXA_WATCH_IGNORE_QUERIES`, `DOXA_WATCH_IGNORE_MAIL` | `false` | Reserved for queries and mail. |
| `DOXA_WATCH_REDACT_HEADERS` | `authorization,cookie,proxy-authorization,x-xsrf-token` | Request headers whose values are replaced by `[N bytes redacted]`. |
| `DOXA_WATCH_CAPTURE_EXCEPTION_SOURCE_CODE` | `true` | Send the code lines around each application frame. |
| `DOXA_WATCH_DEBUG` | `false` | Print what the SDK is doing, and its own failures. |

Every value can also be passed to `register({ … })` in camelCase (`requestSampleRate`, `logLevel`, …); code wins over
the environment.

## Manual API

```ts
import { watch } from 'doxa-watch'

watch.captureException(error)                         // a handled error; attaches to the current request
watch.setUser({ id, name, username })                 // who the current request belongs to
watch.log.info('invoice sent', { invoice: 42 })       // debug, info, notice, warning, error, critical, alert, emergency
await watch.flush()                                   // send what is buffered now and wait for it
```

All of it is safe to call when the SDK is inert, and none of it throws.

Outside Next.js, start the collector yourself:

```ts
import { register } from 'doxa-watch'

register() // reads the environment; accepts the same options as above
```

## If you already use OpenTelemetry

`register()` installs a tracer provider with a single span processor and no exporter, only to read Next's own spans.
If your app registers its own provider, pass `tracing: false` and add the processor to yours:

```ts
import { DoxaWatchSpanProcessor, register } from 'doxa-watch/next'

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
- Production builds are minified, so function names in a stack trace are the minified ones; files, lines and code
  are the original ones.
- Request bodies are never sent.

## Development

```sh
npm test            # unit tests (Vitest)
npm run typecheck
npm run test:e2e    # packs the SDK, builds fixtures/next15 and fixtures/next16, runs their standalone servers
```

## Licence

MIT © Doxa Innovations PLC
