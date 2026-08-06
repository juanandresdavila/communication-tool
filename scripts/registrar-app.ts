import postgres from 'postgres'
import { hashApiKey } from '../src/identity/api-key.js'

/**
 * Da de alta una app y su bot, o los actualiza si ya existen.
 *
 *   bun run scripts/registrar-app.ts \
 *     --slug study-master --name "Study Master" \
 *     --api-key "$KEY" \
 *     --delivery-url https://study.example/api/messaging/inbound \
 *     --schedule-url https://study.example/api/messaging/schedule \
 *     --delivery-secret-env DELIVERY_SECRET_STUDY \
 *     --bot-slug study --bot-username studymasterjaddbot \
 *     --token-env TELEGRAM_TOKEN_STUDY \
 *     --webhook-secret-env TELEGRAM_WEBHOOK_SECRET_STUDY
 *
 * Guarda el NOMBRE de cada variable de entorno, nunca su valor: es la
 * invariante del spec y lo que hace que mudar de host sea copiar un .env.
 *
 * Es idempotente: se usa también para rotar la API key de una app existente.
 */
function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function exigido(nombre: string): string {
  const v = arg(nombre)
  if (!v) {
    console.error(`Falta --${nombre}. Ver el encabezado del script.`)
    process.exit(1)
  }
  return v
}

const slug = exigido('slug')
const name = exigido('name')
const apiKey = exigido('api-key')
const deliveryUrl = exigido('delivery-url')
const scheduleUrl = arg('schedule-url') ?? null
const deliverySecretEnv = exigido('delivery-secret-env')
const botSlug = exigido('bot-slug')
const botUsername = arg('bot-username') ?? null
const tokenEnv = exigido('token-env')
const webhookSecretEnv = exigido('webhook-secret-env')
const unlinked =
  arg('unlinked-message') ??
  `Hola. Para usar este bot vinculá tu cuenta: entrá a ${name}, generá un código y mandámelo con /vincular <código>.`

const urlBase = process.env.DATABASE_URL
if (!urlBase) throw new Error('Falta DATABASE_URL')
const client = postgres(urlBase, { max: 1 })

const rows = await client.unsafe<{ id: string }[]>(
  `INSERT INTO apps (slug, name, api_key_hash, delivery_url,
                     schedule_callback_url, delivery_secret_env)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (slug) DO UPDATE
   SET name = EXCLUDED.name,
       api_key_hash = EXCLUDED.api_key_hash,
       delivery_url = EXCLUDED.delivery_url,
       schedule_callback_url = EXCLUDED.schedule_callback_url,
       delivery_secret_env = EXCLUDED.delivery_secret_env
   RETURNING id`,
  [slug, name, hashApiKey(apiKey), deliveryUrl, scheduleUrl, deliverySecretEnv],
)
const fila = rows[0]
if (!fila) throw new Error('El INSERT de apps no devolvió el id')

// El ON CONFLICT va por `slug` y no por (app_id, channel), aunque ese único
// también exista: el slug es lo que viaja en la URL del webhook y lo que
// identifica al bot de forma estable entre corridas.
await client.unsafe(
  `INSERT INTO bots (app_id, channel, slug, username, token_env,
                     webhook_secret_env, unlinked_message)
   VALUES ($1, 'telegram', $2, $3, $4, $5, $6)
   ON CONFLICT (slug) DO UPDATE
   SET username = EXCLUDED.username,
       token_env = EXCLUDED.token_env,
       webhook_secret_env = EXCLUDED.webhook_secret_env,
       unlinked_message = EXCLUDED.unlinked_message`,
  [fila.id, botSlug, botUsername, tokenEnv, webhookSecretEnv, unlinked],
)

console.log(`app ${slug}: ${fila.id}`)
console.log(`bot ${botSlug}: webhook en /webhooks/telegram/${botSlug}`)
await client.end()
