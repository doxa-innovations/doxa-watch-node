export const dynamic = 'force-dynamic'

function explodeInPage(): never {
  throw new TypeError('page exploded')
}

export default function Boom() {
  explodeInPage()
}
