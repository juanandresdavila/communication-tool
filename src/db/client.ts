import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

export type Sql = NeonQueryFunction<false, false>

/**
 * Único punto de acceso a la base desde el runtime del servicio.
 * Ningún otro módulo importa @neondatabase/serverless: los repositorios
 * reciben el `Sql` ya construido.
 */
export interface Db {
  ping(): Promise<void>
}

export function createSql(databaseUrl: string): Sql {
  return neon(databaseUrl)
}

export function createDb(sql: Sql): Db {
  return {
    async ping() {
      await sql`SELECT 1`
    },
  }
}
