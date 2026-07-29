import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Contact, LinkCode } from '../db/ports.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeLinkCodesRepo,
  unBot,
  unContacto,
  unLinkCode,
} from '../test-support/fake-repos.js'
import { telegramWebhookRoutes } from './telegram-webhook.js'

const SECRETO = 'secreto-del-webhook'
const AHORA = new Date('2026-07-28T12:00:00.000Z')

function armar(opts: { contactos?: Contact[]; codigos?: LinkCode[] } = {}) {
  const enviados: { chatId: string; text: string }[] = []
  const contacts = createFakeContactsRepo(opts.contactos ?? [])
  const linkCodes = createFakeLinkCodesRepo(opts.codigos ?? [])

  const server = new Hono()
  server.route(
    '/',
    telegramWebhookRoutes({
      bots: createFakeBotsRepo([unBot()]),
      contacts,
      linkCodes,
      secrets: () => SECRETO,
      now: () => AHORA,
      telegram: {
        async sendMessage(_token, chatId, text) {
          enviados.push({ chatId, text })
          return { messageId: '1' }
        },
      },
    }),
  )

  return { server, enviados, contacts, linkCodes }
}

function update(text: string, chatId = '12345') {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: Number(chatId), type: 'private' },
      date: 1_785_264_000,
      text,
    },
  }
}

async function postear(
  server: Hono,
  cuerpo: unknown,
  secreto: string | null = SECRETO,
  slug = 'gym',
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secreto !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secreto

  return server.request(`/webhooks/telegram/${slug}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(cuerpo),
  })
}

describe('seguridad y ruteo', () => {
  it('rechaza sin el header de secreto', async () => {
    const { server } = armar()
    expect((await postear(server, update('hola'), null)).status).toBe(401)
  })

  it('rechaza con un secreto incorrecto', async () => {
    const { server } = armar()
    expect((await postear(server, update('hola'), 'otro')).status).toBe(401)
  })

  it('devuelve 404 para un bot que no existe', async () => {
    const { server } = armar()
    expect(
      (await postear(server, update('hola'), SECRETO, 'no-existe')).status,
    ).toBe(404)
  })

  it('acepta un update que no puede parsear y responde 200', async () => {
    const { server, enviados } = armar()
    const res = await postear(server, { update_id: 1, callback_query: {} })
    expect(res.status).toBe(200)
    expect(enviados).toHaveLength(0)
  })
})

describe('chat no vinculado', () => {
  it('responde con el unlinked_message del bot', async () => {
    const { server, enviados } = armar()
    const res = await postear(server, update('banca 4x10 60'))

    expect(res.status).toBe(200)
    expect(enviados).toEqual([
      { chatId: '12345', text: 'Vinculá tu cuenta con /vincular <código>.' },
    ])
  })
})

describe('/vincular', () => {
  it('vincula con un código válido', async () => {
    const { server, enviados, contacts } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })
    const res = await postear(server, update('/vincular ABCDEF'))

    expect(res.status).toBe(200)
    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(
      (await contacts.findByExternalId('app-1', 'telegram', '12345'))?.appUserId,
    ).toBe('user-1')
  })

  it('acepta el alias /link y el código en minúsculas y con guiones', async () => {
    const { server, contacts } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF' })],
    })
    await postear(server, update('/link abc-def'))
    expect(
      await contacts.findByExternalId('app-1', 'telegram', '12345'),
    ).not.toBeNull()
  })

  it('pide el código si el comando viene sin argumentos', async () => {
    const { server, enviados } = armar()
    await postear(server, update('/vincular'))
    expect(enviados[0]?.text).toMatch(/código/i)
  })

  it('avisa cuando el código está vencido, sin consumirlo', async () => {
    const { server, enviados, linkCodes } = armar({
      codigos: [
        unLinkCode({ code: 'ABCDEF', expiresAt: '2026-07-28T11:00:00.000Z' }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vencido/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('avisa cuando el código ya fue usado', async () => {
    const { server, enviados } = armar({
      codigos: [
        unLinkCode({ code: 'ABCDEF', usedAt: '2026-07-28T11:00:00.000Z' }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))
    expect(enviados[0]?.text).toMatch(/ya se us/i)
  })

  it('trata un código de otra app como inexistente', async () => {
    const { server, enviados, linkCodes } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appId: 'otra-app' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/no existe/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('repetir el mismo /vincular contesta que ya estabas vinculado', async () => {
    // Secuencia REAL, no un estado armado a mano: vincular y repetir. Un test
    // que construye "contacto existente + código sin usar" describe un estado
    // imposible —si hay contacto, el código se consumió— y por eso no detecta
    // que el chequeo de `usedAt` se coma la rama de idempotencia.
    const { server, enviados } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })

    await postear(server, update('/vincular ABCDEF'))
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(enviados[1]?.text).toMatch(/ya estab/i)
    expect(enviados[1]?.text).not.toMatch(/ya se us/i)
  })

  it('es idempotente aunque el código figure como usado', async () => {
    const { server, enviados } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      codigos: [
        unLinkCode({
          code: 'ABCDEF',
          appUserId: 'user-1',
          usedAt: '2026-07-28T11:00:00.000Z',
        }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/ya estab/i)
  })

  it('rechaza vincular un chat que ya pertenece a otra cuenta, sin quemar el código', async () => {
    const { server, enviados, linkCodes } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-2' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/otra cuenta/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })
})
