import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { App } from '../db/ports.js'
import { hashApiKey } from '../identity/api-key.js'
import { createFakeAppsRepo, unApp } from '../test-support/fake-repos.js'
import { apiKeyAuth, type ConVariablesDeApp } from './api-key-auth.js'

const CLAVE = 'ct_clave_de_prueba'

function armarApp(app: App = unApp()) {
  const repo = createFakeAppsRepo([{ hash: hashApiKey(CLAVE), app }])
  const server = new Hono<ConVariablesDeApp>()
  server.use('/protegido', apiKeyAuth(repo))
  server.get('/protegido', (c) => c.json({ appSlug: c.get('app').slug }))
  return server
}

describe('apiKeyAuth', () => {
  it('deja pasar con la clave correcta y expone la app', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: `Bearer ${CLAVE}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ appSlug: 'gym-tracker' })
  })

  it('rechaza sin header Authorization', async () => {
    const res = await armarApp().request('/protegido')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'unauthorized' })
  })

  it('rechaza un header que no es Bearer', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: `Basic ${CLAVE}` },
    })
    expect(res.status).toBe(401)
  })

  it('rechaza una clave que no corresponde', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: 'Bearer ct_otra_clave' },
    })
    expect(res.status).toBe(401)
  })

  it('nunca devuelve el hash ni la clave en el error', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: 'Bearer ct_otra_clave' },
    })
    const cuerpo = await res.text()
    expect(cuerpo).not.toContain('ct_otra_clave')
    expect(cuerpo).not.toContain(hashApiKey(CLAVE))
  })
})
