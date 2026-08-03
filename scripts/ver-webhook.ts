/**
 * A dónde apunta hoy el webhook del bot, según Telegram.
 *
 * **Es lo primero que hay que mirar si un entrante no llega.** Un bot tiene un
 * solo webhook y es exclusivo: el último que llama a `setWebhook` se queda con
 * todos los updates y el anterior deja de recibir sin error ni aviso. Ninguna
 * suite puede detectarlo, porque el registro vive en Telegram y no en el repo.
 *
 * El token no está en el .env de comm-tool —baja como `[SENSITIVE]`—, así que
 * se lee del .env.local de gym-tracker o se pasa por variable:
 *
 *     bun run scripts/ver-webhook.ts
 *     TELEGRAM_BOT_TOKEN=... bun run scripts/ver-webhook.ts
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ESPERADO =
  'https://communication-tool-beta.vercel.app/webhooks/telegram/gym'

async function token(): Promise<string> {
  const delEntorno = process.env.TELEGRAM_BOT_TOKEN
  if (delEntorno) return delEntorno

  const ruta = join(homedir(), 'Projects', 'gym-tracker', '.env.local')
  const texto = await readFile(ruta, 'utf8').catch(() => '')
  const linea = texto.split('\n').find((l) => l.startsWith('TELEGRAM_BOT_TOKEN='))
  const valor = linea?.slice('TELEGRAM_BOT_TOKEN='.length).replace(/^"|"$/g, '')
  if (!valor) {
    throw new Error(
      `No encontré el token. Pasalo con TELEGRAM_BOT_TOKEN=... o dejalo en ${ruta}`,
    )
  }
  return valor
}

const t = await token()
const res = await fetch(`https://api.telegram.org/bot${t}/getWebhookInfo`)
const cuerpo = (await res.json()) as {
  ok?: boolean
  result?: {
    url?: string
    pending_update_count?: number
    last_error_message?: string
    last_error_date?: number
  }
}

if (!cuerpo.ok || !cuerpo.result) {
  // Nunca se imprime la URL de la request: lleva el token.
  throw new Error(`Telegram rechazó getWebhookInfo (estado ${res.status})`)
}

const r = cuerpo.result
console.log('url        :', r.url || '(sin webhook registrado)')
console.log('pendientes :', r.pending_update_count ?? 0)
console.log('último error:', r.last_error_message ?? '(ninguno)')
if (r.last_error_date) {
  console.log('  fecha    :', new Date(r.last_error_date * 1000).toISOString())
}

console.log(
  r.url === ESPERADO
    ? '\nApunta a comm-tool.'
    : `\nOJO: NO apunta a comm-tool.\n  esperado: ${ESPERADO}\n  Los entrantes no están llegando acá. Ver CLAUDE.md, §El corte.`,
)
