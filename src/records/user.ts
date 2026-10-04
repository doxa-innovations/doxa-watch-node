import type { WatchUser } from '../config'
import { TINY_TEXT, type WireRecord, now, truncate } from './common'

/** PROTOCOL §4.15: only `v`, `t`, `timestamp`, `id`, `name`, `username`. */
export function buildUser(user: WatchUser, timestamp: number = now()): WireRecord {
  return {
    v: 1,
    t: 'user',
    timestamp,
    id: truncate(String(user.id), TINY_TEXT),
    name: truncate(user.name ?? '', TINY_TEXT),
    username: truncate(user.username ?? '', TINY_TEXT),
  }
}
