import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import { createApp } from '../create-app.js'
import type { Bot, Contact } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { createFakeDeps } from '../test-support/fake-deps.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unApp,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { telegramFalso } from '../test-support/fake-telegram.js'
import { messageRoutes } from './messages.js'

function armar(
  opts: {
    contactos?: Contact[]
    bots?: Bot[]
    falla?: boolean
    edicionFalla?: string
  } = {},
) {
  const botonesEnviados: unknown[] = []
  const telegram: TelegramClient = {
    ...telegramFalso(),
    async sendMessage(_token, _chatId, _text, _replyTo, botones) {
      botonesEnviados.push(botones)
      if (opts.falla) {
        throw new Error('Telegram rechazó sendMessage: chat not found')
      }
      return { messageId: 'tg-1' }
    },
    async editMessageText() {
      if (opts.edicionFalla) {
        throw new Error(`Telegram rechazó editMessageText: ${opts.edicionFalla}`)
      }
    },
  }

  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route(
    '/',
    messageRoutes({
      bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
      contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
      outbound: createFakeOutboundMessagesRepo([]),
      telegram,
      secrets: () => 'token',
    }),
  )
  return { server, botonesEnviados }
}

function postear(server: Hono<ConVariablesDeApp>, cuerpo: unknown) {
  return server.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
}

const VALIDO = { userId: 'user-1', text: 'hola', kind: 'reply' }

describe('POST /v1/messages', () => {
  it('manda y devuelve los dos ids', async () => {
    const res = await postear(armar().server, VALIDO)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messageId: 'out-1',
      providerMessageId: 'tg-1',
      status: 'sent',
    })
  })

  it('nunca devuelve el chat_id', async () => {
    const server = armar({
      contactos: [unContacto({ appUserId: 'user-1', externalId: '987654' })],
    }).server
    const cuerpo = await (await postear(server, VALIDO)).text()
    expect(cuerpo).not.toContain('987654')
  })

  it('rechaza un cuerpo sin los campos obligatorios', async () => {
    for (const malo of [
      {},
      { userId: 'user-1', text: 'hola' },
      { userId: 'user-1', kind: 'reply' },
      { userId: '', text: 'hola', kind: 'reply' },
      { userId: 'user-1', text: '', kind: 'reply' },
      { userId: 'user-1', text: 'hola', kind: 'grito' },
    ]) {
      const res = await postear(armar().server, malo)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ code: 'invalid_request' })
    }
  })

  it('rechaza un texto más largo de lo que Telegram acepta', async () => {
    const res = await postear(armar().server, { ...VALIDO, text: 'a'.repeat(4097) })
    expect(res.status).toBe(400)
  })

  it('devuelve 404 not_linked si el usuario no vinculó', async () => {
    const res = await postear(armar({ contactos: [] }).server, VALIDO)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'not_linked' })
  })

  it('devuelve 502 si el proveedor rechaza', async () => {
    const res = await postear(armar({ falla: true }).server, VALIDO)

    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'send_failed' })
  })

  it('devuelve 500 si la app no tiene bot configurado', async () => {
    // No es culpa del request: es configuración nuestra que falta.
    const res = await postear(armar({ bots: [] }).server, VALIDO)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ code: 'no_bot' })
  })

  it('repite la misma respuesta ante la misma clave de idempotencia', async () => {
    const server = armar().server
    const cuerpo = { ...VALIDO, idempotencyKey: 'k-1' }

    const primera = await (await postear(server, cuerpo)).json()
    const segunda = await (await postear(server, cuerpo)).json()

    expect(segunda).toEqual(primera)
  })

  it('acepta y guarda el template sin usarlo en Telegram', async () => {
    const res = await postear(armar().server, {
      ...VALIDO,
      kind: 'notification',
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })
    expect(res.status).toBe(200)
  })

  it('manda los botones a Telegram tal cual vinieron', async () => {
    const { server, botonesEnviados } = armar()
    const buttons = [[{ text: 'Tarea', data: 's1:abc:t:tarea' }]]

    const res = await postear(server, { ...VALIDO, buttons })

    expect(res.status).toBe(200)
    expect(botonesEnviados).toEqual([buttons])
  })

  it('rechaza con 400 un teclado inválido', async () => {
    const res = await postear(armar().server, {
      ...VALIDO,
      buttons: [[{ text: 'x', data: 'a'.repeat(61) + '🎓' }]],
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'invalid_request' })
  })
})

describe('POST /v1/messages montado en la app completa', () => {
  it('devuelve 401 sin Authorization', async () => {
    const app = createApp(createFakeDeps())
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALIDO),
    })
    expect(res.status).toBe(401)
  })
})

function editar(server: Hono<ConVariablesDeApp>, cuerpo: unknown) {
  return server.request('/v1/messages/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
}

const EDICION = { userId: 'user-1', messageId: '77', text: '✅ Guardado' }

describe('POST /v1/messages/edit', () => {
  it('edita y contesta 200', async () => {
    const res = await editar(armar().server, EDICION)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'edited' })
  })

  it('rechaza un messageId que no es un entero', async () => {
    const res = await editar(armar().server, { ...EDICION, messageId: 'abc' })
    expect(res.status).toBe(400)
  })

  it('rechaza un teclado inválido', async () => {
    const res = await editar(armar().server, {
      ...EDICION,
      buttons: [[{ text: 'x' }]],
    })
    expect(res.status).toBe(400)
  })

  it('devuelve 404 not_linked si el usuario no vinculó', async () => {
    const res = await editar(armar({ contactos: [] }).server, EDICION)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'not_linked' })
  })

  it('devuelve 502 si Telegram rechaza la edición', async () => {
    const res = await editar(
      armar({ edicionFalla: 'Bad Request: message to edit not found' }).server,
      EDICION,
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'edit_failed' })
  })

  it('devuelve 401 sin Authorization en la app completa', async () => {
    const app = createApp(createFakeDeps())
    const res = await app.request('/v1/messages/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EDICION),
    })
    expect(res.status).toBe(401)
  })
})
