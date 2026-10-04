export const dynamic = 'force-dynamic'

export async function GET() {
  const upstream = await fetch(`${process.env.UPSTREAM_URL}/upstream/items?page=2`, { cache: 'no-store' })
  const body = (await upstream.json()) as { ok: boolean }
  return Response.json({ hello: 'world', upstream: body.ok })
}
