export interface ParsedArgs {
  positional: string[]
  options: Record<string, string>
}

/** `--name value`, `--name=value`, bare `--flag` (→ `"true"`), everything else positional. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const options: Record<string, string> = {}

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals !== -1) {
      options[arg.slice(2, equals)] = arg.slice(equals + 1)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[arg.slice(2)] = next
      index++
    } else {
      options[arg.slice(2)] = 'true'
    }
  }

  return { positional, options }
}
