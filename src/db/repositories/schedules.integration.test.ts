import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import type { SchedulesRepo } from '../ports.js'
import { createSchedulesRepo } from './schedules.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_schedules_app'

correr('schedules contra una base real', () => {
  // Se construye en beforeAll: Vitest evalúa el cuerpo de un describe.skip.
  let repo: SchedulesRepo
  let appId = ''

  async function limpiar() {
    const c = postgres(DATABASE_URL, { max: 1 })
    // Los schedules caen con la app por la FK.
    await c.unsafe('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    repo = createSchedulesRepo(createSql(DATABASE_URL))
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
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  it('marcarSinProxima deja terminal el programado y el upsert lo reactiva', async () => {
    const creado = await repo.upsert({
      appId,
      appUserId: 'u-1',
      name: 'unico',
      cron: '0 9 * * *',
      timezone: 'America/Argentina/Buenos_Aires',
      nextRunAt: new Date('2020-01-01T00:00:00.000Z'),
    })

    const ahora = new Date()
    await repo.marcarSinProxima(creado.id, ahora)

    const vencidos = await repo.claimVencidos(new Date(), 25)
    expect(vencidos.some((v) => v.schedule.id === creado.id)).toBe(false)

    const c = postgres(DATABASE_URL, { max: 1 })
    const filas = await c.unsafe<
      {
        active: boolean
        next_run_at: string | null
        last_status: string | null
        last_run_at: string | null
      }[]
    >(
      'SELECT active, next_run_at, last_status, last_run_at FROM schedules WHERE id = $1',
      [creado.id],
    )
    await c.end()
    expect(filas[0]?.active).toBe(false)
    expect(filas[0]?.next_run_at).toBeNull()
    expect(filas[0]?.last_status).toBe('failed')
    expect(filas[0]?.last_run_at).not.toBeNull()

    // La app lo registra de nuevo con un cron válido: vuelve a estar activo.
    const proxima = new Date('2030-01-01T12:00:00.000Z')
    const reactivado = await repo.upsert({
      appId,
      appUserId: 'u-1',
      name: 'unico',
      cron: '0 9 * * *',
      timezone: 'America/Argentina/Buenos_Aires',
      nextRunAt: proxima,
    })
    expect(reactivado.id).toBe(creado.id)
    expect(reactivado.active).toBe(true)
    expect(reactivado.nextRunAt).toBe(proxima.toISOString())
  })
})
