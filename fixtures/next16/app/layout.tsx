import { DoxaWatchClient } from './doxa-watch'
import type { ReactNode } from 'react'

export const metadata = { title: 'doxa-watch fixture' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DoxaWatchClient />
        {children}
      </body>
    </html>
  )
}
