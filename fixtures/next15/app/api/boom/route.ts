export const dynamic = 'force-dynamic'

function explodeInHandler(): never {
  throw new RangeError('handler exploded')
}

export async function GET() {
  explodeInHandler()
}
