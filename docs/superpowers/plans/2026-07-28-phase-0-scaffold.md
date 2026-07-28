# communication-tool — Fase 0: Scaffold

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el servicio desplegado, testeado y conectado a Neon, con un `/health` real y un migrador funcionando — sin ninguna regla de negocio todavía.

**Architecture:** Una app Hono construida por una factory `createApp(deps)` que recibe sus dependencias inyectadas, de modo que todo se testea sin red ni base. El acceso a datos se esconde detrás de una interfaz `Db` mínima, con una implementación sobre el driver HTTP de Neon y un doble de test. Las migraciones se parten en dos: la lógica de orden y pendientes es TypeScript puro con TDD, y el shell que las aplica usa `Client` sobre WebSocket porque el driver HTTP no soporta SQL multi-statement ni transacciones.

**Tech Stack:** Hono, Bun, TypeScript, Zod, `@neondatabase/serverless`, Vitest, ESLint, GitHub Actions, Vercel, Neon.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## Nota sobre el alcance de esta fase

El spec dice que la fase 0 entrega «Hono + Bun, Neon, migraciones, CI, deploy, `/health`». Este plan cubre exactamente eso y nada más. No hay tablas de dominio: `apps`, `bots`, `contacts` y compañía son de la fase 1. El directorio `migrations/` queda vacío a propósito, y el migrador se prueba con una migración generada dentro de un test de integración.

Dos desvíos del spec, ambos deliberados y chicos:

1. **CI corre lint, typecheck y test, no `build`.** Un servicio Hono no tiene paso de build propio: Vercel compila en el deploy. `typecheck` cubre lo que `build` cubriría.
2. **`/health` no toca la base salvo que se lo pidas con `?deep=1`.** Es una consecuencia directa del presupuesto de cómputo de Neon que discute el spec en §Programación: un monitor de uptime pegándole cada minuto a un health que hace `SELECT 1` mantendría la base despierta 24/7. Hay un test que lo blinda.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `package.json` | Scripts y dependencias |
| `tsconfig.json` | TypeScript estricto para Bun |
| `vitest.config.ts` | Configuración de tests |
| `eslint.config.mjs` | Lint |
| `.env.example` | Variables documentadas |
| `.gitignore` | |
| `.github/workflows/ci.yml` | lint + typecheck + test |
| `src/env.ts` | Lee y valida variables de entorno. Puro |
| `src/db/client.ts` | Interfaz `Db` + implementación Neon HTTP |
| `src/db/migrations.ts` | Orden y cálculo de pendientes. **Puro, con TDD** |
| `src/db/migrate.ts` | Shell que aplica migraciones con `Client` |
| `src/routes/health.ts` | `GET /health` |
| `src/app.ts` | Factory `createApp(deps)` que monta las rutas |
| `src/index.ts` | Entrypoint: arma dependencias reales y exporta la app |
| `src/test-support/fake-db.ts` | Doble de test de `Db`, reutilizable en fases futuras |
| `migrations/` | Vacío en esta fase |
| `CLAUDE.md` | Contexto para sesiones futuras |

El corte importante: `src/app.ts` no sabe de dónde salen sus dependencias y `src/index.ts` es el único lugar que lee `process.env`. Eso es lo que permite que todos los tests corran sin base y sin red.

---

## Task 1: Scaffold del proyecto

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `.gitignore`, `.env.example`
- Test: `src/scaffold.test.ts`

- [ ] **Step 1: Inicializar e instalar dependencias**

```bash
cd ~/Projects/communication-tool
bun init -y
rm -f index.ts
bun add hono @neondatabase/serverless zod
bun add -d vitest typescript @types/bun eslint @eslint/js typescript-eslint
```

Las versiones las resuelve `bun add`; no las fijes a mano.

- [ ] **Step 2: Escribir `package.json`**

Reemplazá el archivo completo, conservando el bloque `dependencies`/`devDependencies` que generó `bun add`:

```json
{
  "name": "communication-tool",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "bun run src/db/migrate.ts"
  }
}
```

- [ ] **Step 3: Escribir `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "*.ts", "*.mjs"]
}
```

- [ ] **Step 4: Escribir `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Escribir `eslint.config.mjs`**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', '.vercel/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
```

- [ ] **Step 6: Escribir `.gitignore`**

```
node_modules/
.env
.env.local
.vercel/
coverage/
*.log
```

- [ ] **Step 7: Escribir `.env.example`**

```
# Cadena de conexión de Neon.
# Formato: postgres://usuario:password@host.neon.tech/dbname?sslmode=require
# En Vercel se carga desde el dashboard, no desde este archivo.
DATABASE_URL=
```

- [ ] **Step 8: Escribir un test que pruebe que el arnés funciona**

`src/scaffold.test.ts`:

```ts
import { expect, it } from 'vitest'

it('el arnés de tests corre', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 9: Verificar que todo el tooling arranca**

```bash
bun run test && bun run typecheck && bun run lint
```

Esperado: el test pasa, `tsc` no imprime errores, `eslint` no imprime nada.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold con bun, typescript, vitest y eslint"
```

---

## Task 2: Validación de variables de entorno

Todo el resto del servicio depende de que la configuración esté bien o falle ruidosamente al arrancar. Que sea una función pura la hace testeable sin tocar `process.env`.

**Files:**
- Create: `src/env.ts`
- Test: `src/env.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseEnv } from './env'

describe('parseEnv', () => {
  it('devuelve la config cuando DATABASE_URL está presente', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
      DATABASE_URL: 'postgres://x',
    })
  })

  it('falla nombrando la variable que falta', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/)
  })

  it('falla si DATABASE_URL está vacía', () => {
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
  })

  it('ignora variables desconocidas', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://x', OTRA: 'y' })).toEqual({
      DATABASE_URL: 'postgres://x',
    })
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/env.test.ts
```

Esperado: FAIL — `Failed to resolve import "./env"`.

- [ ] **Step 3: Escribir la implementación mínima**

`src/env.ts`:

```ts
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'es obligatoria'),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const resultado = envSchema.safeParse(raw)
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`Configuración inválida — ${detalle}`)
  }
  return resultado.data
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/env.test.ts
```

Esperado: PASS, 4 tests.

- [ ] **Step 5: Borrar el test de andamiaje**

Ya cumplió su función: hay tests reales.

```bash
rm src/scaffold.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A src/
git commit -m "feat: validación de variables de entorno con zod"
```

---

## Task 3: Interfaz de base de datos y doble de test

La interfaz `Db` es deliberadamente diminuta: en la fase 0 solo hace falta saber si la base contesta. Va a crecer en la fase 1. Lo que importa acá es que exista el corte, para que nada más en el código importe `@neondatabase/serverless` directamente.

**Files:**
- Create: `src/db/client.ts`, `src/test-support/fake-db.ts`
- Test: `src/test-support/fake-db.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/test-support/fake-db.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createFakeDb } from './fake-db'

describe('createFakeDb', () => {
  it('por defecto responde al ping', async () => {
    await expect(createFakeDb().ping()).resolves.toBeUndefined()
  })

  it('falla el ping cuando se lo pide', async () => {
    await expect(createFakeDb({ pingFalla: true }).ping()).rejects.toThrow()
  })

  it('cuenta cuántas veces se llamó al ping', async () => {
    const db = createFakeDb()
    await db.ping()
    await db.ping()
    expect(db.pings).toBe(2)
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
bun run test src/test-support/fake-db.test.ts
```

Esperado: FAIL — `Failed to resolve import "./fake-db"`.

- [ ] **Step 3: Escribir la interfaz `Db`**

`src/db/client.ts`:

```ts
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
```

- [ ] **Step 4: Escribir el doble de test**

`src/test-support/fake-db.ts`:

```ts
import type { Db } from '../db/client'

export interface FakeDb extends Db {
  pings: number
}

export function createFakeDb(options: { pingFalla?: boolean } = {}): FakeDb {
  const fake: FakeDb = {
    pings: 0,
    async ping() {
      fake.pings += 1
      if (options.pingFalla) throw new Error('base caída')
    },
  }
  return fake
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

```bash
bun run test src/test-support/fake-db.test.ts
```

Esperado: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/client.ts src/test-support/
git commit -m "feat: interfaz Db sobre el driver HTTP de neon y doble de test"
```

---

## Task 4: `GET /health` y la factory de la app

El test más importante de esta tarea es el que verifica que `/health` **no** toca la base. Encoda una restricción de presupuesto real, no una preferencia de estilo.

**Files:**
- Create: `src/routes/health.ts`, `src/app.ts`
- Test: `src/routes/health.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/routes/health.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createFakeDb } from '../test-support/fake-db'

describe('GET /health', () => {
  it('responde 200 sin despertar a la base', async () => {
    const db = createFakeDb()
    const res = await createApp({ db }).request('/health')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(db.pings).toBe(0)
  })

  it('con ?deep=1 confirma que la base responde', async () => {
    const db = createFakeDb()
    const res = await createApp({ db }).request('/health?deep=1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' })
    expect(db.pings).toBe(1)
  })

  it('con ?deep=1 devuelve 503 si la base falla', async () => {
    const db = createFakeDb({ pingFalla: true })
    const res = await createApp({ db }).request('/health?deep=1')

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'degraded', db: 'error' })
  })

  it('devuelve 404 en una ruta que no existe', async () => {
    const res = await createApp({ db: createFakeDb() }).request('/no-existe')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/routes/health.test.ts
```

Esperado: FAIL — `Failed to resolve import "../app"`.

- [ ] **Step 3: Escribir la ruta**

`src/routes/health.ts`:

```ts
import { Hono } from 'hono'
import type { Db } from '../db/client'

export function healthRoutes(db: Db): Hono {
  const rutas = new Hono()

  rutas.get('/health', async (c) => {
    // Por defecto no se toca la base: Neon se suspende a los 5 minutos de
    // inactividad y un monitor de uptime la mantendría despierta 24/7.
    if (c.req.query('deep') !== '1') {
      return c.json({ status: 'ok' })
    }

    try {
      await db.ping()
      return c.json({ status: 'ok', db: 'ok' })
    } catch {
      return c.json({ status: 'degraded', db: 'error' }, 503)
    }
  })

  return rutas
}
```

- [ ] **Step 4: Escribir la factory de la app**

`src/app.ts`:

```ts
import { Hono } from 'hono'
import type { Db } from './db/client'
import { healthRoutes } from './routes/health'

export interface Deps {
  db: Db
}

/**
 * Construye la app con sus dependencias inyectadas.
 * No lee process.env: eso es responsabilidad de src/index.ts.
 */
export function createApp(deps: Deps): Hono {
  const app = new Hono()
  app.route('/', healthRoutes(deps.db))
  return app
}
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

```bash
bun run test src/routes/health.test.ts
```

Esperado: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/routes/
git commit -m "feat: GET /health con chequeo profundo opcional"
```

---

## Task 5: Entrypoint

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Escribir el entrypoint**

`src/index.ts`:

```ts
import { createApp } from './app'
import { createDb } from './db/client'
import { parseEnv } from './env'

// Único lugar del servicio que lee process.env.
const env = parseEnv(process.env)

const app = createApp({ db: createDb(env.DATABASE_URL) })

// El default export es lo que consumen tanto Vercel como Bun.
export default app
```

- [ ] **Step 2: Levantar el servidor local**

Creá `.env` con una `DATABASE_URL` real de Neon (ver Task 9 si todavía no tenés la base) y corré:

```bash
bun run dev
```

Esperado: Bun sirve en `http://localhost:3000`.

- [ ] **Step 3: Verificar los dos modos a mano**

```bash
curl -s localhost:3000/health && echo && curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health?deep=1
```

Esperado: `{"status":"ok"}` y después `200`.

Si el deep devuelve `503`, la `DATABASE_URL` está mal: revisala antes de seguir.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: entrypoint que arma las dependencias reales"
```

---

## Task 6: Lógica de migraciones (pura)

Esta es la parte del migrador donde de verdad hay bugs: orden, pendientes, y las dos formas en que un repo y una base se desincronizan. Todo puro, todo con TDD.

**Files:**
- Create: `src/db/migrations.ts`
- Test: `src/db/migrations.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/db/migrations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { pendingMigrations, sortMigrationNames } from './migrations'

describe('sortMigrationNames', () => {
  it('ordena por número, no alfabéticamente por el nombre suelto', () => {
    expect(
      sortMigrationNames(['0010_zeta.sql', '0002_alpha.sql', '0001_beta.sql']),
    ).toEqual(['0001_beta.sql', '0002_alpha.sql', '0010_zeta.sql'])
  })

  it('rechaza nombres sin prefijo numérico', () => {
    expect(() => sortMigrationNames(['init.sql'])).toThrow(/inválido/)
  })

  it('rechaza nombres con mayúsculas o espacios', () => {
    expect(() => sortMigrationNames(['0001_Init.sql'])).toThrow(/inválido/)
    expect(() => sortMigrationNames(['0001 init.sql'])).toThrow(/inválido/)
  })
})

describe('pendingMigrations', () => {
  it('devuelve todas cuando la base está vacía', () => {
    expect(pendingMigrations(['0001_a.sql', '0002_b.sql'], [])).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ])
  })

  it('devuelve vacío cuando ya está todo aplicado', () => {
    expect(
      pendingMigrations(['0001_a.sql'], ['0001_a.sql']),
    ).toEqual([])
  })

  it('devuelve solo las nuevas, en orden', () => {
    expect(
      pendingMigrations(
        ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
        ['0001_a.sql'],
      ),
    ).toEqual(['0002_b.sql', '0003_c.sql'])
  })

  it('falla si la base tiene una migración que no está en disco', () => {
    expect(() =>
      pendingMigrations(['0001_a.sql'], ['0001_a.sql', '0002_fantasma.sql']),
    ).toThrow(/no están en disco/)
  })

  it('falla si aparece una migración anterior a la última aplicada', () => {
    expect(() =>
      pendingMigrations(['0001_a.sql', '0002_b.sql'], ['0002_b.sql']),
    ).toThrow(/fuera de orden/)
  })
})
```

Los dos últimos tests son los que importan. El primero detecta una base más nueva que el checkout; el segundo, dos ramas que crearon migraciones en paralelo y se mergearon — el caso que corrompe el esquema en silencio.

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/db/migrations.test.ts
```

Esperado: FAIL — `Failed to resolve import "./migrations"`.

- [ ] **Step 3: Escribir la implementación**

`src/db/migrations.ts`:

```ts
const NOMBRE_VALIDO = /^\d{4}_[a-z0-9_]+\.sql$/

export function assertValidMigrationName(nombre: string): void {
  if (!NOMBRE_VALIDO.test(nombre)) {
    throw new Error(
      `Nombre de migración inválido: "${nombre}". Se espera NNNN_snake_case.sql`,
    )
  }
}

export function sortMigrationNames(nombres: string[]): string[] {
  nombres.forEach(assertValidMigrationName)
  // El prefijo de 4 dígitos con ceros a la izquierda hace que el orden
  // lexicográfico coincida con el numérico.
  return [...nombres].sort()
}

export function pendingMigrations(
  enDisco: string[],
  aplicadas: string[],
): string[] {
  const ordenadas = sortMigrationNames(enDisco)
  const yaAplicadas = new Set(aplicadas)

  const fantasmas = aplicadas.filter((a) => !ordenadas.includes(a))
  if (fantasmas.length > 0) {
    throw new Error(
      `La base tiene migraciones que no están en disco: ${fantasmas.join(', ')}. ` +
        'El checkout está desactualizado o se borró un archivo.',
    )
  }

  const pendientes = ordenadas.filter((n) => !yaAplicadas.has(n))
  const ultimaAplicada = ordenadas.filter((n) => yaAplicadas.has(n)).at(-1)

  if (ultimaAplicada !== undefined) {
    const fueraDeOrden = pendientes.filter((n) => n < ultimaAplicada)
    if (fueraDeOrden.length > 0) {
      throw new Error(
        `Migraciones fuera de orden: ${fueraDeOrden.join(', ')} son anteriores ` +
          `a ${ultimaAplicada}, que ya está aplicada. Renumerá antes de seguir.`,
      )
    }
  }

  return pendientes
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/db/migrations.test.ts
```

Esperado: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat: cálculo de migraciones pendientes con detección de desincronización"
```

---

## Task 7: Runner de migraciones

El driver HTTP (`neon()`) no sirve acá: no soporta SQL multi-statement ni transacciones reales. El runner usa `Client`, que habla por WebSocket y es compatible con node-postgres. Bun y Node 22+ traen `WebSocket` global y el driver lo toma solo, así que no hace falta el shim `ws`.

Si al correr aparece un error de constructor de WebSocket, agregá al principio de `migrate.ts`:

```ts
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
neonConfig.webSocketConstructor = ws
```

con `bun add -d ws @types/ws`. No lo agregues preventivamente.

**Files:**
- Create: `src/db/migrate.ts`, `migrations/.gitkeep`

- [ ] **Step 1: Crear el directorio de migraciones vacío**

```bash
mkdir -p migrations && touch migrations/.gitkeep
```

Queda vacío a propósito: las tablas de dominio son de la fase 1.

- [ ] **Step 2: Escribir el runner**

`src/db/migrate.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@neondatabase/serverless'
import { parseEnv } from '../env'
import { pendingMigrations } from './migrations'

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

    const archivos = (await readdir(dir).catch(() => []))
      .filter((f) => f.endsWith('.sql'))

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
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [nombre],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Falló ${nombre}: ${(error as Error).message}`)
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
```

Cada migración va en su propia transacción: si la tercera falla, las dos primeras quedan aplicadas y registradas, y al corregir el error se retoma desde ahí.

- [ ] **Step 3: Escribir el test de integración**

`src/db/migrate.integration.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from './migrate'

// Se salta sin DATABASE_URL para que CI quede verde sin base.
// El ?? '' evita el non-null assertion, que typescript-eslint rechaza.
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

correr('migrate contra una base real', () => {
  let dir: string

  async function limpiar() {
    const client = new Client(DATABASE_URL)
    await client.connect()
    await client.query('DROP TABLE IF EXISTS _migration_smoke')
    await client.query(
      "DELETE FROM schema_migrations WHERE name = '0001_smoke.sql'",
    )
    await client.end()
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ct-migrations-'))
    await writeFile(
      join(dir, '0001_smoke.sql'),
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
    expect(primera).toEqual(['0001_smoke.sql'])

    const segunda = await migrate(dir)
    expect(segunda).toEqual([])

    const client = new Client(DATABASE_URL)
    await client.connect()
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = '_migration_smoke'",
    )
    await client.end()
    expect(rows[0]?.count).toBe('1')
  }, 30_000)
})
```

El `beforeAll` limpia además de al final: si una corrida anterior murió a la mitad, la siguiente arranca limpia igual.

- [ ] **Step 4: Correr el test sin base para verificar que se saltea**

```bash
bun run test src/db/migrate.integration.test.ts
```

Esperado: el bloque aparece como `skipped` y el comando sale con código 0.

- [ ] **Step 5: Correr el test con base real**

Con `DATABASE_URL` en `.env` (ver Task 9 si todavía no la tenés):

```bash
bun run test src/db/migrate.integration.test.ts
```

Esperado: PASS, 1 test.

- [ ] **Step 6: Verificar el CLI a mano**

```bash
bun run db:migrate
```

Esperado: `Sin migraciones pendientes (0 aplicadas).` — porque `migrations/` está vacío. La tabla `schema_migrations` queda creada.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrate.ts src/db/migrate.integration.test.ts migrations/
git commit -m "feat: runner de migraciones con transacción por archivo"
```

---

## Task 8: CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Escribir el workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - run: bun run lint

      - run: bun run typecheck

      # Sin DATABASE_URL: el test de integración de migraciones se saltea solo.
      - run: bun run test
```

- [ ] **Step 2: Verificar localmente lo mismo que corre CI**

```bash
bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test
```

Esperado: los tres pasan y el bloque de integración figura como `skipped`.

- [ ] **Step 3: Commit y push**

```bash
git add .github/
git commit -m "ci: lint, typecheck y test en cada PR y push a main"
git push -u origin main
```

- [ ] **Step 4: Verificar que CI pasó en GitHub**

```bash
gh run watch
```

Esperado: el job `check` termina en verde. Si el repo remoto no existe todavía, creálo antes con `gh repo create communication-tool --private --source=. --push`.

---

## Task 9: Base en Neon y deploy en Vercel

Esta tarea tiene pasos que hace el usuario en interfaces web, no el código.

**Files:**
- Modify: `.env` (local, no versionado)

- [ ] **Step 1: Crear la base en Neon**

En [console.neon.tech](https://console.neon.tech): proyecto nuevo, región la más cercana. Copiá la cadena de conexión *pooled* y ponela en `.env` local como `DATABASE_URL`.

- [ ] **Step 2: Correr las migraciones contra la base nueva**

```bash
bun run db:migrate
```

Esperado: `Sin migraciones pendientes (0 aplicadas).`

- [ ] **Step 3: Verificar que `schema_migrations` existe**

```bash
bun run test src/db/migrate.integration.test.ts
```

Esperado: PASS, 1 test. Confirma de punta a punta que la base responde, que el runner aplica y que es idempotente.

- [ ] **Step 4: Conectar el repo a Vercel**

Importá el repo en Vercel. Cargá `DATABASE_URL` como variable de entorno en Production, Preview y Development.

Vercel detecta Hono por el `export default` de `src/index.ts` y no hace falta `vercel.json`.

**Si el deploy no levanta la app** (404 en la raíz, o el build no encuentra un entrypoint), la causa es que la autodetección no reconoció el proyecto. Fallback: creá `vercel.json` en la raíz con

```json
{ "framework": "hono" }
```

y volvé a deployar. Si sigue fallando, generá un proyecto de referencia con `bun create hono@latest tmp-ref --template vercel` y copiá la estructura de entrypoint que use, sin tocar `src/app.ts` ni los tests.

- [ ] **Step 5: Verificar el deploy**

Con la URL de producción en `$URL`:

```bash
curl -s "$URL/health" && echo && curl -s "$URL/health?deep=1"
```

Esperado: `{"status":"ok"}` y `{"status":"ok","db":"ok"}`.

El segundo es el que importa: prueba que Vercel llega a Neon con la variable bien cargada.

- [ ] **Step 6: Commit si hubo cambios**

```bash
git add -A
git commit -m "chore: configuración de deploy en vercel"
```

Si no hizo falta tocar ningún archivo, saltealo.

---

## Task 10: Documentación de contexto

**Files:**
- Create: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Escribir `CLAUDE.md`**

```markdown
# CLAUDE.md

Guía para Claude Code en este repositorio.

## Qué es esto

API intermediaria que centraliza la comunicación por bots de Telegram (y en
el futuro WhatsApp) para las apps del ecosistema: GymTracker, Study Master y
las que vengan. Es un servicio de **transporte e identidad de canal**.

## Estado del proyecto

Fase 0 — Scaffold **completa**. Hono sobre Bun, base en Neon, runner de
migraciones, CI en GitHub Actions, deploy en Vercel y `GET /health`.
Sin tablas de dominio todavía: `migrations/` está vacío.

**Próxima fase:** Fase 1 — Identidad (`apps`, `bots`, `contacts`,
`link_codes`, webhook de Telegram, `/vincular`). Generar el plan con
`superpowers:writing-plans` contra el spec.

## Required reading

- **`docs/superpowers/specs/2026-07-28-communication-tool-design.md`** — spec
  vigente. Leer antes de cualquier decisión arquitectónica.

## Invariantes

- **communication-tool nunca llama a un LLM** y **nunca lee datos de dominio**
  de sus consumidores. El parseo es de cada app.
- **La app nunca ve un `chat_id`. comm-tool nunca interpreta un
  `app_user_id`.**
- **Los secretos viven en variables de entorno.** La base guarda configuración
  y el *nombre* de la variable, nunca su valor.
- **`src/app.ts` no lee `process.env`.** Recibe sus dependencias inyectadas;
  `src/index.ts` es el único que las arma. Por eso todos los tests corren sin
  red y sin base.
- **Nadie importa `@neondatabase/serverless` fuera de `src/db/`.**
- **`/health` no toca la base salvo con `?deep=1`.** Neon se suspende a los 5
  minutos de inactividad y cobra por hora de cómputo.
- **Sin RLS y sin Supabase**: no hay cliente browser.

## Dos drivers de Neon, a propósito

- `neon()` (HTTP) para el runtime: baja latencia, una query por request.
- `Client` (WebSocket) solo en `src/db/migrate.ts`: el HTTP no soporta SQL
  multi-statement ni transacciones reales.

## Build, test, run

```bash
bun run dev         # servidor local en :3000
bun run test        # Vitest
bun run lint        # ESLint
bun run typecheck   # tsc --noEmit
bun run db:migrate  # aplica migraciones pendientes
```

CI corre lint + typecheck + test en cada PR y push a main. El test de
integración de migraciones se saltea solo si no hay `DATABASE_URL`.

## Migraciones

Archivos `migrations/NNNN_snake_case.sql`, aplicados en orden, cada uno en su
propia transacción y registrados en `schema_migrations`. El runner falla si la
base tiene migraciones que no están en disco, o si aparece una anterior a la
última aplicada — nunca las aplica fuera de orden.

## Convenciones de commit

- **NO agregar `Co-Authored-By: Claude`** ni líneas de autoría de IA.
- Prefijos convencionales (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
- Commits chicos y revisables.

## Ante la duda

El spec responde la mayoría de las preguntas. Si algo genuinamente no está,
preguntar al usuario — no inventar.
```

- [ ] **Step 2: Escribir `README.md`**

```markdown
# communication-tool

API intermediaria que centraliza la comunicación por bots de Telegram y
WhatsApp para las apps del ecosistema. Unifica el registro y la vinculación de
usuarios, el ruteo de mensajes entrantes, el envío de salientes y la
programación de avisos recurrentes.

Diseño completo: `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

## Stack

Hono sobre Bun · TypeScript · Neon (Postgres) · Vitest · Vercel

## Puesta en marcha

```bash
bun install
cp .env.example .env   # completar DATABASE_URL con la cadena de Neon
bun run db:migrate
bun run dev
```

```bash
curl localhost:3000/health
curl localhost:3000/health?deep=1   # además verifica la base
```

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor local con recarga en caliente |
| `bun run test` | Vitest |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:migrate` | Aplica las migraciones pendientes |

## Estado

Fase 0 (scaffold) completa. Ver `CLAUDE.md` para el estado detallado y las
fases siguientes.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: README y guía de contexto del repositorio"
```

---

## Verificación de la fase

La fase 0 está completa cuando todo esto pasa:

- [ ] `bun run lint && bun run typecheck && bun run test` en verde localmente.
- [ ] CI en verde en GitHub sobre `main`.
- [ ] `bun run db:migrate` reporta `Sin migraciones pendientes (0 aplicadas).`
- [ ] `bun run test src/db/migrate.integration.test.ts` pasa con `DATABASE_URL` cargada y se saltea sin ella.
- [ ] `curl "$URL/health"` en producción devuelve `{"status":"ok"}`.
- [ ] `curl "$URL/health?deep=1"` en producción devuelve `{"status":"ok","db":"ok"}`.

Recién con el último punto verde está probado el camino completo: Vercel llega a Neon con la configuración correcta. Todo lo anterior puede pasar con la base mal configurada.
