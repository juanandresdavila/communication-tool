import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import type {
  AppsRepo,
  BotsRepo,
  ContactsRepo,
  LinkCodesRepo,
} from '../ports.js'
import { createAppsRepo } from './apps.js'
import { createBotsRepo } from './bots.js'
import { createContactsRepo } from './contacts.js'
import { createLinkCodesRepo } from './link-codes.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_app'
const SLUG_BOT = '_test_bot'

correr('repositorios contra una base real', () => {
  // Los repositorios se construyen en beforeAll, NO en el scope del describe:
  // Vitest evalúa el cuerpo de un describe.skip para recolectar los tests, así
  // que un createSql('') acá explotaría en CI antes de poder saltear nada.
  let apps: AppsRepo
  let bots: BotsRepo
  let contacts: ContactsRepo
  let linkCodes: LinkCodesRepo
  let appId = ''

  async function limpiar() {
    const c = postgres(DATABASE_URL, { max: 1 })
    await c.unsafe('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    const sql = createSql(DATABASE_URL)
    apps = createAppsRepo(sql)
    bots = createBotsRepo(sql)
    contacts = createContactsRepo(sql)
    linkCodes = createLinkCodesRepo(sql)

    await limpiar()
    const c = postgres(DATABASE_URL, { max: 1 })
    const rows = await c.unsafe<{ id: string }[]>(
      `INSERT INTO apps (slug, name, api_key_hash, api_key_hash_next,
                         delivery_url, delivery_secret_env)
       VALUES ($1, 'Test', 'hash-actual', 'hash-nueva',
               'https://ejemplo.test/inbound', 'SECRET_TEST')
       RETURNING id`,
      [SLUG_APP],
    )
    // Sin `!`: typescript-eslint rechaza el non-null assertion y CI falla.
    const fila = rows[0]
    if (!fila) throw new Error('No se pudo crear la app de prueba')
    appId = fila.id
    await c.unsafe(
      `INSERT INTO bots (app_id, channel, slug, token_env,
                         webhook_secret_env, unlinked_message)
       VALUES ($1, 'telegram', $2, 'TOKEN_TEST', 'SECRET_TEST', 'vinculate')`,
      [appId, SLUG_BOT],
    )
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  it('encuentra la app por la clave actual y por la de rotación', async () => {
    expect((await apps.findByApiKeyHash('hash-actual'))?.slug).toBe(SLUG_APP)
    expect((await apps.findByApiKeyHash('hash-nueva'))?.slug).toBe(SLUG_APP)
    expect(await apps.findByApiKeyHash('no-existe')).toBeNull()
  }, 30_000)

  it('encuentra el bot por slug y mapea los nombres de las env vars', async () => {
    const bot = await bots.findBySlug(SLUG_BOT)
    expect(bot?.tokenEnv).toBe('TOKEN_TEST')
    expect(bot?.webhookSecretEnv).toBe('SECRET_TEST')
    expect(bot?.appId).toBe(appId)
  }, 30_000)

  it('encuentra el bot activo de una app por canal', async () => {
    const bot = await bots.findByAppAndChannel(appId, 'telegram')
    expect(bot?.slug).toBe(SLUG_BOT)

    expect(await bots.findByAppAndChannel(appId, 'whatsapp')).toBeNull()
    expect(
      await bots.findByAppAndChannel(
        '00000000-0000-0000-0000-000000000000',
        'telegram',
      ),
    ).toBeNull()
  }, 30_000)

  it('crea, encuentra y borra un contacto', async () => {
    const creado = await contacts.create({
      appId,
      channel: 'telegram',
      externalId: '999',
      appUserId: 'u-999',
    })
    expect(creado.externalId).toBe('999')

    expect(
      (await contacts.findByExternalId(appId, 'telegram', '999'))?.appUserId,
    ).toBe('u-999')
    expect(
      (await contacts.findByAppUserId(appId, 'telegram', 'u-999'))?.externalId,
    ).toBe('999')

    expect(await contacts.deleteByAppUserId(appId, 'telegram', 'u-999')).toBe(
      true,
    )
    expect(await contacts.deleteByAppUserId(appId, 'telegram', 'u-999')).toBe(
      false,
    )
  }, 30_000)

  it('canjea un código una sola vez, aun con dos intentos simultáneos', async () => {
    const ahora = new Date()
    const vence = new Date(ahora.getTime() + 15 * 60_000)
    await linkCodes.create({
      code: 'AAAAAA',
      appId,
      appUserId: 'u-1',
      expiresAt: vence,
    })

    const [a, b] = await Promise.all([
      linkCodes.redeem('AAAAAA', ahora),
      linkCodes.redeem('AAAAAA', ahora),
    ])
    expect([a, b].filter((r) => r !== null)).toHaveLength(1)
  }, 30_000)

  it('no canjea un código vencido', async () => {
    const ahora = new Date()
    await linkCodes.create({
      code: 'BBBBBB',
      appId,
      appUserId: 'u-2',
      expiresAt: new Date(ahora.getTime() - 60_000),
    })
    expect(await linkCodes.redeem('BBBBBB', ahora)).toBeNull()
    expect((await linkCodes.find('BBBBBB'))?.usedAt).toBeNull()
  }, 30_000)
})
