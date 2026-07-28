import { Hono } from 'hono'
import type { Db } from '../db/client.js'

export function healthRoutes(db: Db): Hono {
  const rutas = new Hono()

  rutas.get('/health', async (c) => {
    // Por defecto no se toca la base: Neon se suspende a los 5 minutos de
    // inactividad y un monitor de uptime la mantendría despierta 24/7.
    if (c.req.query('deep') !== '1') {
      return c.json({ status: 'ok' })
    }

    try {
      await db.ping()
      return c.json({ status: 'ok', db: 'ok' })
    } catch {
      return c.json({ status: 'degraded', db: 'error' }, 503)
    }
  })

  return rutas
}
