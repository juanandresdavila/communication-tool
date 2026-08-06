# Migración al VPS (Fase 1 del plan de infraestructura) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mover comm-tool de Vercel + Neon al VPS de OVH (Docker + Postgres propio + Caddy + Cloudflare Tunnel) sin perder un mensaje del bot de gimnasio.

**Architecture:** El servicio ya está desacoplado: un solo módulo habla con la base (`src/db/client.ts`) y una sola línea ata a Vercel (`waitUntil` inyectado en `src/index.ts`). Se cambia el driver de Neon por `postgres` (postgres.js, mismo contrato de tagged template), se extrae el cableado a `src/wire.ts` con dos entrypoints (Vercel y self-host con Bun), y se corre en el VPS detrás de Caddy → Cloudflare Tunnel en `comm.jadd.com.ar`. El tick pasa de cron-job.org a un systemd timer local. El cutover replica el método de la fase 4: verificar con update sintético ANTES de mover el webhook, rollback a un comando de distancia.

**Tech Stack:** Bun (runtime), Hono, postgres.js, Docker Compose, Caddy, Cloudflare Tunnel, systemd timers.

**Contexto de infraestructura** (fuera de este repo):
- VPS: `ssh vps` (Tailscale). Stacks en `/opt/stacks` (repo `vps-stacks`). Red Docker externa `edge` donde viven `caddy` y `cloudflared`.
- El comodín `*.jadd.com.ar` ya rutea al túnel → agregar un subdominio es solo tocar el Caddyfile.
- Doc del servidor: `~/Documents/1. Proyectos/4. Servidor/2. VPS/`.

**Datos duros:**
- Webhook actual: `https://communication-tool-beta.vercel.app/webhooks/telegram/gym` (ruta `POST /webhooks/telegram/:botSlug`, header `X-Telegram-Bot-Api-Secret-Token`).
- Ticker actual: cron-job.org cada 15 min → `POST /internal/tick`, `Authorization: Bearer $INTERNAL_SECRET`.
- Repo: `github.com/juanandresdavila/communication-tool` (el VPS ya tiene `gh` autenticado).
- El `.env` local del Mac tiene los valores reales (los de Vercel bajan como `[SENSITIVE]`).
- Consumidores: gym-tracker vía `COMM_TOOL_URL` (+ `COMM_TOOL_API_KEY`, `COMM_TOOL_DELIVERY_SECRET`); enumerar apps reales con `SELECT slug, delivery_url, schedule_callback_url FROM apps` contra Neon.

---

### Task 0: Rama de trabajo

**Files:** ninguno (git)

- [ ] **Step 1: Crear la rama desde main actualizado**

```bash
cd ~/Projects/communication-tool
git checkout main && git pull
git checkout -b migracion-vps
```

---

### Task 1: Driver postgres.js en `src/db/client.ts`

El contrato no cambia: los repos reciben un `Sql` que es un tagged template que
devuelve `Promise<fila[]>`. postgres.js cumple ese contrato. **Gotcha crítico:**
el driver HTTP de Neon devolvía los timestamps como *string*; postgres.js por
defecto los parsea a `Date`. Los repos hacen `new Date(fila.campo)` asumiendo
string. Se fuerza a postgres.js a dejarlos como string para no cambiar el
contrato silenciosamente.

**Files:**
- Modify: `src/db/client.ts`
- Modify: `package.json` (deps)

- [ ] **Step 1: Cambiar dependencias**

```bash
cd ~/Projects/communication-tool
bun remove @neondatabase/serverless && bun add postgres
```

- [ ] **Step 2: Reescribir `src/db/client.ts`**

```ts
import postgres from 'postgres'

export type Sql = postgres.Sql

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
```

- [ ] **Step 3: Typecheck + unit tests (no tocan la base, usan fakes)**

```bash
bun run typecheck && bun run test
```
Expected: typecheck limpio; los ~225 tests pasan (los de integración se
saltean sin `DATABASE_URL`).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/db/client.ts
git commit -m "feat: driver postgres.js en lugar de Neon serverless"
```

---

### Task 2: `migrate.ts` sin el Client de Neon

**Files:**
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: Reescribir el cuerpo con postgres.js**

Mantener la estructura (schema_migrations, `pendingMigrations`, transacción
por archivo). Reemplazar `Client` así:

```ts
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
        // sql.begin abre la transacción; unsafe() sin params usa el protocolo
        // simple y por eso acepta archivos con varias sentencias.
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
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrate.ts
git commit -m "feat: migrate.ts corre con postgres.js"
```

---

### Task 3: Tests de integración contra un Postgres local

Los 4 archivos `*.integration.test.ts` importan `Client` de Neon para el
setup/teardown crudo. Con el driver nuevo pueden correr contra un Postgres en
Docker en la Mac — algo que antes exigía Neon.

**Files:**
- Modify: `src/db/migrate.integration.test.ts`
- Modify: `src/db/repositories/repositories.integration.test.ts`
- Modify: `src/db/repositories/inbound-messages.integration.test.ts`
- Modify: `src/db/repositories/outbound-messages.integration.test.ts`

- [ ] **Step 1: Aplicar la transformación mecánica en los 4 archivos**

Regla exacta, misma semántica:

| Antes (Neon) | Después (postgres.js) |
|---|---|
| `import { Client } from '@neondatabase/serverless'` | `import postgres from 'postgres'` |
| `const c = new Client(URL); await c.connect()` | `const c = postgres(URL, { max: 1 })` |
| `await c.query('DELETE ... WHERE x = $1', [v])` | `await c.unsafe('DELETE ... WHERE x = $1', [v])` |
| `const { rows } = await c.query<T>('SELECT ...')` | `const rows = await c.unsafe('SELECT ...')` |
| `await c.end()` | `await c.end()` |

Ejemplo real (el `limpiar()` de `repositories.integration.test.ts`):

```ts
async function limpiar() {
  const c = postgres(DATABASE_URL, { max: 1 })
  await c.unsafe('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
  await c.end()
}
```

- [ ] **Step 2: Levantar un Postgres efímero y correr TODO con integración**

```bash
docker run -d --name commtool-pg -e POSTGRES_PASSWORD=test \
  -p 127.0.0.1:5433:5432 postgres:17-alpine
export DATABASE_URL='postgres://postgres:test@127.0.0.1:5433/postgres'
bun run db:migrate
bun run test
```
Expected: migraciones 0001–0004 aplicadas; la suite completa pasa **incluidos**
los `describe` de integración que antes se salteaban.

- [ ] **Step 3: Lint + limpiar**

```bash
bun run lint
docker rm -f commtool-pg
unset DATABASE_URL
```

- [ ] **Step 4: Commit**

```bash
git add src/db/*.integration.test.ts src/db/repositories/*.integration.test.ts
git commit -m "test: integración contra Postgres local con postgres.js"
```

---

### Task 4: `wire.ts` + entrypoint self-host

**Files:**
- Create: `src/wire.ts` (el cableado que hoy vive en `index.ts`)
- Modify: `src/index.ts` (queda como entrypoint Vercel, finito)
- Create: `src/server.ts` (entrypoint self-host, Bun.serve)

- [ ] **Step 1: Crear `src/wire.ts`**

Mover TODO el cableado de `src/index.ts` tal cual, parametrizando `waitUntil`:

```ts
import type { Hono } from 'hono'
import { createTelegramClient } from './channels/telegram/client.js'
import { createApp } from './create-app.js'
import { createDb, createSql, type Sql } from './db/client.js'
import { createAppsRepo } from './db/repositories/apps.js'
import { createBotsRepo } from './db/repositories/bots.js'
import { createContactsRepo } from './db/repositories/contacts.js'
import { createInboundMessagesRepo } from './db/repositories/inbound-messages.js'
import { createLinkCodesRepo } from './db/repositories/link-codes.js'
import { createOutboundMessagesRepo } from './db/repositories/outbound-messages.js'
import { createSchedulesRepo } from './db/repositories/schedules.js'
import { createDeliveryClient } from './delivery/client.js'
import { parseEnv } from './env.js'
import { createSecretReader } from './secrets.js'

export interface Wired {
  app: Hono
  sql: Sql
}

/**
 * Todo el cableado del servicio, compartido por los dos entrypoints.
 * `waitUntil` es lo único que difiere entre Vercel y self-host.
 */
export function wireApp(waitUntil: (promesa: Promise<unknown>) => void): Wired {
  // Único lugar del servicio que lee process.env.
  const env = parseEnv(process.env)
  const sql = createSql(env.DATABASE_URL)

  const app: Hono = createApp({
    db: createDb(sql),
    apps: createAppsRepo(sql),
    bots: createBotsRepo(sql),
    contacts: createContactsRepo(sql),
    linkCodes: createLinkCodesRepo(sql),
    telegram: createTelegramClient(),
    secrets: createSecretReader(process.env),
    now: () => new Date(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    inbound: createInboundMessagesRepo(sql),
    outbound: createOutboundMessagesRepo(sql),
    schedules: createSchedulesRepo(sql),
    delivery: createDeliveryClient(),
    internalSecret: env.INTERNAL_SECRET,
    waitUntil,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })

  return { app, sql }
}
```

(Si `createApp` recibe deps que este listado no refleja exactamente, la fuente
de verdad es el `src/index.ts` actual: es un MOVE, no una reescritura.)

- [ ] **Step 2: Adelgazar `src/index.ts` (entrypoint Vercel)**

```ts
import { waitUntil } from '@vercel/functions'
// El `import type { Hono }` y la anotación NO son decorativos: el preset de
// Hono de Vercel rechaza cualquier entrypoint que no importe hono.
// Ver CLAUDE.md, §Gotchas del tooling.
import type { Hono } from 'hono'
import { wireApp } from './wire.js'

const { app }: { app: Hono } = wireApp((promesa) => {
  waitUntil(promesa)
})

// El default export es lo que consume Vercel.
export default app
```

- [ ] **Step 3: Crear `src/server.ts` (entrypoint self-host)**

```ts
import { wireApp } from './wire.js'

// Self-host: el proceso vive, no hay runtime que corte la request al
// responder — un fire-and-forget alcanza. Es el reemplazo documentado del
// waitUntil de Vercel (ver el comentario histórico en index.ts / wire.ts).
const { app, sql } = wireApp((promesa) => {
  void promesa
})

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
})

console.log(`comm-tool escuchando en :${server.port}`)

async function apagar(senal: string) {
  console.log(`${senal}: cerrando...`)
  await server.stop()
  await sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGTERM', () => void apagar('SIGTERM'))
process.on('SIGINT', () => void apagar('SIGINT'))
```

- [ ] **Step 4: Verificación completa + smoke local con Bun**

```bash
bun run typecheck && bun run lint && bun run test
docker run -d --name commtool-pg -e POSTGRES_PASSWORD=test \
  -p 127.0.0.1:5433:5432 postgres:17-alpine
export DATABASE_URL='postgres://postgres:test@127.0.0.1:5433/postgres'
bun run db:migrate
INTERNAL_SECRET=test bun src/server.ts &
sleep 1 && curl -s http://localhost:3000/health
kill %1; docker rm -f commtool-pg; unset DATABASE_URL
```
Expected: `/health` responde 200 con el JSON de salud.

- [ ] **Step 5: Commit**

```bash
git add src/wire.ts src/index.ts src/server.ts
git commit -m "feat: entrypoint self-host (Bun.serve) y cableado compartido en wire.ts"
```

---

### Task 5: Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: `.dockerignore`**

```
node_modules
dist
docs
.git
.env*
*.md
```

- [ ] **Step 2: `Dockerfile`**

```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/server.ts"]
```

- [ ] **Step 3: Build + smoke en Docker (red compartida con un pg)**

```bash
docker build -t comm-tool:local .
docker network create commtool-smoke
docker run -d --network commtool-smoke --name smoke-pg \
  -e POSTGRES_PASSWORD=test postgres:17-alpine
sleep 3
docker run --rm --network commtool-smoke \
  -e DATABASE_URL='postgres://postgres:test@smoke-pg:5432/postgres' \
  comm-tool:local bun run db:migrate
docker run -d --network commtool-smoke --name smoke-app \
  -p 127.0.0.1:3000:3000 \
  -e DATABASE_URL='postgres://postgres:test@smoke-pg:5432/postgres' \
  -e INTERNAL_SECRET=test comm-tool:local
sleep 1 && curl -s http://127.0.0.1:3000/health
docker rm -f smoke-app smoke-pg && docker network rm commtool-smoke
```
Expected: migraciones OK, `/health` 200.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat: imagen Docker para self-host"
```

---

### Task 6: PR, merge y verificación de que Vercel sigue vivo

El swap de driver TAMBIÉN corre en Vercel (postgres.js habla TCP con Neon; la
URL ya trae `sslmode=require`). Mantener Vercel deployable es el rollback.

- [ ] **Step 1: Push + PR**

```bash
git push -u origin migracion-vps
gh pr create --title "Migración al VPS: driver postgres.js + entrypoint self-host" \
  --body "Ver docs/superpowers/plans/2026-08-06-migracion-vps.md"
```

- [ ] **Step 2: Merge (rebase o merge, NUNCA squash — convención del repo)**

```bash
gh pr merge --rebase
```

- [ ] **Step 3: Verificar el deploy nuevo de Vercel contra producción**

```bash
curl -s https://communication-tool-beta.vercel.app/health
bun run scripts/ver-circuito.ts   # con el .env local apuntando a Neon
```
Expected: 200 y circuito sano. Si el deploy nuevo rompe: en el dashboard de
Vercel, *Promote to Production* del deployment anterior (build inmutable con
el driver viejo) — rollback en un minuto.

---

### Task 7: Stack en el VPS

**Files (en el VPS, repo `vps-stacks`):**
- Create: `/opt/stacks/comm-tool/compose.yaml`
- Create: `/opt/stacks/comm-tool/comm-tool.env` (fuera de git, el .gitignore ya cubre `*.env`)
- Create: `/opt/stacks/comm-tool/db.env` (ídem)

- [ ] **Step 1: Clonar el repo de la app en el VPS**

```bash
ssh vps 'mkdir -p /opt/src && cd /opt/src && gh repo clone juanandresdavila/communication-tool'
```

- [ ] **Step 2: Generar password de la base y armar los env**

```bash
ssh vps 'openssl rand -hex 16'   # → $PASS, va en los dos archivos de abajo
```

`/opt/stacks/comm-tool/db.env`:
```
POSTGRES_DB=commtool
POSTGRES_USER=commtool
POSTGRES_PASSWORD=<PASS>
```

`/opt/stacks/comm-tool/comm-tool.env` — partir del `.env` local del Mac
(tiene los valores reales que Vercel no deja bajar):

```bash
scp ~/Projects/communication-tool/.env vps:/opt/stacks/comm-tool/comm-tool.env
ssh vps 'chmod 600 /opt/stacks/comm-tool/*.env'
```
y en el VPS **editar `DATABASE_URL`** a:
```
DATABASE_URL=postgres://commtool:<PASS>@db:5432/commtool
```
Se conservan `INTERNAL_SECRET` (el mismo — así el ticker viejo y el nuevo
comparten Bearer durante la transición), `TELEGRAM_TOKEN_GYM`,
`TELEGRAM_WEBHOOK_SECRET_GYM`, `DELIVERY_SECRET_GYM`, `GYM_API_KEY`.
**Anotar el `DATABASE_URL` de Neon aparte** (hace falta para los dumps):
guardarlo en `/opt/stacks/comm-tool/neon.url` (chmod 600, fuera de git).

Verificar contra la base que no falte ningún nombre de secreto:
```bash
docker run --rm postgres:17-alpine psql "$(cat /opt/stacks/comm-tool/neon.url)" \
  -c "SELECT slug, token_env, webhook_secret_env FROM bots; SELECT slug, delivery_secret_env FROM apps;"
```
Cada `*_env` listado tiene que existir como variable en `comm-tool.env`.

- [ ] **Step 3: `compose.yaml`**

```yaml
services:
  app:
    build: /opt/src/communication-tool
    container_name: comm-tool
    restart: unless-stopped
    env_file:
      - ./comm-tool.env
    depends_on:
      db:
        condition: service_healthy
    networks: [default, edge]
    ports:
      - "127.0.0.1:8787:3000"   # solo loopback: para el timer del tick y debugging

  db:
    image: postgres:17-alpine
    container_name: comm-tool-db
    restart: unless-stopped
    env_file:
      - ./db.env
    volumes:
      - comm_tool_pg:/var/lib/postgresql/data
    networks: [default]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U commtool -d commtool"]
      interval: 5s
      timeout: 3s
      retries: 10

networks:
  default: {}
  edge:
    external: true
    name: edge

volumes:
  comm_tool_pg: {}
```

Reglas de la casa que este archivo respeta: `restart: unless-stopped` en todo
(auto-reboot de las 02:00 ART), ningún puerto en `0.0.0.0`, secretos por
`env_file` y nunca `${VAR}`.

- [ ] **Step 4: Levantar solo la base**

```bash
ssh vps 'cd /opt/stacks/comm-tool && docker compose up -d db && docker compose ps'
```

- [ ] **Step 5: Restore de ensayo desde Neon**

```bash
ssh vps 'docker run --rm --network comm-tool_default postgres:17-alpine \
  pg_dump "$(cat /opt/stacks/comm-tool/neon.url)" --no-owner --no-privileges \
  | docker exec -i comm-tool-db psql -U commtool -d commtool -v ON_ERROR_STOP=1'
ssh vps 'docker exec comm-tool-db psql -U commtool -d commtool -c \
  "SELECT (SELECT count(*) FROM apps) apps, (SELECT count(*) FROM bots) bots, \
          (SELECT count(*) FROM contacts) contacts, \
          (SELECT count(*) FROM inbound_messages) inbound, \
          (SELECT count(*) FROM outbound_messages) outbound, \
          (SELECT count(*) FROM schedules) schedules, \
          (SELECT count(*) FROM schema_migrations) migraciones"'
```
Expected: los counts coinciden con Neon (correr el mismo SELECT contra Neon
para comparar). Este restore es de ENSAYO: el definitivo se repite en el
cutover (Task 11).

- [ ] **Step 6: Build + arranque de la app y verificación interna**

```bash
ssh vps 'cd /opt/stacks/comm-tool && docker compose build app && docker compose up -d app'
ssh vps 'curl -s http://127.0.0.1:8787/health && docker logs comm-tool --tail 20'
```
Expected: `/health` 200.

- [ ] **Step 7: Chequeo de puertos de la casa + commit del stack**

```bash
ssh vps 'sudo ss -tulpn | grep -v "127.0.0.1\|100.125.100.115\|::1"'
# no tiene que aparecer nada nuevo
ssh vps 'cd /opt/stacks && git add comm-tool/compose.yaml && git commit -m "stack comm-tool: app + postgres"'
```

---

### Task 8: Caddy — `comm.jadd.com.ar`

**Files (VPS):**
- Modify: `/opt/stacks/edge/Caddyfile`

- [ ] **Step 1: Agregar el sitio**

```caddyfile
http://comm.jadd.com.ar {
	reverse_proxy comm-tool:3000
	log {
		output file /data/access-comm.log {
			roll_size 10mb
			roll_keep 3
		}
	}
}
```

- [ ] **Step 2: Reload + verificación en dos anillos**

```bash
ssh vps 'docker exec caddy caddy reload --config /etc/caddy/Caddyfile'
# Anillo 1: adentro de la red edge, sin salir a internet
ssh vps 'docker run --rm --network edge curlimages/curl -s http://caddy:80/health -H "Host: comm.jadd.com.ar"'
# Anillo 2: el camino público completo (Cloudflare → túnel → Caddy → app)
curl -s https://comm.jadd.com.ar/health
```
Expected: 200 en los dos. El comodín `*.jadd.com.ar` ya está ruteado al túnel;
no se toca nada en Cloudflare.

- [ ] **Step 3: Commit en vps-stacks**

```bash
ssh vps 'cd /opt/stacks && git add edge/Caddyfile && git commit -m "edge: comm.jadd.com.ar -> comm-tool"'
```

---

### Task 9: Ticker por systemd timer

**Files (VPS):**
- Create: `/etc/systemd/system/comm-tick.service`
- Create: `/etc/systemd/system/comm-tick.timer`

- [ ] **Step 1: Unit del servicio**

```ini
[Unit]
Description=Tick de communication-tool (reintentos y programados)
After=docker.service

[Service]
Type=oneshot
EnvironmentFile=/opt/stacks/comm-tool/comm-tool.env
ExecStart=/usr/bin/curl -fsS -m 60 -X POST \
  -H "Authorization: Bearer ${INTERNAL_SECRET}" \
  http://127.0.0.1:8787/internal/tick
```

- [ ] **Step 2: Unit del timer**

```ini
[Unit]
Description=comm-tool tick cada 15 minutos

[Timer]
OnCalendar=*:00/15
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Activar y verificar un disparo**

```bash
ssh vps 'sudo systemctl daemon-reload && sudo systemctl enable --now comm-tick.timer'
ssh vps 'sudo systemctl start comm-tick.service && journalctl -u comm-tick -n 5 --no-pager'
ssh vps 'systemctl list-timers comm-tick.timer --no-pager'
```
Expected: el disparo manual devuelve el JSON del tick (deliveries/schedules
procesados) y el timer queda agendado al próximo cuarto de hora.

---

### Task 10: Verificación sintética (método de la fase 4)

Verificar el endpoint del VPS **antes** de mover el webhook: si algo falla,
Telegram sigue apuntando a Vercel y no se pierde nada.

- [ ] **Step 1: Update sintético contra el VPS**

Armar un update de Telegram con la forma real (chat y usuario del contacto ya
vinculado, texto inocuo tipo `/ayuda`) y postearlo al endpoint nuevo con el
secret del webhook:

```bash
source ~/Projects/communication-tool/.env
curl -s -X POST https://comm.jadd.com.ar/webhooks/telegram/gym \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET_GYM" \
  -d '{"update_id":999999901,"message":{"message_id":999901,"date":1754500000,"chat":{"id":<CHAT_ID_REAL>,"type":"private"},"from":{"id":<CHAT_ID_REAL>,"is_bot":false,"first_name":"Juan"},"text":"/ayuda"}}'
```
(El `<CHAT_ID_REAL>` sale de `SELECT external_id FROM contacts` en la base del
VPS.)

- [ ] **Step 2: Verificar el circuito completo**

```bash
ssh vps 'docker exec comm-tool-db psql -U commtool -d commtool -c \
  "SELECT provider_update_id, status, attempt_count FROM inbound_messages ORDER BY received_at DESC LIMIT 3"'
ssh vps 'docker logs comm-tool --tail 30'
```
Expected: el update quedó persistido y **entregado** a gym-tracker (delivery
firmada contra su URL de Vercel, que no cambió), y la respuesta de /ayuda
llegó al chat de Telegram. Nota: la respuesta saliente de gym-tracker todavía
viaja por el comm-tool viejo (su `COMM_TOOL_URL` aún apunta a Vercel) — eso es
esperado en esta etapa.

---

### Task 11: Cutover

Hacerlo en un momento tranquilo (sin series registrándose). Ventana de
inconsistencia aceptada: un mensaje que entre entre el dump final y el
`setWebhook` se procesa por el stack viejo y su fila queda solo en Neon —
funcionalmente no se pierde nada.

- [ ] **Step 1: Sync final de datos**

```bash
ssh vps 'cd /opt/stacks/comm-tool && docker compose stop app'
ssh vps 'docker exec comm-tool-db psql -U commtool -d commtool -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
ssh vps 'docker run --rm --network comm-tool_default postgres:17-alpine \
  pg_dump "$(cat /opt/stacks/comm-tool/neon.url)" --no-owner --no-privileges \
  | docker exec -i comm-tool-db psql -U commtool -d commtool -v ON_ERROR_STOP=1'
ssh vps 'cd /opt/stacks/comm-tool && docker compose up -d app && sleep 2 && curl -s http://127.0.0.1:8787/health'
```

- [ ] **Step 2: Apuntar los consumidores al VPS**

En Vercel (dashboard o CLI), para gym-tracker — y para cualquier otra app que
haya listado el `SELECT ... FROM apps` de la Task 7:

```
COMM_TOOL_URL=https://comm.jadd.com.ar
```
y redeploy de cada una. `COMM_TOOL_API_KEY` y `COMM_TOOL_DELIVERY_SECRET` no
cambian.

- [ ] **Step 3: Mover el webhook de Telegram**

```bash
source ~/Projects/communication-tool/.env
TOKEN=$TELEGRAM_TOKEN_GYM
curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=https://comm.jadd.com.ar/webhooks/telegram/gym" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET_GYM"
bun run scripts/ver-webhook.ts   # actualizar antes su const ESPERADO
```

- [ ] **Step 4: Apagar el ticker viejo**

En cron-job.org: pausar (no borrar) el job que pega a Vercel. Con esto el
scheduler viejo deja de disparar y no hay callbacks dobles del check-in de
las 22:00.

- [ ] **Step 5: Prueba real de punta a punta**

Mandar al bot: `/hoy`, después una serie real, después `/deshacer`.
```bash
ssh vps 'docker logs comm-tool --tail 40'
ssh vps 'docker exec comm-tool-db psql -U commtool -d commtool -c \
  "SELECT status, count(*) FROM inbound_messages GROUP BY status; \
   SELECT status, count(*) FROM outbound_messages GROUP BY status"'
```
Expected: respuestas del bot en el chat; entrantes en `delivered`, salientes
en `sent`, nada clavado en `sending`.

**Rollback (si algo falla):** el stack viejo quedó intacto —
```bash
curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=https://communication-tool-beta.vercel.app/webhooks/telegram/gym" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET_GYM"
```
+ revertir `COMM_TOOL_URL` en las apps + reactivar el job de cron-job.org.
Neon siguió recibiendo hasta el paso 3; a lo sumo se re-sincroniza después.

---

### Task 12: Cierre y documentación

- [ ] **Step 1: Período de observación**

Dejar Vercel + Neon intactos (son el rollback) durante ~1 semana. Revisar cada
tanto: `journalctl -u comm-tick`, `docker logs comm-tool`, y que el check-in
de las 22:00 llegue.

- [ ] **Step 2: Actualizar la documentación**

- `CLAUDE.md` de comm-tool: URLs nuevas, ticker por systemd (ya no
  cron-job.org), sección de deploy self-host, y el estado.
- `scripts/ver-webhook.ts`: `ESPERADO` ya actualizado en Task 11.
- `.env.example` de comm-tool y de gym-tracker: `COMM_TOOL_URL` nuevo.
- `~/Documents/1. Proyectos/`: CLAUDE.md (tema 4.3) y el plan de migración —
  fase 1 completa.
- Doc del VPS: sumar el stack comm-tool al inventario.

- [ ] **Step 3: Decomisado (recién después de la observación, con OK explícito)**

Pausar el proyecto en Vercel y borrar la base de Neon **solo** tras confirmar
con Juan. Antes de borrar Neon, guardar un dump final como recuerdo:
`pg_dump ... > ~/backups/commtool-neon-final.sql` en el Mac mini.

---

## Riesgos conocidos

| Riesgo | Mitigación |
|---|---|
| postgres.js parsea tipos distinto que el driver HTTP de Neon | Timestamps forzados a string (Task 1); la suite de integración corre contra Postgres real (Task 3) |
| El deploy del driver nuevo rompe Vercel antes del cutover | Verificación inmediata post-merge + *Promote previous deployment* (Task 6) |
| Mensajes en la ventana del cutover | Se procesan por el stack viejo, que sigue vivo; solo queda la fila histórica en Neon |
| Callbacks dobles del scheduler durante la transición | El `deliveryId` determinista (`<scheduleId>:<horario>`) los deduplica; el ticker viejo se pausa en el cutover |
| Sin backups del Postgres nuevo | Decisión explícita del 6/8/2026 (etapa temprana); primera tarea a retomar cuando duela |
