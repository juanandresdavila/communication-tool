import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { EntregaResultado } from '../delivery/client.js'
import {
  createFakeAppsRepo,
  createFakeInboundMessagesRepo,
  unApp,
  unMensaje,
} from '../test-support/fake-repos.js'
import {
  createFakeSchedulesRepo,
  unSchedule,
} from '../test-support/fake-schedules.js'
import { internalRoutes } from './internal.js'

const AHORA = new Date('2026-07-29T12:00:00.000Z')

function armar(
  opts: {
    mensajes?: ReturnType<typeof unMensaje>[]
    respuesta?: EntregaResultado
    programados?: ReturnType<typeof unSchedule>[]
  } = {},
) {
  const entregados: string[] = []
  const inbound = createFakeInboundMessagesRepo(opts.mensajes ?? [])
  const schedules = createFakeSchedulesRepo(opts.programados ?? [])

  const server = new Hono()
  server.route(
    '/',
    internalRoutes({
      inbound,
      schedules,
      apps: createFakeAppsRepo([
        {
          hash: 'h',
          // Con `scheduleCallbackUrl: null` —el default, y lo que hay hoy en
          // producción— ningún programado dispara. Los tests de programados
          // necesitan una app que sí lo tenga configurado.
          app: unApp({
            scheduleCallbackUrl: 'https://gym.example/api/messaging/schedule',
          }),
        },
      ]),
      delivery: {
        async entregar(p) {
          entregados.push(p.deliveryId)
          return opts.respuesta ?? { ok: true, status: 200 }
        },
      },
      secrets: () => 'secreto',
      now: () => AHORA,
      sleep: async () => {},
    }),
  )

  return { server, inbound, entregados }
}

describe('POST /internal/tick', () => {
  it('entrega los pendientes vencidos', async () => {
    const { server, entregados, inbound } = armar({
      mensajes: [
        unMensaje({ id: 'm1', nextAttemptAt: '2026-07-29T11:00:00.000Z' }),
      ],
    })
    const res = await server.request('/internal/tick', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      procesados: 1,
      entregados: 1,
      fallidos: 0,
      programados: 0,
      disparados: 0,
    })
    expect(entregados).toEqual(['m1'])
    expect((await inbound.findById('m1'))?.deliveryStatus).toBe('delivered')
  })

  it('dispara los programados vencidos en el mismo tick', async () => {
    // El ticker es uno solo: montar un segundo disparador externo para los
    // programados duplicaría la única pieza de infraestructura que hay.
    const { server, entregados } = armar({
      programados: [
        unSchedule({ id: 's1', nextRunAt: '2026-07-29T11:59:00.000Z' }),
      ],
    })
    const res = await server.request('/internal/tick', { method: 'POST' })

    expect(await res.json()).toMatchObject({ programados: 1, disparados: 1 })
    // El callback sale por el mismo cliente de entrega, con un id estable.
    expect(entregados).toEqual(['s1:2026-07-29T11:59:00.000Z'])
  })

  it('no dispara un programado que todavía no venció', async () => {
    const { server, entregados } = armar({
      programados: [
        unSchedule({ id: 's1', nextRunAt: '2026-07-29T23:00:00.000Z' }),
      ],
    })
    const res = await server.request('/internal/tick', { method: 'POST' })

    expect(await res.json()).toMatchObject({ programados: 0, disparados: 0 })
    expect(entregados).toEqual([])
  })

  it('no toca los que todavía no vencieron', async () => {
    const { server, entregados } = armar({
      mensajes: [
        unMensaje({ id: 'm1', nextAttemptAt: '2026-07-29T13:00:00.000Z' }),
      ],
    })
    const res = await server.request('/internal/tick', { method: 'POST' })

    expect(await res.json()).toMatchObject({ procesados: 0 })
    expect(entregados).toEqual([])
  })

  it('no toca los entregados ni los salteados', async () => {
    const { server, entregados } = armar({
      mensajes: [
        unMensaje({ id: 'm1', deliveryStatus: 'delivered' }),
        unMensaje({ id: 'm2', deliveryStatus: 'skipped' }),
      ],
    })
    await server.request('/internal/tick', { method: 'POST' })
    expect(entregados).toEqual([])
  })

  it('cuenta los fallidos cuando se agotan los intentos', async () => {
    const { server } = armar({
      mensajes: [
        unMensaje({
          id: 'm1',
          deliveryAttempts: 4,
          nextAttemptAt: '2026-07-29T11:00:00.000Z',
        }),
      ],
      respuesta: { ok: false, status: 500, error: 'caída' },
    })
    const res = await server.request('/internal/tick', { method: 'POST' })
    expect(await res.json()).toMatchObject({ fallidos: 1 })
  })
})

describe('POST /internal/replay/:messageId', () => {
  it('reencola un mensaje fallido', async () => {
    const { server, inbound } = armar({
      mensajes: [unMensaje({ id: 'm1', deliveryStatus: 'failed' })],
    })
    const res = await server.request('/internal/replay/m1', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ requeued: true })
    expect((await inbound.findById('m1'))?.deliveryStatus).toBe('pending')
  })

  it('devuelve 409 si el mensaje no está fallido', async () => {
    const { server } = armar({
      mensajes: [unMensaje({ id: 'm1', deliveryStatus: 'delivered' })],
    })
    const res = await server.request('/internal/replay/m1', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('devuelve 404 si el mensaje no existe', async () => {
    const { server } = armar({})
    const res = await server.request('/internal/replay/no-existe', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})
