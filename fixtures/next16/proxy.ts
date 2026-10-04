import { NextResponse } from 'next/server'

// Next 16's proxy.ts runs in the Node.js runtime, inside the request's execution.
export function proxy() {
  const response = NextResponse.next()
  response.headers.set('x-fixture-middleware', '1')
  return response
}

export const config = { matcher: ['/deals/:path*'] }
