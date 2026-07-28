import { Hono } from 'hono'
import type { Db } from './db/client'
import { healthRoutes } from './routes/health'

export interface Deps {
  db: Db
}

/**
 * Construye la app con sus dependencias inyectadas.
 * No lee process.env: eso es responsabilidad de src/index.ts.
 */
export function createApp(deps: Deps): Hono {
  const app = new Hono()
  app.route('/', healthRoutes(deps.db))
  return app
}
