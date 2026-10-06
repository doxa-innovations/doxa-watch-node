'use server'

import { watch } from '@doxa-innovations/watch'

export async function saveNote(): Promise<{ saved: boolean }> {
  watch.log.notice('note saved')
  return { saved: true }
}
