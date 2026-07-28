# CLAUDE.md

Guía para Claude Code en este repositorio.

## Qué es esto

API intermediaria que centraliza la comunicación por bots de Telegram (y en
el futuro WhatsApp) para las apps del ecosistema: GymTracker, Study Master y
las que vengan. Es un servicio de **transporte e identidad de canal**.

## Estado del proyecto

Fase 0 — Scaffold **completa**. Hono sobre Bun, runner de migraciones, CI en
GitHub Actions y `GET /health`. Sin tablas de dominio todavía: `migrations/`
está vacío a propósito.

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
  minutos de inactividad y cobra por hora de cómputo. Hay un test que lo
  blinda (`expect(db.pings).toBe(0)`): si lo rompés, se rompe el test.
- **Sin RLS y sin Supabase**: no hay cliente browser.

## Gotchas del tooling

- **Los imports relativos llevan `.js`, siempre**: `import { x } from './foo.js'`
  aunque el archivo sea `foo.ts`. Bun y Vitest resuelven sin extensión, pero
  Vercel transpila a `.js` y los corre con el resolver ESM de Node, que la
  **exige**: sin ella el deploy tira `ERR_MODULE_NOT_FOUND` en runtime con
  todos los tests en verde. Por eso el tsconfig usa `"module": "nodenext"`, que
  convierte ese error de producción en un error de `bun run typecheck`. No
  cambiar a `bundler` ni a `Preserve`: la resolución laxa es justamente lo que
  esconde el bug.
- **El preset de Hono de Vercel elige el entrypoint por convención, y es
  frágil.** Dos reglas que hay que respetar o el deploy rompe en runtime
  mientras todo pasa localmente:
  1. **No puede existir `src/app.ts`.** El preset lo prefiere sobre
     `src/index.ts` y lo ejecuta como handler, aunque no tenga default export.
     Por eso la factory vive en `src/create-app.ts`.
  2. **`src/index.ts` tiene que importar `hono`.** El preset rechaza cualquier
     entrypoint que no lo haga (`No entrypoint found which imports hono`). De
     ahí el `import type { Hono }` y la anotación `const app: Hono`: no es
     decorativo, sin eso no buildea.

  Para verificarlo sin deployar: `bun --bun x vercel build --yes` y mirar que
  `.vercel/output/functions/index.func/.vc-config.json` diga
  `"handler": "src/index.js"`.
- **El CLI de Vercel necesita `bun --bun x vercel`**, no `vercel` a secas: el
  shebang del binario pide `node`, que no está instalado.
- **TypeScript fijado en `^6`.** `bun add -d typescript` trae la 7, que es el
  port nativo a Go, y `typescript-eslint` todavía no soporta su API: el lint
  falla entero. No subir a 7 hasta que typescript-eslint lo anuncie.
- **Zod 4 se importa como namespace**: `import * as z from 'zod'`. Con
  `import { z } from 'zod'`, `z` queda `undefined` bajo Vitest según qué entry
  point del paquete se resuelva.
- **ESLint 10 trae `preserve-caught-error`**: al re-lanzar dentro de un
  `catch`, hay que pasar `{ cause: error }`.
- **No usar `import.meta.dir`** en módulos que importen los tests: existe en
  Bun pero no cuando Vitest los carga. Usar
  `dirname(fileURLToPath(import.meta.url))`.
- **No usar `Bun.sql` ni `bun test`**, aunque la plantilla de `bun init` los
  sugiera. `Bun.sql` es exclusivo de Bun y rompería el deploy en el runtime
  Node de Vercel; Vitest es lo que usa el resto del ecosistema.

## Dos drivers de Neon, a propósito

- `neon()` (HTTP) para el runtime: baja latencia, una query por request.
- `Client` (WebSocket) solo en `src/db/migrate.ts`: el HTTP no soporta SQL
  multi-statement ni transacciones reales.

## Build, test, run

```bash
bun run dev         # servidor local en :3000 (PORT lo cambia)
bun run test        # Vitest
bun run lint        # ESLint
bun run typecheck   # tsc --noEmit
bun run db:migrate  # aplica migraciones pendientes
```

CI corre lint + typecheck + test en cada PR y push a main. El test de
integración de migraciones se saltea solo si no hay `DATABASE_URL`.

Al verificar a mano, **no encadenar con pipes**: `bun run lint | tail` devuelve
el exit code de `tail` y tapa el fallo. Usar `set -e` y comandos sueltos.

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
