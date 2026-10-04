import nodemailer from 'nodemailer'

export const dynamic = 'force-dynamic'

const json = nodemailer.createTransport({ jsonTransport: true })
const stream = nodemailer.createTransport({ streamTransport: true, buffer: true })

export async function GET() {
  // In a variable, so TypeScript accepts the extra `watch` key that names the message for Doxa Watch.
  const message = {
    from: 'crm@example.com',
    to: 'ada@example.com, "Hopper, Grace" <grace@example.com>',
    cc: ['bob@example.com'],
    bcc: { name: 'Audit', address: 'audit@example.com' },
    subject: 'Welcome aboard',
    text: 'Hello',
    attachments: [{ filename: 'terms.txt', content: 'terms' }],
    watch: { name: 'WelcomeMail' },
  }
  const welcome = await json.sendMail(message)
  const plain = await stream.sendMail({ from: 'crm@example.com', to: 'ada@example.com', subject: 'Receipt', text: 'Thanks' })

  return Response.json({
    // What nodemailer was given: the SDK's own key must not be in it.
    keys: Object.keys(JSON.parse(String(welcome.message)) as Record<string, unknown>),
    receipt: String(plain.message).includes('Subject: Receipt'),
  })
}
