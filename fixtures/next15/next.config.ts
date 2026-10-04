import type { NextConfig } from 'next'
import { withDoxaWatch } from 'doxa-watch/next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // The fixture lives inside the SDK repository: keep Next from treating that as the workspace root.
  outputFileTracingRoot: __dirname,
}

export default withDoxaWatch(nextConfig)
