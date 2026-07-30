import type { Sql } from '../client.js'
import type { App, AppsRepo } from '../ports.js'

interface FilaApp {
  id: string
  slug: string
  name: string
  delivery_url: string
  schedule_callback_url: string | null
  delivery_secret_env: string
  active: boolean
}

function aApp(f: FilaApp): App {
  return {
    id: f.id,
    slug: f.slug,
    name: f.name,
    deliveryUrl: f.delivery_url,
    scheduleCallbackUrl: f.schedule_callback_url,
    deliverySecretEnv: f.delivery_secret_env,
    active: f.active,
  }
}

export function createAppsRepo(sql: Sql): AppsRepo {
  return {
    async findByApiKeyHash(hash) {
      const filas = (await sql`
        SELECT id, slug, name, delivery_url, schedule_callback_url,
               delivery_secret_env, active
        FROM apps
        WHERE active = true
          AND (api_key_hash = ${hash} OR api_key_hash_next = ${hash})
        LIMIT 1
      `) as FilaApp[]
      const fila = filas[0]
      return fila ? aApp(fila) : null
    },

    async findById(id) {
      const filas = (await sql`
        SELECT id, slug, name, delivery_url, schedule_callback_url,
               delivery_secret_env, active
        FROM apps WHERE id = ${id} LIMIT 1
      `) as FilaApp[]
      const fila = filas[0]
      return fila ? aApp(fila) : null
    },
  }
}
