# communication-tool

API intermediaria que centraliza la comunicación por bots de Telegram y
WhatsApp para las apps del ecosistema. Unifica el registro y la vinculación de
usuarios, el ruteo de mensajes entrantes, el envío de salientes y la
programación de avisos recurrentes.

Diseño completo:
[`docs/superpowers/specs/2026-07-28-communication-tool-design.md`](docs/superpowers/specs/2026-07-28-communication-tool-design.md)

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
curl 'localhost:3000/health?deep=1'   # además verifica la base
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

Fase 0 (scaffold) completa. Ver [`CLAUDE.md`](CLAUDE.md) para el estado
detallado, los gotchas del tooling y las fases siguientes.
