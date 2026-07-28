import { neon } from '@neondatabase/serverless'

/**
 * Único punto de acceso a la base desde el runtime del servicio.
 * Ningún otro módulo importa @neondatabase/serverless.
 */
export interface Db {
  ping(): Promise<void>
}

export function createDb(databaseUrl: string): Db {
  const sql = neon(databaseUrl)
  return {
    async ping() {
      await sql`SELECT 1`
    },
  }
}
