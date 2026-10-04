import { type RecordContext, TINY_TEXT, type WireRecord, childFields, group, int, truncate } from './common'

export interface MailInput {
  /** The instant sending finished, epoch seconds. */
  timestamp: number
  /** Transport name (`SMTP`, `JSONTransport`, …). */
  mailer: string
  /** The name the app gave the message (`watch: { name }`); `""` otherwise (PROTOCOL §9.6). */
  class: string
  subject: string
  /** Counts only: no address ever goes on the wire. */
  to: number
  cc: number
  bcc: number
  attachments: number
  /** Microseconds. */
  duration: number
  failed: boolean
}

/** PROTOCOL §4.11 with the §9.6 differences. */
export function buildMail(context: RecordContext, input: MailInput): WireRecord {
  return {
    v: 1,
    t: 'mail',
    timestamp: input.timestamp,
    ...childFields(context, group(input.class)),
    mailer: truncate(input.mailer, TINY_TEXT),
    class: truncate(input.class, TINY_TEXT),
    subject: truncate(input.subject, TINY_TEXT),
    to: int(input.to),
    cc: int(input.cc),
    bcc: int(input.bcc),
    attachments: int(input.attachments),
    duration: int(input.duration),
    failed: input.failed === true,
  }
}
