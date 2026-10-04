import { NextResponse } from 'next/server'

// Edge runtime (the default for middleware on Next 15): proves that instrumentation.ts also compiles for Edge.
export function middleware() {
  const response = NextResponse.next()
  response.headers.set('x-fixture-middleware', '1')
  return response
}

export const config = { matcher: ['/deals/:path*'] }
