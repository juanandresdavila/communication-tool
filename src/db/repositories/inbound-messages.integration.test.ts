import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import type { InboundMessagesRepo } from '../ports.js'
import { createInboundMessagesRepo } from './inbound-messages.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_inbound_app'
const SLUG_BOT = '_test_inbound_bot'

correr('inbound_messages contra una base real', () => {
  // Se construye en beforeAll: Vitest evalúa el cuerpo de un describe.skip.
  let repo: InboundMessagesRepo
  let appId = ''
  let botId = ''

  async function limpiar() {
    const c = postgres(DATABASE_URL, { max: 1 })
    await c.unsafe('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    repo = createInboundMessagesRepo(createSql(DATABASE_URL))
    await limpiar()

    const c = postgres(DATABASE_URL, { max: 1 })
    const app = await c.unsafe<{ id: string }[]>(
      `INSERT INTO apps (slug, name, api_key_hash, delivery_url, delivery_secret_env)
       VALUES ($1, 'Test', 'h', 'https://ejemplo.test/inbound', 'S') RETURNING id`,
      [SLUG_APP],
    )
    const filaApp = app[0]
    if (!filaApp) throw new Error('no se creó la app de prueba')
    appId = filaApp.id

    const bot = await c.unsafe<{ id: string }[]>(
      `INSERT INTO bots (app_id, channel, slug, token_env, webhook_secret_env,
                         unlinked_message)
       VALUES ($1, 'telegram', $2, 'T', 'S', 'x') RETURNING id`,
      [appId, SLUG_BOT],
    )
    const filaBot = bot[0]
    if (!filaBot) throw new Error('no se creó el bot de prueba')
    botId = filaBot.id
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  function base(providerUpdateId: string) {
    return {
      botId,
      appId,
      channel: 'telegram' as const,
      providerUpdateId,
      externalId: '12345',
      appUserId: 'u-1',
      text: 'hola',
      replyToMessageId: null,
      raw: { update_id: Number(providerUpdateId) },
      deliveryStatus: 'pending' as const,
      nextAttemptAt: new Date(),
    }
  }

  it('inserta y devuelve null ante un update_id repetido', async () => {
    const primero = await repo.insertIfNew(base('1001'))
    expect(primero?.text).toBe('hola')

    const repetido = await repo.insertIfNew(base('1001'))
    expect(repetido).toBeNull()
  }, 30_000)

  it('guarda y devuelve el raw como objeto, no como string', async () => {
    const creado = await repo.insertIfNew(base('1002'))
    if (!creado) throw new Error('no se insertó')
    const leido = await repo.findById(creado.id)
    expect(leido?.raw).toEqual({ update_id: 1002 })
  }, 30_000)

  it('dos claims simultáneos no entregan el mismo mensaje dos veces', async () => {
    await repo.insertIfNew(base('1003'))
    const ahora = new Date(Date.now() + 60_000)

    const [a, b] = await Promise.all([
      repo.claimPendientes(ahora, 10),
      repo.claimPendientes(ahora, 10),
    ])

    const ids = [...a, ...b].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  }, 30_000)

  it('el claim pone un lease y NO toca el contador', async () => {
    // Si el claim incrementara, el webhook (que hace 2 intentos por su cuenta)
    // y el ticker contarían distinto y el total dejaría de ser 5.
    const creado = await repo.insertIfNew(base('1004'))
    if (!creado) throw new Error('no se insertó')

    const ahora = new Date(Date.now() + 60_000)
    await repo.claimPendientes(ahora, 50)

    const despues = await repo.findById(creado.id)
    expect(despues?.deliveryAttempts).toBe(0)
    expect(new Date(despues?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(
      ahora.getTime(),
    )
  }, 30_000)

  it('marcar reintento sí incrementa el contador', async () => {
    const creado = await repo.insertIfNew(base('1006'))
    if (!creado) throw new Error('no se insertó')

    await repo.marcarReintento(creado.id, new Date(Date.now() + 60_000), 'x')
    expect((await repo.findById(creado.id))?.deliveryAttempts).toBe(1)
  }, 30_000)

  it('reencola solo lo que está fallido', async () => {
    const creado = await repo.insertIfNew(base('1005'))
    if (!creado) throw new Error('no se insertó')

    expect(await repo.reencolar(creado.id, new Date())).toBeNull()

    await repo.marcarFallido(creado.id, 'se cayó')
    const reencolado = await repo.reencolar(creado.id, new Date())
    expect(reencolado?.deliveryStatus).toBe('pending')
    expect(reencolado?.deliveryAttempts).toBe(0)
  }, 30_000)
})
