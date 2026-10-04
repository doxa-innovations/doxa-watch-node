'use client'

import { captureException } from 'doxa-watch/next/client'

export default function ItemPage() {
  return (
    <button id="report" type="button" onClick={() => captureException(new SyntaxError('item rejected'))}>
      Report a handled error
    </button>
  )
}
