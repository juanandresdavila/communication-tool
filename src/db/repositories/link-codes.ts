import type { Sql } from '../client.js'
import type { LinkCode, LinkCodesRepo } from '../ports.js'

interface FilaCodigo {
  code: string
  app_id: string
  app_user_id: string
  expires_at: string
  used_at: string | null
}

function aCodigo(f: FilaCodigo): LinkCode {
  return {
    code: f.code,
    appId: f.app_id,
    appUserId: f.app_user_id,
    expiresAt: new Date(f.expires_at).toISOString(),
    usedAt: f.used_at ? new Date(f.used_at).toISOString() : null,
  }
}

export function createLinkCodesRepo(sql: Sql): LinkCodesRepo {
  return {
    async create(input) {
      await sql`
        INSERT INTO link_codes (code, app_id, app_user_id, expires_at)
        VALUES (${input.code}, ${input.appId}, ${input.appUserId},
                ${input.expiresAt.toISOString()})
      `
    },

    async find(code) {
      const filas = (await sql`
        SELECT code, app_id, app_user_id, expires_at, used_at
        FROM link_codes WHERE code = ${code} LIMIT 1
      `) as FilaCodigo[]
      const fila = filas[0]
      return fila ? aCodigo(fila) : null
    },

    async redeem(code, ahora) {
      // La condición de un solo uso vive en el WHERE: dos requests simultáneos
      // no pueden canjear el mismo código, porque el UPDATE toma el lock de la
      // fila y el segundo ya no matchea used_at IS NULL.
      const filas = (await sql`
        UPDATE link_codes
        SET used_at = ${ahora.toISOString()}
        WHERE code = ${code}
          AND used_at IS NULL
          AND expires_at > ${ahora.toISOString()}
        RETURNING code, app_id, app_user_id, expires_at, used_at
      `) as FilaCodigo[]
      const fila = filas[0]
      return fila ? aCodigo(fila) : null
    },
  }
}
