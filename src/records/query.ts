import { MEDIUM_TEXT, type RecordContext, TINY_TEXT, type WireRecord, childFields, group, int, truncate } from './common'

export interface QueryInput {
  /** Start of the query, epoch seconds. */
  timestamp: number
  /** Statement text with placeholders, after the app's redaction. Bind values are never part of it. */
  sql: string
  /** First application frame of the caller; `""` when unknown. */
  file: string
  line: number
  /** Microseconds. */
  duration: number
  /** Database name (PROTOCOL §9.6). */
  connection: string
  /** `""` for the Node SDK (PROTOCOL §9.6). */
  connectionType?: string
}

/**
 * The statement as it is hashed for `_group` (PROTOCOL §4.8): lists of placeholders and digits after `in` collapse to
 * `in (...?)`, and the tuples after `values` of an insert collapse to `values ...`, so the same statement with a
 * different number of bindings stays in one group. On top of the PHP rule, `$1`-style placeholders are understood and
 * the keywords match in either case (hand-written SQL is often upper-case).
 */
export function normaliseSql(sql: string): string {
  let normalised = sql.replace(/\b(in) \([\d?$\s,]+\)/gi, '$1 (...?)')
  if (/insert/i.test(normalised)) normalised = normalised.replace(/\b(values) [(?$\d,\s)]+/gi, '$1 ...')
  return normalised
}

/** PROTOCOL §4.8 with the §9.6 differences. */
export function buildQuery(context: RecordContext, input: QueryInput): WireRecord {
  return {
    v: 1,
    t: 'query',
    timestamp: input.timestamp,
    ...childFields(context, group(`${input.connection},${normaliseSql(input.sql)}`)),
    sql: truncate(input.sql, MEDIUM_TEXT),
    file: truncate(input.file, TINY_TEXT),
    line: int(input.line),
    duration: int(input.duration),
    connection: truncate(input.connection, TINY_TEXT),
    connection_type: input.connectionType ?? '',
  }
}
