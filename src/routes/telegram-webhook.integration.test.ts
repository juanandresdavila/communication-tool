import { Hono } from 'hono'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../db/client.js'
import { createInboundMessagesRepo } from '../db/repositories/inbound-messages.js'
import {
  crearPresupuesto,
  PRESUPUESTO_POR_DEFECTO,
} from '../presupuesto.js'
import {
  createFakeAppsRepo,
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeLinkCodesRepo,
  unApp,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { telegramFalso } from '../test-support/fake-telegram.js'
import { telegramWebhookRoutes } from './telegram-webhook.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_webhook_app'
const SLUG_BOT = '_test_webhook_bot'
const SECRETO = 'secreto-del-webhook'
const UPDATE_ID = 7001

correr('webhook de Telegram contra una base real', () => {
  // Se construye todo en beforeAll: Vitest evalúa el cuerpo de un describe.skip.
  let server: Hono
  let botId = ''
  const pendientes: Promise<unknown>[] = []

  async function limpiar() {
    const c = postgres(DATABASE_URL, { max: 1 })
    await c.unsafe('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    await limpiar()

    const c = postgres(DATABASE_URL, { max: 1 })
    const app = await c.unsafe<{ id: string }[]>(
      `INSERT INTO apps (slug, name, api_key_hash, delivery_url, delivery_secret_env)
       VALUES ($1, 'Test', 'h', 'https://ejemplo.test/inbound', 'S') RETURNING id`,
      [SLUG_APP],
    )
    const filaApp = app[0]
    if (!filaApp) throw new Error('no se creó la app de prueba')

    const bot = await c.unsafe<{ id: string }[]>(
      `INSERT INTO bots (app_id, channel, slug, token_env, webhook_secret_env,
                         unlinked_message)
       VALUES ($1, 'telegram', $2, 'T', 'S', 'x') RETURNING id`,
      [filaApp.id, SLUG_BOT],
    )
    const filaBot = bot[0]
    if (!filaBot) throw new Error('no se creó el bot de prueba')
    botId = filaBot.id
    await c.end()

    server = new Hono()
    server.route(
      '/',
      telegramWebhookRoutes({
        // Lo único real es el repo de entrantes. El bot y la app del doble
        // llevan los ids reales por las FK de inbound_messages.
        inbound: createInboundMessagesRepo(createSql(DATABASE_URL)),
        bots: createFakeBotsRepo([
          unBot({ id: filaBot.id, appId: filaApp.id, slug: SLUG_BOT }),
        ]),
        contacts: createFakeContactsRepo([
          unContacto({ appId: filaApp.id, externalId: '12345' }),
        ]),
        linkCodes: createFakeLinkCodesRepo([]),
        apps: createFakeAppsRepo([
          { hash: 'h', app: unApp({ id: filaApp.id }) },
        ]),
        delivery: { entregar: async () => ({ ok: true, status: 200 }) },
        presupuesto: crearPresupuesto(PRESUPUESTO_POR_DEFECTO),
        telegram: telegramFalso(),
        secrets: () => SECRETO,
        now: () => new Date(),
        sleep: async () => {},
        waitUntil: (p) => {
          pendientes.push(p)
        },
      }),
    )
  }, 30_000)

  afterAll(limpiar, 30_000)

  function posteo() {
    // JSON.stringify escribe el U+0000 como escape; al parsear vuelve a ser el
    // carácter real, que es lo que pasa en producción.
    return server.request(`/webhooks/telegram/${SLUG_BOT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': SECRETO,
      },
      body: JSON.stringify({
        update_id: UPDATE_ID,
        message: {
          message_id: 10,
          chat: { id: 12345, type: 'private' },
          from: { id: 12345, first_name: 'Ju\u0000an' },
          date: 1_785_264_000,
          text: 'ho\u0000la',
        },
      }),
    })
  }

  it('un update con U+0000 da 200 las dos veces y deja una sola fila', async () => {
    const primero = await posteo()
    const repetido = await posteo()
    await Promise.all(pendientes)

    expect([primero.status, repetido.status]).toEqual([200, 200])

    const c = postgres(DATABASE_URL, { max: 1 })
    const filas = await c.unsafe<{ text: string; first_name: string }[]>(
      `SELECT text, raw->'message'->'from'->>'first_name' AS first_name
         FROM inbound_messages WHERE bot_id = $1 AND provider_update_id = $2`,
      [botId, String(UPDATE_ID)],
    )
    await c.end()

    expect(filas).toHaveLength(1)
    expect(filas).toEqual([{ text: 'ho�la', first_name: 'Ju�an' }])
  }, 30_000)
})
