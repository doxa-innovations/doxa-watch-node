'use client'

import { useState } from 'react'

function Fragile({ broken }: { broken: boolean }) {
  if (broken) throw new TypeError('render exploded')
  return <p>Fine so far.</p>
}

export default function RenderPage() {
  const [broken, setBroken] = useState(false)
  return (
    <>
      <Fragile broken={broken} />
      <button id="break" type="button" onClick={() => setBroken(true)}>
        Throw during render
      </button>
    </>
  )
}
