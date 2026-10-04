import type { Framework } from '../config'
import { MEDIUM_TEXT, type RecordContext, TEXT, type WireRecord, childFields, group, int, now, truncate } from './common'

/** One stack frame after source-map resolution (see `resolveStack`). */
export interface StackFrame {
  /** Path relative to the project root when inside it; built path when unresolved. */
  file: string
  /** 0 when unknown. */
  line: number
  column: number
  /** The function this location lies in; `""` when anonymous. */
  function: string
  /** 1-based line number → source line, ±5 lines; null for vendor or unresolved frames. */
  code: Record<string, string> | null
  vendor: boolean
  /** False when no source map covered the frame and the built location is reported. */
  resolved: boolean
}

export interface ResolvedStack {
  /** First application frame (falls back to the throw site). */
  file: string
  line: number
  frames: StackFrame[]
}

export interface ExceptionInput {
  /** `error.name`. */
  class: string
  message: string
  /** `error.code ?? error.digest ?? ""`, as a string. */
  code: string
  stack: ResolvedStack
  handled: boolean
  /** `"node"` or `"browser"`. */
  runtime: string
  runtimeVersion: string
  framework: Framework
  timestamp?: number
}

/**
 * The `trace` string. The server reads it with PHP's convention (PROTOCOL §4.13): an entry says WHERE a call was made
 * (`file`) and WHAT was called from there (`source`); frame 0 is the throw site with `source: ""`, and the function a
 * location lies in is the `source` of the NEXT entry. A JS stack names the enclosing function on each frame, so the
 * names are shifted down by one: wire[0] = {loc 0, ""}, wire[i] = {loc i, function of frame i-1}.
 */
export function encodeTrace(frames: StackFrame[]): string {
  const trace = frames.map((frame, index) => ({
    file: frame.line > 0 ? `${frame.file}:${frame.line}` : frame.file,
    source: index === 0 ? '' : (frames[index - 1] as StackFrame).function,
    code: frame.code,
  }))
  return truncate(JSON.stringify(trace), MEDIUM_TEXT)
}

/** PROTOCOL §4.13 (v3) with the §9.3 runtime fields. */
export function buildException(context: RecordContext, input: ExceptionInput): WireRecord {
  const file = input.stack.file
  const line = int(input.stack.line)

  return {
    v: 3,
    t: 'exception',
    timestamp: input.timestamp ?? now(),
    ...childFields(context, group(`${input.class},${input.code},${file},${line > 0 ? line : ''}`)),
    class: truncate(input.class, TEXT),
    file: truncate(file, TEXT),
    line,
    message: truncate(input.message, TEXT),
    code: input.code,
    trace: encodeTrace(input.stack.frames),
    handled: input.handled,
    php_version: '',
    laravel_version: '',
    runtime: input.runtime,
    runtime_version: truncate(input.runtimeVersion, 64),
    framework: input.framework.name,
    framework_version: truncate(input.framework.version, 64),
  }
}
