import { FIXTURES, buildFixture, packSdk, startPostgres } from './harness'

/**
 * Once per run: a throwaway Postgres for the pg cases (removed again afterwards), then pack the SDK, install it into
 * both fixture apps and build them. `E2E_SKIP_BUILD=1` reuses the builds.
 */
export default function setup(): () => void {
  const postgres = startPostgres()
  // The test files read it from here; unset means "skip the cases that need a database".
  if (postgres !== null) process.env.E2E_DATABASE_URL = postgres.url
  else delete process.env.E2E_DATABASE_URL

  try {
    if (process.env.E2E_SKIP_BUILD !== '1') {
      packSdk()
      const only = process.env.E2E_FIXTURE
      for (const fixture of FIXTURES) {
        if (only === undefined || only === fixture) buildFixture(fixture)
      }
    }
  } catch (error) {
    postgres?.stop()
    throw error
  }

  return () => postgres?.stop()
}
