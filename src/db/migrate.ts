import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@neondatabase/serverless'
import { parseEnv } from '../env.js'
import { pendingMigrations } from './migrations.js'

// NO usar import.meta.dir: existe en Bun pero no cuando Vitest importa este
// módulo, y el test de integración lo importa. fileURLToPath anda en los dos.
const AQUI = dirname(fileURLToPath(import.meta.url))
const DIR_POR_DEFECTO = join(AQUI, '..', '..', 'migrations')

export async function migrate(dir: string = DIR_POR_DEFECTO): Promise<string[]> {
  const env = parseEnv(process.env)
  const client = new Client(env.DATABASE_URL)
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const archivos = (await readdir(dir).catch(() => [])).filter((f) =>
      f.endsWith('.sql'),
    )

    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    )
    const aplicadas = rows.map((r) => r.name)

    const pendientes = pendingMigrations(archivos, aplicadas)

    if (pendientes.length === 0) {
      console.log(`Sin migraciones pendientes (${aplicadas.length} aplicadas).`)
      return []
    }

    for (const nombre of pendientes) {
      const sql = await readFile(join(dir, nombre), 'utf8')
      console.log(`Aplicando ${nombre}...`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          nombre,
        ])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Falló ${nombre}: ${(error as Error).message}`, {
          cause: error,
        })
      }
      console.log(`  OK ${nombre}`)
    }

    console.log(`Listo. ${pendientes.length} migración(es) aplicada(s).`)
    return pendientes
  } finally {
    await client.end()
  }
}

if (import.meta.main) {
  await migrate()
}
