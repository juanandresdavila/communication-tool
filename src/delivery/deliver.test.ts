import { describe, expect, it } from 'vitest'
import type { App, InboundMessagesRepo } from '../db/ports.js'
import {
  createFakeAppsRepo,
  createFakeInboundMessagesRepo,
  unApp,
  unMensaje,
} from '../test-support/fake-repos.js'
import type { DeliveryClient, EntregaResultado } from './client.js'
import { entregarConReintentoInmediato, intentarEntrega } from './deliver.js'

const AHORA = new Date('2026-07-29T12:00:00.000Z')

function armar(opts: {
  respuestas?: EntregaResultado[]
  mensajes?: ReturnType<typeof unMensaje>[]
  app?: App
}) {
  const respuestas = [...(opts.respuestas ?? [{ ok: true, status: 200 }])]
  const pedidos: { url: string; cuerpo: string; firma: string }[] = []

  const telegram: DeliveryClient = {
    async entregar(p) {
      pedidos.push({ url: p.url, cuerpo: p.cuerpo, firma: p.firma })
      return respuestas.shift() ?? { ok: true, status: 200 }
    },
  }

  const app = opts.app ?? unApp()
  const mensajes: InboundMessagesRepo = createFakeInboundMessagesRepo(
    opts.mensajes ?? [unMensaje()],
  )

  const esperas: number[] = []

  return {
    pedidos,
    esperas,
    mensajes,
    deps: {
      inbound: mensajes,
      apps: createFakeAppsRepo([{ hash: 'h', app }]),
      delivery: telegram,
      secrets: () => 'secreto-de-entrega',
      now: () => AHORA,
      sleep: async (ms: number) => {
        esperas.push(ms)
      },
    },
  }
}

describe('intentarEntrega', () => {
  it('firma y postea al delivery_url de la app', async () => {
    const { deps, pedidos } = armar({})
    await intentarEntrega(deps, unMensaje())

    expect(pedidos[0]?.url).toBe('https://gym.example/api/messaging/inbound')
    expect(pedidos[0]?.firma).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('manda userId y nunca el chat_id en el cuerpo', async () => {
    const { deps, pedidos } = armar({})
    await intentarEntrega(deps, unMensaje({ externalId: '987654' }))

    const cuerpo = JSON.parse(pedidos[0]?.cuerpo ?? '{}') as Record<
      string,
      unknown
    >
    expect(cuerpo['userId']).toBe('user-1')
    expect(pedidos[0]?.cuerpo).not.toContain('987654')
  })

  it('marca entregado ante un 2xx', async () => {
    const mensaje = unMensaje()
    const { deps, mensajes } = armar({ mensajes: [mensaje] })

    expect(await intentarEntrega(deps, mensaje)).toBe('delivered')
    expect((await mensajes.findById(mensaje.id))?.deliveryStatus).toBe(
      'delivered',
    )
  })

  it('agenda el próximo intento ante un fallo', async () => {
    const mensaje = unMensaje({ deliveryAttempts: 0 })
    const { deps, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [{ ok: false, status: 500, error: 'la app respondió 500' }],
    })

    expect(await intentarEntrega(deps, mensaje)).toBe('pending')
    const guardado = await mensajes.findById(mensaje.id)
    expect(guardado?.deliveryStatus).toBe('pending')
    expect(guardado?.nextAttemptAt).toBe('2026-07-29T12:00:10.000Z')
    expect(guardado?.deliveryAttempts).toBe(1)
    expect(guardado?.lastError).toMatch(/500/)
  })

  it('escala a un minuto en el segundo fallo', async () => {
    const mensaje = unMensaje({ deliveryAttempts: 1 })
    const { deps, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [{ ok: false, status: 500, error: 'x' }],
    })

    await intentarEntrega(deps, mensaje)
    expect((await mensajes.findById(mensaje.id))?.nextAttemptAt).toBe(
      '2026-07-29T12:01:00.000Z',
    )
  })

  it('se rinde al quinto intento y deja el crudo guardado', async () => {
    const mensaje = unMensaje({ deliveryAttempts: 4 })
    const { deps, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [{ ok: false, status: 500, error: 'sigue caída' }],
    })

    expect(await intentarEntrega(deps, mensaje)).toBe('failed')
    const guardado = await mensajes.findById(mensaje.id)
    expect(guardado?.deliveryStatus).toBe('failed')
    expect(guardado?.raw).toEqual({ update_id: 900_001 })
  })

  it('falla sin reintentar si la app ya no existe', async () => {
    const mensaje = unMensaje({ appId: 'app-borrada' })
    const { deps, mensajes } = armar({ mensajes: [mensaje] })

    expect(await intentarEntrega(deps, mensaje)).toBe('failed')
    expect((await mensajes.findById(mensaje.id))?.lastError).toMatch(/app/i)
  })
})

describe('entregarConReintentoInmediato', () => {
  it('no espera si la primera entrega sale bien', async () => {
    const { deps, esperas, pedidos } = armar({})
    await entregarConReintentoInmediato(deps, unMensaje())

    expect(pedidos).toHaveLength(1)
    expect(esperas).toEqual([])
  })

  it('espera 10 segundos y reintenta una vez si la primera falla', async () => {
    // Es el caso NORMAL en Vercel free: la app está fría y el primer POST
    // llega antes de que termine de arrancar.
    const mensaje = unMensaje()
    const { deps, esperas, pedidos, mensajes } = armar({
      mensajes: [mensaje],
      respuestas: [
        { ok: false, status: 0, error: 'timeout' },
        { ok: true, status: 200 },
      ],
    })

    await entregarConReintentoInmediato(deps, mensaje)

    expect(pedidos).toHaveLength(2)
    expect(esperas).toEqual([10_000])
    expect((await mensajes.findById(mensaje.id))?.deliveryStatus).toBe(
      'delivered',
    )
  })

  it('no encadena más de un reintento inmediato', async () => {
    // El salto siguiente es de un minuto: bloquear la invocación tanto sería
    // absurdo y carísimo. De ahí en más es trabajo del ticker.
    const mensaje = unMensaje()
    const { deps, esperas, pedidos } = armar({
      mensajes: [mensaje],
      respuestas: [
        { ok: false, status: 500, error: 'x' },
        { ok: false, status: 500, error: 'x' },
        { ok: true, status: 200 },
      ],
    })

    await entregarConReintentoInmediato(deps, mensaje)

    expect(pedidos).toHaveLength(2)
    expect(esperas).toEqual([10_000])
  })
})
