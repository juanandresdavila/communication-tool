import type { Sql } from '../client.js'
import type { Channel, Contact, ContactsRepo } from '../ports.js'

interface FilaContacto {
  id: string
  app_id: string
  channel: string
  external_id: string
  app_user_id: string
  linked_at: string
  blocked: boolean
}

function aContacto(f: FilaContacto): Contact {
  return {
    id: f.id,
    appId: f.app_id,
    channel: f.channel as Channel,
    externalId: f.external_id,
    appUserId: f.app_user_id,
    linkedAt: new Date(f.linked_at).toISOString(),
    blocked: f.blocked,
  }
}

// La lista de columnas va escrita entera en cada query, no interpolada con
// sql.unsafe(): la interpolación de identificadores dentro de un tagged
// template es justo el mecanismo que no conviene ejercitar sin necesidad.
export function createContactsRepo(sql: Sql): ContactsRepo {
  return {
    async findByExternalId(appId, channel, externalId) {
      const filas = (await sql`
        SELECT id, app_id, channel, external_id, app_user_id, linked_at, blocked
        FROM contacts
        WHERE app_id = ${appId} AND channel = ${channel}
          AND external_id = ${externalId}
        LIMIT 1
      `) as FilaContacto[]
      const fila = filas[0]
      return fila ? aContacto(fila) : null
    },

    async findByAppUserId(appId, channel, appUserId) {
      const filas = (await sql`
        SELECT id, app_id, channel, external_id, app_user_id, linked_at, blocked
        FROM contacts
        WHERE app_id = ${appId} AND channel = ${channel}
          AND app_user_id = ${appUserId}
        LIMIT 1
      `) as FilaContacto[]
      const fila = filas[0]
      return fila ? aContacto(fila) : null
    },

    async create(input) {
      const filas = (await sql`
        INSERT INTO contacts (app_id, channel, external_id, app_user_id)
        VALUES (${input.appId}, ${input.channel}, ${input.externalId},
                ${input.appUserId})
        RETURNING id, app_id, channel, external_id, app_user_id, linked_at, blocked
      `) as FilaContacto[]
      const fila = filas[0]
      if (!fila) throw new Error('El INSERT de contacts no devolvió la fila')
      return aContacto(fila)
    },

    async deleteByAppUserId(appId, channel, appUserId) {
      const filas = (await sql`
        DELETE FROM contacts
        WHERE app_id = ${appId} AND channel = ${channel}
          AND app_user_id = ${appUserId}
        RETURNING id
      `) as { id: string }[]
      return filas.length > 0
    },
  }
}
