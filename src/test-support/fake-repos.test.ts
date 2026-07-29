import { describe, expect, it } from 'vitest'
import {
  createFakeAppsRepo,
  createFakeContactsRepo,
  createFakeLinkCodesRepo,
  unApp,
  unContacto,
  unLinkCode,
} from './fake-repos.js'

describe('createFakeAppsRepo', () => {
  it('encuentra por hash de API key', async () => {
    const app = unApp({ id: 'app-1' })
    const repo = createFakeAppsRepo([{ hash: 'h1', app }])
    expect(await repo.findByApiKeyHash('h1')).toEqual(app)
    expect(await repo.findByApiKeyHash('otro')).toBeNull()
  })
})

describe('createFakeContactsRepo', () => {
  it('encuentra por external_id y por app_user_id', async () => {
    const contacto = unContacto({ externalId: '123', appUserId: 'u-1' })
    const repo = createFakeContactsRepo([contacto])

    expect(
      await repo.findByExternalId(contacto.appId, 'telegram', '123'),
    ).toEqual(contacto)
    expect(
      await repo.findByAppUserId(contacto.appId, 'telegram', 'u-1'),
    ).toEqual(contacto)
    expect(
      await repo.findByExternalId(contacto.appId, 'telegram', '999'),
    ).toBeNull()
  })

  it('crea y después encuentra', async () => {
    const repo = createFakeContactsRepo([])
    const creado = await repo.create({
      appId: 'app-1',
      channel: 'telegram',
      externalId: '55',
      appUserId: 'u-9',
    })
    expect(await repo.findByExternalId('app-1', 'telegram', '55')).toEqual(
      creado,
    )
  })

  it('borra y avisa si había algo', async () => {
    const contacto = unContacto({ appUserId: 'u-1' })
    const repo = createFakeContactsRepo([contacto])
    expect(await repo.deleteByAppUserId(contacto.appId, 'telegram', 'u-1')).toBe(
      true,
    )
    expect(await repo.deleteByAppUserId(contacto.appId, 'telegram', 'u-1')).toBe(
      false,
    )
  })
})

describe('createFakeLinkCodesRepo', () => {
  it('canjea una sola vez', async () => {
    const code = unLinkCode({ code: 'ABCDEF' })
    const repo = createFakeLinkCodesRepo([code])
    const ahora = new Date('2026-07-28T12:00:00Z')

    expect(await repo.redeem('ABCDEF', ahora)).not.toBeNull()
    expect(await repo.redeem('ABCDEF', ahora)).toBeNull()
  })

  it('no canjea uno vencido', async () => {
    const code = unLinkCode({
      code: 'ABCDEF',
      expiresAt: '2026-07-28T11:00:00Z',
    })
    const repo = createFakeLinkCodesRepo([code])
    expect(
      await repo.redeem('ABCDEF', new Date('2026-07-28T12:00:00Z')),
    ).toBeNull()
  })
})
