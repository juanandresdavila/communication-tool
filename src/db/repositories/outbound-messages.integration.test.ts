import { Client } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import type { OutboundMessagesRepo } from '../ports.js'
import { createOutboundMessagesRepo } from './outbound-messages.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_outbound_app'

correr('outbound_messages contra una base real', () => {
  // Se construye en beforeAll: Vitest evalúa el cuerpo de un describe.skip.
  let repo: OutboundMessagesRepo
  let appId = ''
  let contactId = ''

  async function limpiar() {
    const c = new Client(DATABASE_URL)
    await c.connect()
    await c.query('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    repo = createOutboundMessagesRepo(createSql(DATABASE_URL))
    await limpiar()

    const c = new Client(DATABASE_URL)
    await c.connect()
    const app = await c.query<{ id: string }>(
      `INSERT INTO apps (slug, name, api_key_hash, delivery_url, delivery_secret_env)
       VALUES ($1, 'Test', 'h', 'https://ejemplo.test/inbound', 'S') RETURNING id`,
      [SLUG_APP],
    )
    const filaApp = app.rows[0]
    if (!filaApp) throw new Error('no se creó la app de prueba')
    appId = filaApp.id

    const contacto = await c.query<{ id: string }>(
      `INSERT INTO contacts (app_id, channel, external_id, app_user_id)
       VALUES ($1, 'telegram', '12345', 'u-1') RETURNING id`,
      [appId],
    )
    const filaContacto = contacto.rows[0]
    if (!filaContacto) throw new Error('no se creó el contacto de prueba')
    contactId = filaContacto.id
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  function base(idempotencyKey: string | null) {
    return {
      appId,
      contactId,
      appUserId: 'u-1',
      channel: 'telegram' as const,
      kind: 'reply' as const,
      text: 'hola',
      template: null,
      replyToMessageId: null,
      idempotencyKey,
    }
  }

  it('sin clave cada llamada reserva una fila nueva', async () => {
    const a = await repo.claim(base(null))
    const b = await repo.claim(base(null))
    expect(a?.status).toBe('sending')
    expect(b?.status).toBe('sending')
    expect(a?.id).not.toBe(b?.id)
  }, 30_000)

  it('con la misma clave la segunda reserva no devuelve nada', async () => {
    expect((await repo.claim(base('k-1')))?.status).toBe('sending')
    expect(await repo.claim(base('k-1'))).toBeNull()
  }, 30_000)

  it('dos reservas simultáneas con la misma clave: solo una gana', async () => {
    // Es el caso que la idempotencia existe para cubrir. Sin el único y el
    // ON CONFLICT, las dos entrarían y saldrían dos mensajes.
    const [a, b] = await Promise.all([
      repo.claim(base('k-2')),
      repo.claim(base('k-2')),
    ])
    expect([a, b].filter((r) => r !== null)).toHaveLength(1)
  }, 30_000)

  it('deja leer la fila ya enviada para contestar el replay', async () => {
    const creado = await repo.claim(base('k-3'))
    if (!creado) throw new Error('no se reservó')
    await repo.marcarEnviado(creado.id, 'tg-42')

    const leido = await repo.findByIdempotencyKey(appId, 'k-3')
    expect(leido?.status).toBe('sent')
    expect(leido?.providerMessageId).toBe('tg-42')
  }, 30_000)

  it('una fila fallida se vuelve a reservar; una enviada no', async () => {
    const creado = await repo.claim(base('k-4'))
    if (!creado) throw new Error('no se reservó')

    await repo.marcarFallido(creado.id, 'Telegram dijo que no')
    const reclamado = await repo.claim(base('k-4'))
    expect(reclamado?.id).toBe(creado.id)
    expect(reclamado?.status).toBe('sending')
    expect(reclamado?.error).toBeNull()

    await repo.marcarEnviado(creado.id, 'tg-7')
    expect(await repo.claim(base('k-4'))).toBeNull()
  }, 30_000)

  it('al re-reservar conserva el texto original, no el del pedido nuevo', async () => {
    // La clave identifica al mensaje. Si el reintento pudiera cambiarle el
    // texto, "idempotente" dejaría de querer decir nada.
    const creado = await repo.claim({ ...base('k-5'), text: 'el original' })
    if (!creado) throw new Error('no se reservó')
    await repo.marcarFallido(creado.id, 'x')

    const reclamado = await repo.claim({ ...base('k-5'), text: 'otro texto' })
    expect(reclamado?.text).toBe('el original')
  }, 30_000)

  it('guarda el template como objeto, no como string', async () => {
    const creado = await repo.claim({
      ...base('k-6'),
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })
    expect(creado?.template).toEqual({
      name: 'checkin',
      vars: { hora: '22:00' },
    })
  }, 30_000)
})
