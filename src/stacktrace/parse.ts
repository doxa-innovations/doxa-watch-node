export interface RawFrame {
  /** As V8 printed it: a path, a `file://` URL, `node:…`, a browser URL, or `""`. */
  file: string
  /** 1-based; 0 when absent. */
  line: number
  /** 1-based; 0 when absent. */
  column: number
  /** `""` for anonymous. */
  function: string
}

const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/

function location(text: string): { file: string; line: number; column: number } {
  const match = LOCATION.exec(text)
  if (match === null) return { file: text === '<anonymous>' || text === 'native' ? '' : text, line: 0, column: 0 }
  return { file: match[1] as string, line: Number(match[2]), column: match[3] === undefined ? 0 : Number(match[3]) }
}

function functionName(name: string): string {
  const cleaned = name.replace(/^async\s+/, '').trim()
  return cleaned === '<anonymous>' ? '' : cleaned
}

/**
 * Parses a V8 (`    at fn (file:line:col)`) or Firefox/Safari (`fn@file:line:col`) stack string, innermost frame
 * first. Lines that are not frames (the message, which may span lines) are skipped.
 */
export function parseStack(stack: unknown): RawFrame[] {
  if (typeof stack !== 'string' || stack === '') return []
  const frames: RawFrame[] = []

  for (const raw of stack.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('at ')) {
      let rest = line.slice(3)
      let name = ''
      if (rest.endsWith(')')) {
        // `fn (location)`; an eval frame nests parentheses: `eval (eval at fn (file:1:2), <anonymous>:1:1)`.
        const open = rest.indexOf(' (')
        if (open !== -1) {
          name = rest.slice(0, open)
          rest = rest.slice(open + 2, -1)
          const evalOrigin = /^eval at .*?\((.*?:\d+:\d+)\)/.exec(rest)
          if (evalOrigin !== null) rest = evalOrigin[1] as string
        }
      }
      frames.push({ ...location(rest.replace(/^async\s+/, '')), function: functionName(name) })
      continue
    }

    const gecko = /^(.*?)@(.+:\d+(?::\d+)?)$/.exec(line)
    if (gecko !== null) {
      frames.push({ ...location(gecko[2] as string), function: functionName(gecko[1] as string) })
    }
  }

  return frames
}
