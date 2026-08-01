import type { Deps } from '../create-app.js'
import { createFakeDb } from './fake-db.js'
import {
  createFakeAppsRepo,
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeInboundMessagesRepo,
  createFakeLinkCodesRepo,
  createFakeOutboundMessagesRepo,
} from './fake-repos.js'

export function createFakeDeps(over: Partial<Deps> = {}): Deps {
  return {
    db: createFakeDb(),
    apps: createFakeAppsRepo([]),
    bots: createFakeBotsRepo([]),
    contacts: createFakeContactsRepo([]),
    linkCodes: createFakeLinkCodesRepo([]),
    telegram: {
      async sendMessage() {
        return { messageId: '1' }
      },
    },
    secrets: () => 'secreto',
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    randomBytes: (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i)),
    inbound: createFakeInboundMessagesRepo([]),
    outbound: createFakeOutboundMessagesRepo([]),
    delivery: {
      async entregar() {
        return { ok: true, status: 200 }
      },
    },
    internalSecret: 'secreto-interno',
    waitUntil: () => {},
    sleep: async () => {},
    ...over,
  }
}
