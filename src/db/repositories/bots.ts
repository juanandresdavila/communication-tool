import type { Sql } from '../client.js'
import type { Bot, BotsRepo, Channel } from '../ports.js'

interface FilaBot {
  id: string
  app_id: string
  channel: string
  slug: string
  username: string | null
  token_env: string
  webhook_secret_env: string
  unlinked_message: string
  active: boolean
}

function aBot(f: FilaBot): Bot {
  return {
    id: f.id,
    appId: f.app_id,
    channel: f.channel as Channel,
    slug: f.slug,
    username: f.username,
    tokenEnv: f.token_env,
    webhookSecretEnv: f.webhook_secret_env,
    unlinkedMessage: f.unlinked_message,
    active: f.active,
  }
}

export function createBotsRepo(sql: Sql): BotsRepo {
  return {
    async findBySlug(slug) {
      const filas = (await sql`
        SELECT id, app_id, channel, slug, username, token_env,
               webhook_secret_env, unlinked_message, active
        FROM bots
        WHERE slug = ${slug}
        LIMIT 1
      `) as FilaBot[]
      const fila = filas[0]
      return fila ? aBot(fila) : null
    },
  }
}
