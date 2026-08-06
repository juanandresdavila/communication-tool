import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { parseDatabaseEnv } from '../env.js'
import { pendingMigrations } from './migrations.js'

// NO usar import.meta.dir: existe en Bun pero no cuando Vitest importa este
// módulo, y el test de integración lo importa. fileURLToPath anda en los dos.
const AQUI = dirname(fileURLToPath(import.meta.url))
const DIR_POR_DEFECTO = join(AQUI, '..', '..', 'migrations')

export async function migrate(dir: string = DIR_POR_DEFECTO): Promise<string[]> {
  const env = parseDatabaseEnv(process.env)
  // max: 1 — el runner es secuencial; un pool solo suma estados que limpiar.
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} })

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `

    const archivos = (await readdir(dir).catch(() => [])).filter((f) =>
      f.endsWith('.sql'),
    )

    const filas = await sql<{ name: string }[]>`
      SELECT name FROM schema_migrations ORDER BY name
    `
    const aplicadas = filas.map((r) => r.name)

    const pendientes = pendingMigrations(archivos, aplicadas)

    if (pendientes.length === 0) {
      console.log(`Sin migraciones pendientes (${aplicadas.length} aplicadas).`)
      return []
    }

    for (const nombre of pendientes) {
      const texto = await readFile(join(dir, nombre), 'utf8')
      console.log(`Aplicando ${nombre}...`)
      try {
        // sql.begin abre la transacción y hace COMMIT/ROLLBACK solo; unsafe()
        // sin parámetros usa el protocolo simple, así que acepta archivos con
        // varias sentencias.
        await sql.begin(async (trx) => {
          await trx.unsafe(texto)
          await trx`INSERT INTO schema_migrations (name) VALUES (${nombre})`
        })
      } catch (error) {
        throw new Error(`Falló ${nombre}: ${(error as Error).message}`, {
          cause: error,
        })
      }
      console.log(`  OK ${nombre}`)
    }

    console.log(`Listo. ${pendientes.length} migración(es) aplicada(s).`)
    return pendientes
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  await migrate()
}
