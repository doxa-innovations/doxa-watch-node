'use client'

import { captureException } from 'doxa-watch/next/client'
import { useEffect } from 'react'

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => captureException(error), [error])
  return (
    <html lang="en">
      <body>
        <p id="global-error">Something went wrong.</p>
      </body>
    </html>
  )
}
