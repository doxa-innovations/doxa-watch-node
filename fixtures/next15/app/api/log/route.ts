export const dynamic = 'force-dynamic'

export async function GET() {
  console.log('below the default level')
  console.error('payment provider said no', new TypeError('card declined'))
  return Response.json({ logged: true })
}
