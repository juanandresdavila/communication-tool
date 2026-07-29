import type { Hono } from 'hono'
import { createTelegramClient } from './channels/telegram/client.js'
import { createApp } from './create-app.js'
import { createDb, createSql } from './db/client.js'
import { createAppsRepo } from './db/repositories/apps.js'
import { createBotsRepo } from './db/repositories/bots.js'
import { createContactsRepo } from './db/repositories/contacts.js'
import { createLinkCodesRepo } from './db/repositories/link-codes.js'
import { parseEnv } from './env.js'
import { createSecretReader } from './secrets.js'

// Único lugar del servicio que lee process.env.
const env = parseEnv(process.env)
const sql = createSql(env.DATABASE_URL)

// El `import type { Hono }` y esta anotación NO son decorativos: el preset de
// Hono de Vercel rechaza cualquier entrypoint que no importe hono.
// Ver CLAUDE.md, §Gotchas del tooling.
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
})

// El default export es lo que consumen tanto Vercel como Bun.
export default app
