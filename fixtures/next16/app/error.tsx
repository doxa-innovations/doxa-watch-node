'use client'

import { captureException } from 'doxa-watch/next/client'
import { useEffect } from 'react'

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => captureException(error), [error])
  return <p id="error-boundary">Something went wrong: {error.message}</p>
}
