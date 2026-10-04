// nodemailer ships no types and the SDK only needs these few (it is an optional peer, used here by the tests).
declare module 'nodemailer' {
  interface SentInfo {
    message: string | Buffer
    [key: string]: unknown
  }
  interface Transporter {
    sendMail(options: Record<string, unknown>): Promise<SentInfo>
    sendMail(options: Record<string, unknown>, callback: (error: Error | null, info: SentInfo) => void): void
  }
  const nodemailer: { createTransport(options: Record<string, unknown>): Transporter }
  export default nodemailer
}
