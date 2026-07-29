import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { TelegramClient } from '../channels/telegram/client.js'
import {
  parseCommand,
  parseTelegramUpdate,
} from '../channels/telegram/parse-update.js'
import type { Bot, BotsRepo, ContactsRepo, LinkCodesRepo } from '../db/ports.js'
import { normalizeLinkCode } from '../identity/link-code.js'
import type { SecretReader } from '../secrets.js'

export interface TelegramWebhookDeps {
  bots: BotsRepo
  contacts: ContactsRepo
  linkCodes: LinkCodesRepo
  telegram: TelegramClient
  secrets: SecretReader
  now: () => Date
}

const COMANDOS_DE_VINCULACION = new Set(['vincular', 'link'])

function secretosIguales(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function telegramWebhookRoutes(deps: TelegramWebhookDeps): Hono {
  const rutas = new Hono()

  rutas.post('/webhooks/telegram/:botSlug', async (c) => {
    const bot = await deps.bots.findBySlug(c.req.param('botSlug'))
    if (!bot || !bot.active) return c.json({ code: 'not_found' }, 404)

    const recibido = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? ''
    if (!secretosIguales(recibido, deps.secrets(bot.webhookSecretEnv))) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    const crudo: unknown = await c.req.json().catch(() => null)
    const update = parseTelegramUpdate(crudo)
    // Un update que no sabemos leer (callback_query, edición, encuesta) se
    // acepta y se descarta: devolverle un error a Telegram provocaría
    // reintentos eternos de algo que nunca vamos a poder procesar.
    if (!update) return c.json({ ok: true })

    const token = deps.secrets(bot.tokenEnv)
    const responder = (texto: string) =>
      deps.telegram.sendMessage(token, update.chatId, texto)

    const comando = parseCommand(update.text)
    if (comando && COMANDOS_DE_VINCULACION.has(comando.nombre)) {
      await responder(await vincular(deps, bot, update.chatId, comando.args))
      return c.json({ ok: true })
    }

    const contacto = await deps.contacts.findByExternalId(
      bot.appId,
      'telegram',
      update.chatId,
    )
    if (!contacto) {
      await responder(bot.unlinkedMessage)
      return c.json({ ok: true })
    }

    // FASE 2: acá va el registro en inbound_messages y la entrega a la app
    // con HMAC y reintentos. Por ahora el mensaje de un chat vinculado se
    // reconoce y se descarta.
    return c.json({ ok: true })
  })

  return rutas
}

async function vincular(
  deps: TelegramWebhookDeps,
  bot: Bot,
  chatId: string,
  args: string,
): Promise<string> {
  const code = normalizeLinkCode(args)
  if (!code) {
    return 'Mandame el código junto al comando, por ejemplo: /vincular ABC123'
  }

  // Se valida ANTES de consumir: si canjeáramos primero y después
  // descubriéramos que el chat ya está tomado, el código quedaría quemado.
  const candidato = await deps.linkCodes.find(code)

  // Un código de otra app se reporta como inexistente: no se filtra
  // información entre apps.
  if (!candidato || candidato.appId !== bot.appId) {
    return 'Ese código no existe. Generá uno nuevo desde la app.'
  }
  if (candidato.usedAt !== null) {
    return 'Ese código ya se usó. Generá uno nuevo desde la app.'
  }
  if (new Date(candidato.expiresAt) <= deps.now()) {
    return 'Ese código está vencido. Generá uno nuevo desde la app.'
  }

  const existente = await deps.contacts.findByExternalId(
    bot.appId,
    'telegram',
    chatId,
  )
  if (existente?.appUserId === candidato.appUserId) {
    return 'Ya estabas vinculado. No hace falta hacer nada.'
  }
  if (existente) {
    return 'Este chat ya está vinculado a otra cuenta. Desvinculala primero desde la app.'
  }

  const canjeado = await deps.linkCodes.redeem(code, deps.now())
  if (!canjeado) {
    return 'No se pudo canjear el código. Generá uno nuevo desde la app.'
  }

  await deps.contacts.create({
    appId: bot.appId,
    channel: 'telegram',
    externalId: chatId,
    appUserId: canjeado.appUserId,
  })

  return 'Listo, tu cuenta quedó vinculada.'
}
