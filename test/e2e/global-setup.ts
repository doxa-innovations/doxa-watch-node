import { FIXTURES, buildFixture, packSdk } from './harness'

/** Once per run: pack the SDK, install it into both fixture apps, build them. `E2E_SKIP_BUILD=1` reuses the builds. */
export default function setup(): void {
  if (process.env.E2E_SKIP_BUILD === '1') return
  packSdk()
  const only = process.env.E2E_FIXTURE
  for (const fixture of FIXTURES) {
    if (only === undefined || only === fixture) buildFixture(fixture)
  }
}
