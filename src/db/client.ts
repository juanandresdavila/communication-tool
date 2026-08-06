import postgres from 'postgres'

export type Sql = postgres.Sql

// Lo que acepta sql.json(). Los repos lo usan para castear campos jsonb cuyo
// tipo de dominio (unknown, OutboundTemplate) no trae index signature.
export type Json = postgres.JSONValue

/**
 * Único punto de acceso a la base desde el runtime del servicio.
 * Ningún otro módulo importa el driver: los repositorios reciben el `Sql`
 * ya construido.
 */
export interface Db {
  ping(): Promise<void>
}

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    // El driver HTTP de Neon devolvía date/timestamp/timestamptz como STRING
    // y todos los repos asumen eso (`new Date(fila.campo)`). postgres.js por
    // defecto parsea a Date; esto lo desactiva para no cambiar el contrato.
    // OIDs: 1082 date, 1083 time, 1114 timestamp, 1184 timestamptz.
    types: {
      date: {
        to: 25,
        from: [1082, 1083, 1114, 1184],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
    onnotice: () => {},
  })
}

export function createDb(sql: Sql): Db {
  return {
    async ping() {
      await sql`SELECT 1`
    },
  }
}
