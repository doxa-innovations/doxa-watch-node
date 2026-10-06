import { watch } from '@doxa-innovations/watch'

export const dynamic = 'force-dynamic'

function chargeCustomer(): never {
  throw new RangeError('card declined')
}

export async function GET(request: Request) {
  const fail = new URL(request.url).searchParams.has('fail')
  try {
    const result = await watch.job('SendInvoice', { queue: 'invoices', connection: 'inline' }, async () => {
      watch.log.info('sending invoice')
      await fetch(`${process.env.UPSTREAM_URL}/upstream/invoice`)
      if (fail) chargeCustomer()
      return 'sent'
    })
    return Response.json({ result })
  } catch (error) {
    return Response.json({ failed: (error as Error).message }, { status: 500 })
  }
}
