'use server'

import { watch } from 'doxa-watch'

export async function saveNote(): Promise<{ saved: boolean }> {
  watch.log.notice('note saved')
  return { saved: true }
}
