'use client'

function explodeInBrowser(): never {
  throw new RangeError('button exploded')
}

export default function ClickPage() {
  return (
    <button id="throw" type="button" onClick={() => explodeInBrowser()}>
      Throw in an event handler
    </button>
  )
}
