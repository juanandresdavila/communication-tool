import { Hono } from 'hono'
import type { DeliverDeps } from '../delivery/deliver.js'
import { intentarEntrega } from '../delivery/deliver.js'
import type { FireDeps } from '../schedules/fire.js'
import { dispararProgramado } from '../schedules/fire.js'

/** Tope por tick: acota la duración de la invocación. */
const LOTE = 25

export function internalRoutes(deps: DeliverDeps & FireDeps): Hono {
  const rutas = new Hono()

  rutas.post('/internal/tick', async (c) => {
    const pendientes = await deps.inbound.claimPendientes(deps.now(), LOTE)

    let entregados = 0
    let fallidos = 0
    for (const mensaje of pendientes) {
      const resultado = await intentarEntrega(deps, mensaje)
      if (resultado === 'delivered') entregados += 1
      if (resultado === 'failed') fallidos += 1
    }

    // El mismo ticker que despierta los reintentos dispara los programados:
    // en serverless no hay proceso vivo entre requests, y montar un segundo
    // disparador externo sería duplicar la única pieza de infraestructura.
    const programados = await deps.schedules.claimVencidos(deps.now(), LOTE)
    let disparados = 0
    for (const { schedule, agendadoPara } of programados) {
      const r = await dispararProgramado(deps, schedule, agendadoPara)
      if (r === 'fired') disparados += 1
    }

    return c.json({
      procesados: pendientes.length,
      entregados,
      fallidos,
      programados: programados.length,
      disparados,
    })
  })

  rutas.post('/internal/replay/:messageId', async (c) => {
    const id = c.req.param('messageId')

    const mensaje = await deps.inbound.findById(id)
    if (!mensaje) return c.json({ code: 'not_found' }, 404)

    const reencolado = await deps.inbound.reencolar(id, deps.now())
    if (!reencolado) {
      return c.json({ code: 'not_failed', status: mensaje.deliveryStatus }, 409)
    }

    return c.json({ requeued: true })
  })

  return rutas
}
