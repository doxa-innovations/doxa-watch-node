import { createTunnel } from 'doxa-watch/next/tunnel'

// The other fixture re-exports the ready-made POST; this one shows the options. A real app reads its session here.
export const POST = createTunnel({
  resolveUser: (request) => {
    const match = /(?:^|;\s*)fixture_user=(\d+)/.exec(String(request.headers.cookie ?? ''))
    return match ? { id: match[1] as string, name: 'Grace Hopper', username: 'grace@example.com' } : null
  },
})
