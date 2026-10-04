import { saveNote } from './actions'

export const dynamic = 'force-dynamic'

export default function ActionPage() {
  return (
    <form
      action={async () => {
        'use server'
        await saveNote()
      }}
    >
      <button type="submit">Save</button>
    </form>
  )
}
