import { readFileSync, rmSync } from 'node:fs'
import { type Options, defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

const shared: Options = {
  format: ['esm', 'cjs'],
  target: 'node18',
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  define: { __DOXA_WATCH_VERSION__: JSON.stringify(version) },
  external: ['next', 'react', 'react-dom'],
}

// Cleaned here, once, instead of with tsup's `clean`: the three builds below run side by side, and a build that
// cleans also deletes the declaration files another build has already written (the browser entry's were lost).
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true })

// One entry per public subpath (see "exports" in package.json). Adding files under src/records, src/sensors or
// src/next/{client,tunnel} needs no change here: they are pulled in through these entry points.
export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'src/index.ts',
      'next/index': 'src/next/index.ts',
      'next/edge': 'src/next/edge.ts',
      'next/tunnel/index': 'src/next/tunnel/index.ts',
    },
  },
  {
    ...shared,
    entry: { 'next/client/index': 'src/next/client/index.tsx' },
    platform: 'browser',
    target: 'es2020',
    shims: false,
    banner: { js: "'use client';" },
  },
  {
    ...shared,
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['cjs'],
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
