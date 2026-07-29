import type { Hono } from 'hono'
import { createApp } from './create-app.js'
import { createDb, createSql } from './db/client.js'
import { parseEnv } from './env.js'

// Único lugar del servicio que lee process.env.
const env = parseEnv(process.env)
const sql = createSql(env.DATABASE_URL)

const app: Hono = createApp({ db: createDb(sql) })

// El default export es lo que consumen tanto Vercel como Bun.
export default app
