import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createFakeDb } from '../test-support/fake-db'

describe('GET /health', () => {
  it('responde 200 sin despertar a la base', async () => {
    const db = createFakeDb()
    const res = await createApp({ db }).request('/health')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(db.pings).toBe(0)
  })

  it('con ?deep=1 confirma que la base responde', async () => {
    const db = createFakeDb()
    const res = await createApp({ db }).request('/health?deep=1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' })
    expect(db.pings).toBe(1)
  })

  it('con ?deep=1 devuelve 503 si la base falla', async () => {
    const db = createFakeDb({ pingFalla: true })
    const res = await createApp({ db }).request('/health?deep=1')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'degraded', db: 'error' })
  })

  it('devuelve 404 en una ruta que no existe', async () => {
    const res = await createApp({ db: createFakeDb() }).request('/no-existe')
    expect(res.status).toBe(404)
  })
})
