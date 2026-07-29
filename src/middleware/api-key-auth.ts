import type { MiddlewareHandler } from 'hono'
import type { App, AppsRepo } from '../db/ports.js'
import { hashApiKey } from '../identity/api-key.js'

export interface ConVariablesDeApp {
  Variables: { app: App }
}

/**
 * La búsqueda es por hash, no por comparación: el índice de la base hace el
 * trabajo y no queda una comparación de secretos en el proceso. Un hash que no
 * está en la tabla simplemente no matchea.
 */
export function apiKeyAuth(
  apps: AppsRepo,
): MiddlewareHandler<ConVariablesDeApp> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const [esquema, clave] = header.split(' ')

    if (esquema !== 'Bearer' || !clave) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    const app = await apps.findByApiKeyHash(hashApiKey(clave))
    if (!app) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    c.set('app', app)
    await next()
    return undefined
  }
}
