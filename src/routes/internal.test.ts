import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { App, InboundMessagesRepo, SchedulesRepo } from '../db/ports.js'
import type { EntregaResultado } from '../delivery/client.js'
import type { SecretReader } from '../secrets.js'
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
const CALLBACK = 'https://gym.example/api/messaging/schedule'

function armar(
  opts: {
    mensajes?: ReturnType<typeof unMensaje>[]
    respuesta?: EntregaResultado
    programados?: ReturnType<typeof unSchedule>[]
    apps?: App[]
    secrets?: SecretReader
    inbound?: InboundMessagesRepo
    schedulesRepo?: SchedulesRepo
  } = {},
) {
  const entregados: string[] = []
  const inbound =
    opts.inbound ?? createFakeInboundMessagesRepo(opts.mensajes ?? [])
  const schedules =
    opts.schedulesRepo ?? createFakeSchedulesRepo(opts.programados ?? [])
  let ahora = AHORA

  // Con `scheduleCallbackUrl: null` (el default, y lo que hay hoy en
  // producción) ningún programado dispara. Los tests de programados necesitan
  // una app que sí lo tenga configurado.
  const apps = opts.apps ?? [unApp({ scheduleCallbackUrl: CALLBACK })]

  const server = new Hono()
  server.route(
    '/',
    internalRoutes({
      inbound,
      schedules,
      apps: createFakeAppsRepo(apps.map((app) => ({ hash: app.id, app }))),
      delivery: {
        async entregar(p) {
          entregados.push(p.deliveryId)
          return opts.respuesta ?? { ok: true, status: 200 }
        },
      },
      secrets: opts.secrets ?? (() => 'secreto'),
      now: () => ahora,
      sleep: async () => {},
    }),
  )

  return {
    server,
    inbound,
    schedules,
    entregados,
    mover(fecha: string) {
      ahora = new Date(fecha)
    },
  }
}

const tick = (server: Hono) => server.request('/internal/tick', { method: 'POST' })

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

  it('un entrante de una app sin secreto no frena los programados de otra', async () => {
    const { server, inbound, entregados } = armar({
      apps: [
        unApp({
          id: 'app-a',
          deliverySecretEnv: 'DELIVERY_SECRET_A',
          scheduleCallbackUrl: CALLBACK,
        }),
        unApp({
          id: 'app-b',
          deliverySecretEnv: 'DELIVERY_SECRET_B',
          scheduleCallbackUrl: CALLBACK,
        }),
      ],
      secrets: (nombre) => {
        if (nombre === 'DELIVERY_SECRET_A') {
          throw new Error(
            'Falta la variable de entorno DELIVERY_SECRET_A, referenciada desde la base',
          )
        }
        return 'secreto'
      },
      mensajes: [
        unMensaje({
          id: 'm1',
          appId: 'app-a',
          nextAttemptAt: '2026-07-29T11:00:00.000Z',
        }),
      ],
      programados: [
        unSchedule({
          id: 's1',
          appId: 'app-b',
          nextRunAt: '2026-07-29T11:59:00.000Z',
        }),
      ],
    })

    const res = await tick(server)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      procesados: 1,
      entregados: 0,
      programados: 1,
      disparados: 1,
    })
    expect(entregados).toContain('s1:2026-07-29T11:59:00.000Z')
    const m1 = await inbound.findById('m1')
    expect(m1?.deliveryAttempts).toBe(1)
    expect(m1?.lastError).toMatch(/DELIVERY_SECRET_A/)
  })

  it('un programado sin secreto conserva su hora y vence a missed', async () => {
    const { server, mover } = armar({
      apps: [
        unApp({
          id: 'app-a',
          deliverySecretEnv: 'DELIVERY_SECRET_A',
          scheduleCallbackUrl: CALLBACK,
        }),
        unApp({
          id: 'app-b',
          deliverySecretEnv: 'DELIVERY_SECRET_B',
          scheduleCallbackUrl: CALLBACK,
        }),
      ],
      secrets: (nombre) => {
        if (nombre === 'DELIVERY_SECRET_A') {
          throw new Error(
            'Falta la variable de entorno DELIVERY_SECRET_A, referenciada desde la base',
          )
        }
        return 'secreto'
      },
      programados: [
        unSchedule({
          id: 'sA',
          appId: 'app-a',
          nextRunAt: '2026-07-29T11:59:00.000Z',
        }),
        unSchedule({
          id: 'sB',
          appId: 'app-b',
          nextRunAt: '2026-07-29T11:59:00.000Z',
        }),
      ],
    })

    expect(await (await tick(server)).json()).toMatchObject({
      programados: 2,
      disparados: 1,
    })

    // sA volvió con su hora y ya se pasó la gracia: se da por perdido.
    mover('2026-07-29T13:30:00.000Z')
    expect(await (await tick(server)).json()).toMatchObject({
      programados: 1,
      disparados: 0,
    })

    // Y saltó a la próxima ocurrencia: ya no vuelve al claim.
    mover('2026-07-29T13:31:00.000Z')
    expect(await (await tick(server)).json()).toMatchObject({ programados: 0 })
  })

  it('un entrante que tira por la base no corta el bucle', async () => {
    const base = createFakeInboundMessagesRepo([
      unMensaje({ id: 'm1', nextAttemptAt: '2026-07-29T11:00:00.000Z' }),
      unMensaje({
        id: 'm2',
        providerUpdateId: '900002',
        nextAttemptAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const inbound: InboundMessagesRepo = {
      ...base,
      async marcarEntregado(id, fecha) {
        if (id === 'm1') throw new Error('base caída')
        return base.marcarEntregado(id, fecha)
      },
    }
    const { server } = armar({
      inbound,
      programados: [
        unSchedule({ id: 's1', nextRunAt: '2026-07-29T11:59:00.000Z' }),
      ],
    })

    const res = await tick(server)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      procesados: 2,
      entregados: 1,
      fallidos: 0,
      programados: 1,
      disparados: 1,
      errores: 1,
    })
    const m1 = await base.findById('m1')
    expect(m1?.deliveryStatus).toBe('pending')
    expect(m1?.deliveryAttempts).toBe(1)
    expect((await base.findById('m2'))?.deliveryStatus).toBe('delivered')
  })

  it('si la marca de recuperación también tira, el bucle sigue', async () => {
    const base = createFakeInboundMessagesRepo([
      unMensaje({ id: 'm1', nextAttemptAt: '2026-07-29T11:00:00.000Z' }),
      unMensaje({
        id: 'm2',
        providerUpdateId: '900002',
        nextAttemptAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const inbound: InboundMessagesRepo = {
      ...base,
      async marcarEntregado(id, fecha) {
        if (id === 'm1') throw new Error('base caída')
        return base.marcarEntregado(id, fecha)
      },
      async marcarReintento(id, proximo, error) {
        if (id === 'm1') throw new Error('base caída')
        return base.marcarReintento(id, proximo, error)
      },
      async marcarFallido(id, error) {
        if (id === 'm1') throw new Error('base caída')
        return base.marcarFallido(id, error)
      },
    }
    const { server } = armar({
      inbound,
      programados: [
        unSchedule({ id: 's1', nextRunAt: '2026-07-29T11:59:00.000Z' }),
      ],
    })

    const res = await tick(server)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      errores: 1,
      entregados: 1,
      disparados: 1,
    })
    expect((await base.findById('m2'))?.deliveryStatus).toBe('delivered')
  })

  it('un programado que tira por la base no corta el bucle', async () => {
    const base = createFakeSchedulesRepo([
      unSchedule({ id: 's1', nextRunAt: '2026-07-29T11:58:00.000Z' }),
      unSchedule({ id: 's2', nextRunAt: '2026-07-29T11:59:00.000Z' }),
    ])
    const schedulesRepo: SchedulesRepo = {
      ...base,
      async marcarDisparado(id, fecha, proxima) {
        if (id === 's1') throw new Error('base caída')
        return base.marcarDisparado(id, fecha, proxima)
      },
    }
    const { server } = armar({ schedulesRepo })

    const res = await tick(server)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ errores: 1, disparados: 1 })

    // s1 conserva su hora: el próximo tick lo vuelve a reclamar.
    const reclamados = await base.claimVencidos(AHORA, 25)
    expect(reclamados.map((r) => [r.schedule.id, r.agendadoPara])).toEqual([
      ['s1', '2026-07-29T11:58:00.000Z'],
    ])
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
