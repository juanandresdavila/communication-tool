import { Hono } from 'hono'
import * as z from 'zod'
import type { SchedulesRepo } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { cronValido, proximaEjecucion, zonaValida } from '../schedules/cron.js'

const cuerpoSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(64),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
})

export interface ScheduleDeps {
  schedules: SchedulesRepo
  now: () => Date
}

export function scheduleRoutes(deps: ScheduleDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.post('/v1/schedules', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = cuerpoSchema.safeParse(crudo)
    if (!parseado.success) return c.json({ code: 'invalid_request' }, 400)

    const { userId, name, cron, timezone } = parseado.data

    // Se valida ANTES de guardar: un cron inválido guardado sería un
    // programado que nunca dispara y que nadie mira hasta que falta el aviso.
    if (!cronValido(cron)) return c.json({ code: 'invalid_cron' }, 400)
    if (!zonaValida(timezone)) return c.json({ code: 'invalid_timezone' }, 400)

    const proxima = proximaEjecucion(cron, timezone, deps.now())
    if (!proxima) return c.json({ code: 'invalid_cron' }, 400)

    const app = c.get('app')
    const schedule = await deps.schedules.upsert({
      appId: app.id,
      appUserId: userId,
      name,
      cron,
      timezone,
      nextRunAt: proxima,
    })

    return c.json(
      {
        scheduleId: schedule.id,
        name: schedule.name,
        nextRunAt: schedule.nextRunAt,
      },
      201,
    )
  })

  rutas.delete('/v1/schedules/:name', async (c) => {
    const app = c.get('app')
    const userId = c.req.query('userId')
    // El programado es de un usuario, no de la app: sin userId no se sabe
    // cuál dar de baja.
    if (!userId) return c.json({ code: 'invalid_request' }, 400)

    const borrado = await deps.schedules.deleteByName(
      app.id,
      userId,
      c.req.param('name'),
    )
    return c.json({ deleted: borrado })
  })

  return rutas
}
