import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { unApp } from '../test-support/fake-repos.js'
import { createFakeSchedulesRepo } from '../test-support/fake-schedules.js'
import { scheduleRoutes } from './schedules.js'

const AHORA = new Date('2026-08-03T12:00:00.000Z')
const BA = 'America/Argentina/Buenos_Aires'

function armar() {
  const schedules = createFakeSchedulesRepo([])
  // Hono<ConVariablesDeApp> y no Hono a secas: c.set('app', ...) está tipado.
  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route('/', scheduleRoutes({ schedules, now: () => AHORA }))
  return { server, schedules }
}

async function postear(server: Hono<ConVariablesDeApp>, body: unknown) {
  return server.request('/v1/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /v1/schedules', () => {
  it('rechaza un cron de un solo disparo y no guarda nada', async () => {
    const { server, schedules } = armar()
    const res = await postear(server, {
      userId: 'user-1',
      name: 'unico',
      cron: '2099-01-01T00:00:00',
      timezone: BA,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'invalid_cron' })
    expect(
      await schedules.claimVencidos(new Date('2100-01-01T00:00:00Z'), 25),
    ).toEqual([])
  })

  it('registra un cron recurrente con su próxima ejecución', async () => {
    const { server } = armar()
    const res = await postear(server, {
      userId: 'user-1',
      name: 'diario',
      cron: '0 9 * * *',
      timezone: BA,
    })
    expect(res.status).toBe(201)
    const cuerpo = (await res.json()) as { nextRunAt: string | null }
    expect(cuerpo.nextRunAt).not.toBeNull()
  })
})
