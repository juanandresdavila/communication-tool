import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'

// Se salta sin DATABASE_URL para que CI quede verde sin base.
// El ?? '' evita el non-null assertion, que typescript-eslint rechaza.
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

correr('migrate contra una base real', () => {
  let dir: string

  async function limpiar() {
    const client = postgres(DATABASE_URL, { max: 1 })
    await client.unsafe('DROP TABLE IF EXISTS _migration_smoke')
    await client.unsafe(
      "DELETE FROM schema_migrations WHERE name = '9999_smoke.sql'",
    )
    await client.end()
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ct-migrations-'))

    // El directorio temporal tiene que incluir las migraciones REALES, no solo
    // la de humo: la base ya las tiene aplicadas, y pendingMigrations aborta —
    // con razón — si encuentra en la base una migración que no está en disco.
    const reales = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'migrations',
    )
    for (const archivo of await readdir(reales)) {
      if (archivo.endsWith('.sql')) {
        await copyFile(join(reales, archivo), join(dir, archivo))
      }
    }

    // 9999 para que quede después de cualquier migración real, presente o
    // futura, y no dispare el chequeo de orden.
    await writeFile(
      join(dir, '9999_smoke.sql'),
      'CREATE TABLE _migration_smoke (id int PRIMARY KEY);',
    )
    await limpiar()
  })

  afterAll(async () => {
    await limpiar()
    await rm(dir, { recursive: true, force: true })
  })

  it('aplica las pendientes y es idempotente al repetir', async () => {
    const primera = await migrate(dir)
    expect(primera).toEqual(['9999_smoke.sql'])

    const segunda = await migrate(dir)
    expect(segunda).toEqual([])

    const client = postgres(DATABASE_URL, { max: 1 })
    const rows = await client.unsafe<{ count: string }[]>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = '_migration_smoke'",
    )
    await client.end()
    expect(rows[0]?.count).toBe('1')
  }, 30_000)
})
