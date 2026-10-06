import { watch } from '@doxa-innovations/watch'

export const dynamic = 'force-dynamic'

export default async function Deal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  watch.setUser({ id: 42, name: 'Ada Lovelace', username: 'ada@example.com' })
  watch.log.info('deal viewed', { id })
  return <h1>Deal {id}</h1>
}
