import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { ContactsRepo } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import {
  createFakeContactsRepo,
  unApp,
  unContacto,
} from '../test-support/fake-repos.js'
import { contactRoutes } from './contacts.js'

function armar(contacts: ContactsRepo) {
  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route('/', contactRoutes({ contacts }))
  return server
}

describe('GET /v1/contacts/:userId', () => {
  it('informa que está vinculado', async () => {
    const server = armar(
      createFakeContactsRepo([unContacto({ appUserId: 'user-1' })]),
    )
    const res = await server.request('/v1/contacts/user-1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      linked: true,
      channel: 'telegram',
      linkedAt: '2026-07-28T10:00:00.000Z',
    })
  })

  it('informa que no está vinculado, sin 404', async () => {
    const server = armar(createFakeContactsRepo([]))
    const res = await server.request('/v1/contacts/user-9')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ linked: false })
  })

  it('nunca expone el external_id del chat', async () => {
    const server = armar(
      createFakeContactsRepo([
        unContacto({ appUserId: 'user-1', externalId: '987654' }),
      ]),
    )
    const cuerpo = await (await server.request('/v1/contacts/user-1')).text()
    expect(cuerpo).not.toContain('987654')
  })
})

describe('DELETE /v1/contacts/:userId', () => {
  it('desvincula y avisa', async () => {
    const repo = createFakeContactsRepo([unContacto({ appUserId: 'user-1' })])
    const res = await armar(repo).request('/v1/contacts/user-1', {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unlinked: true })
    expect(await repo.findByAppUserId('app-1', 'telegram', 'user-1')).toBeNull()
  })

  it('es idempotente si no había vínculo', async () => {
    const res = await armar(createFakeContactsRepo([])).request(
      '/v1/contacts/user-9',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unlinked: false })
  })
})
