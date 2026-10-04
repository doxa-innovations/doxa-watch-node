// Shared by the browser bundle and the server hook. Keep it free of imports.

const OMITTED = 'An error occurred in the Server Components render.'

/**
 * In a production build React replaces an error thrown by a Server Component with a stand-in before it reaches
 * server rendering and the browser: the message below, no useful stack, and the original's `digest`. Next hands that
 * stand-in to `onRequestError` again (when the HTML render fails on it) and to `error.tsx`. The real error was
 * reported by `onRequestError` first, with its own message and stack, so the stand-in would only open a second issue
 * that says nothing.
 */
export function isServerErrorStandIn(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const { digest, message } = error as { digest?: unknown; message?: unknown }
  return typeof digest === 'string' && typeof message === 'string' && message.startsWith(OMITTED)
}
