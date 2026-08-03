import { describe, expect, it } from 'vitest'
import type { EntregaResultado } from '../delivery/client.js'
import {
  createFakeSchedulesRepo,
  unSchedule,
} from '../test-support/fake-schedules.js'
import { createFakeAppsRepo, unApp } from '../test-support/fake-repos.js'
import { dispararProgramado, GRACIA_MS } from './fire.js'

const AHORA = new Date('2026-08-03T01:00:30.000Z')
const AGENDADO = '2026-08-03T01:00:00.000Z'
const CALLBACK = 'https://gym.example/api/messaging/schedule'

function armar(
  opts: { respuesta?: EntregaResultado; callbackUrl?: string | null } = {},
) {
  const pedidos: { url: string; cuerpo: string; deliveryId: string }[] = []

  const app = unApp({
    scheduleCallbackUrl:
      opts.callbackUrl === undefined ? CALLBACK : opts.callbackUrl,
  })
  const schedules = createFakeSchedulesRepo([unSchedule()])

  return {
    pedidos,
    schedules,
    deps: {
      schedules,
      apps: createFakeAppsRepo([{ hash: 'h', app }]),
      delivery: {
        async entregar(p: {
          url: string
          cuerpo: string
          deliveryId: string
        }) {
          pedidos.push({
            url: p.url,
            cuerpo: p.cuerpo,
            deliveryId: p.deliveryId,
          })
          return opts.respuesta ?? { ok: true, status: 200 }
        },
      },
      secrets: () => 'secreto',
      now: () => AHORA,
    },
  }
}

describe('dispararProgramado', () => {
  it('postea al schedule_callback_url y NO compone el mensaje', async () => {
    const { deps, pedidos } = armar()
    expect(await dispararProgramado(deps, unSchedule(), AGENDADO)).toBe('fired')

    expect(pedidos[0]?.url).toBe(CALLBACK)
    expect(JSON.parse(pedidos[0]?.cuerpo ?? '{}')).toEqual({
      scheduleId: 'sch-1',
      name: 'checkin-nocturno',
      userId: 'user-1',
      firedAt: AHORA.toISOString(),
    })
    // Ni texto ni plantilla: el mensaje lo arma la app. Es la invariante del
    // spec — comm-tool nunca lee ni escribe dominio.
    expect(pedidos[0]?.cuerpo).not.toContain('text')
  })

  it('usa un deliveryId estable para que un reintento no duplique el aviso', async () => {
    const { deps, pedidos } = armar()
    await dispararProgramado(deps, unSchedule(), AGENDADO)
    await dispararProgramado(deps, unSchedule(), AGENDADO)
    expect(pedidos[0]?.deliveryId).toBe(pedidos[1]?.deliveryId)
    expect(pedidos[0]?.deliveryId).toBe(`sch-1:${AGENDADO}`)
  })

  it('agenda la próxima ejecución al disparar', async () => {
    const { deps, schedules } = armar()
    await dispararProgramado(deps, unSchedule(), AGENDADO)

    const tras = await schedules.claimVencidos(
      new Date('2026-08-05T00:00:00.000Z'),
      10,
    )
    expect(tras[0]?.agendadoPara).toBe('2026-08-04T01:00:00.000Z')
    expect(tras[0]?.schedule.lastStatus).toBe('fired')
  })

  it('restaura el horario original si el callback falla', async () => {
    // Si dejara el lease, la ventana de gracia se recalcularía contra él y el
    // programado se reintentaría para siempre.
    const { deps, schedules } = armar({
      respuesta: { ok: false, status: 500, error: 'la app respondió 500' },
    })
    expect(await dispararProgramado(deps, unSchedule(), AGENDADO)).toBe(
      'failed',
    )

    const tras = await schedules.claimVencidos(AHORA, 10)
    expect(tras[0]?.agendadoPara).toBe(AGENDADO)
    expect(tras[0]?.schedule.lastStatus).toBe('failed')
  })

  it('se da por perdido pasada la ventana de gracia', async () => {
    const viejo = new Date(AHORA.getTime() - GRACIA_MS - 1000).toISOString()
    const { deps, pedidos, schedules } = armar()

    expect(await dispararProgramado(deps, unSchedule(), viejo)).toBe('missed')
    expect(pedidos).toEqual([])

    const tras = await schedules.claimVencidos(
      new Date('2026-08-05T00:00:00.000Z'),
      10,
    )
    expect(tras[0]?.schedule.lastStatus).toBe('missed')
    // Saltó a la próxima ocurrencia, no se quedó en la vencida.
    expect(tras[0]?.agendadoPara).toBe('2026-08-04T01:00:00.000Z')
  })

  it('no dispara si la app no tiene callback configurado', async () => {
    const { deps, pedidos } = armar({ callbackUrl: null })
    expect(await dispararProgramado(deps, unSchedule(), AGENDADO)).toBe(
      'skipped',
    )
    expect(pedidos).toEqual([])
  })

  it('marca fallido si la expresión cron dejó de ser válida', async () => {
    const { deps, pedidos } = armar()
    const roto = unSchedule({ cron: 'esto no es cron' })
    expect(await dispararProgramado(deps, roto, AGENDADO)).toBe('failed')
    expect(pedidos).toEqual([])
  })
})
