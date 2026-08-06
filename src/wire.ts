import type { Hono } from 'hono'
import { createTelegramClient } from './channels/telegram/client.js'
import { createApp } from './create-app.js'
import { createDb, createSql, type Sql } from './db/client.js'
import { createAppsRepo } from './db/repositories/apps.js'
import { createBotsRepo } from './db/repositories/bots.js'
import { createContactsRepo } from './db/repositories/contacts.js'
import { createInboundMessagesRepo } from './db/repositories/inbound-messages.js'
import { createLinkCodesRepo } from './db/repositories/link-codes.js'
import { createOutboundMessagesRepo } from './db/repositories/outbound-messages.js'
import { createSchedulesRepo } from './db/repositories/schedules.js'
import { createDeliveryClient } from './delivery/client.js'
import { parseEnv } from './env.js'
import { createSecretReader } from './secrets.js'

export interface Wired {
  app: Hono
  sql: Sql
}

/**
 * Todo el cableado del servicio, compartido por los dos entrypoints
 * (index.ts para Vercel, server.ts para self-host). `waitUntil` es lo único
 * que difiere entre los dos, por eso es el único parámetro.
 */
export function wireApp(waitUntil: (promesa: Promise<unknown>) => void): Wired {
  // Único lugar del servicio que lee process.env.
  const env = parseEnv(process.env)
  const sql = createSql(env.DATABASE_URL)

  const app: Hono = createApp({
    db: createDb(sql),
    apps: createAppsRepo(sql),
    bots: createBotsRepo(sql),
    contacts: createContactsRepo(sql),
    linkCodes: createLinkCodesRepo(sql),
    telegram: createTelegramClient(),
    secrets: createSecretReader(process.env),
    now: () => new Date(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    inbound: createInboundMessagesRepo(sql),
    outbound: createOutboundMessagesRepo(sql),
    schedules: createSchedulesRepo(sql),
    delivery: createDeliveryClient(),
    internalSecret: env.INTERNAL_SECRET,
    waitUntil,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })

  return { app, sql }
}
