import { watch } from '@doxa-innovations/watch'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    JSON.parse('{not json')
  } catch (error) {
    watch.captureException(error)
  }
  return Response.json({ handled: true })
}
