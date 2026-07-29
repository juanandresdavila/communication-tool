import { Client } from '@neondatabase/serverless'
import { hashApiKey } from '../src/identity/api-key.js'

const [apiKey] = process.argv.slice(2)
if (!apiKey) {
  console.error('Uso: bun run scripts/registrar-app.ts <api-key>')
  process.exit(1)
}

const client = new Client(process.env.DATABASE_URL)
await client.connect()

const { rows } = await client.query<{ id: string }>(
  `INSERT INTO apps (slug, name, api_key_hash, delivery_url, delivery_secret_env)
   VALUES ('gym-tracker', 'GymTracker',
           $1, 'https://gym-tracker.vercel.app/api/messaging/inbound',
           'DELIVERY_SECRET_GYM')
   ON CONFLICT (slug) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash
   RETURNING id`,
  [hashApiKey(apiKey)],
)
const fila = rows[0]
if (!fila) throw new Error('El INSERT de apps no devolvió el id')
const appId = fila.id

await client.query(
  `INSERT INTO bots (app_id, channel, slug, username, token_env,
                     webhook_secret_env, unlinked_message)
   VALUES ($1, 'telegram', 'gym', 'gymtrackerjaddbot', 'TELEGRAM_TOKEN_GYM',
           'TELEGRAM_WEBHOOK_SECRET_GYM',
           'Hola. Para usar este bot vinculá tu cuenta: entrá a GymTracker, generá un código y mandámelo con /vincular <código>.')
   ON CONFLICT (slug) DO NOTHING`,
  [appId],
)

console.log(`app gym-tracker: ${appId}`)
await client.end()
