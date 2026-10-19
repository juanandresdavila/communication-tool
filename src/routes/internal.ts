import { Hono } from 'hono'
import type { DeliverDeps } from '../delivery/deliver.js'
import { intentarEntrega, marcarIntentoFallido } from '../delivery/deliver.js'
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
    let errores = 0
    for (const mensaje of pendientes) {
      // Un ítem que tira no puede frenar a los demás: cada uno, aislado.
      try {
        const resultado = await intentarEntrega(deps, mensaje)
        if (resultado === 'delivered') entregados += 1
        if (resultado === 'failed') fallidos += 1
      } catch (e) {
        errores += 1
        const motivo = (e as Error).message
        console.error(`tick: falló el entrante ${mensaje.id}: ${motivo}`)
        // Sin la marca el mensaje volvería al claim sin contar intentos. Si
        // la marca también tira, el lease lo devuelve más adelante.
        await marcarIntentoFallido(deps, mensaje, deps.now(), motivo).catch(
          (e2: unknown) => {
            console.error(
              `tick: no se pudo marcar el entrante ${mensaje.id}: ${(e2 as Error).message}`,
            )
          },
        )
      }
    }

    // El mismo ticker que despierta los reintentos dispara los programados:
    // en serverless no hay proceso vivo entre requests, y montar un segundo
    // disparador externo sería duplicar la única pieza de infraestructura.
    const programados = await deps.schedules.claimVencidos(deps.now(), LOTE)
    let disparados = 0
    for (const { schedule, agendadoPara } of programados) {
      try {
        const r = await dispararProgramado(deps, schedule, agendadoPara)
        if (r === 'fired') disparados += 1
      } catch (e) {
        errores += 1
        console.error(
          `tick: falló el programado ${schedule.id}: ${(e as Error).message}`,
        )
        // Se restaura la hora: el lease lo dejaría 5 minutos afuera, y la
        // gracia lo da por perdido si el problema no se arregla.
        await deps.schedules
          .marcarFallido(schedule.id, deps.now(), new Date(agendadoPara))
          .catch((e2: unknown) => {
            console.error(
              `tick: no se pudo marcar el programado ${schedule.id}: ${(e2 as Error).message}`,
            )
          })
      }
    }

    const conteos = {
      procesados: pendientes.length,
      entregados,
      fallidos,
      programados: programados.length,
      disparados,
    }
    // 500 si algún ítem tiró: el ticker externo lo registra como falla aunque
    // el resto se haya procesado.
    if (errores > 0) return c.json({ ...conteos, errores }, 500)
    return c.json(conteos)
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
