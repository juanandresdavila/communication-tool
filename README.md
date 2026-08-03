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

## API

| Método | Ruta | Auth |
|---|---|---|
| `POST` | `/v1/messages` | Bearer con la API key de la app |
| `POST` | `/v1/schedules` | Bearer con la API key de la app |
| `DELETE` | `/v1/schedules/:name?userId=…` | Bearer con la API key de la app |
| `POST` | `/v1/link-codes` | Bearer con la API key de la app |
| `GET` / `DELETE` | `/v1/contacts/:userId` | Bearer con la API key de la app |
| `POST` | `/webhooks/telegram/:botSlug` | `X-Telegram-Bot-Api-Secret-Token` |
| `POST` | `/internal/tick`, `/internal/replay/:messageId` | Bearer con `INTERNAL_SECRET` |
| `GET` | `/health` | — |

`POST /v1/messages` acepta
`{ userId, text, kind, replyToMessageId?, template?, idempotencyKey? }` y
devuelve `{ messageId, providerMessageId, status }`.

| Código | Cuándo |
|---|---|
| `400 invalid_request` | El cuerpo no valida, o el texto pasa los 4096 caracteres |
| `404 not_linked` | Ese `userId` no tiene contacto vinculado |
| `409 in_progress` | Esa `idempotencyKey` tiene un envío sin cerrar |
| `500 no_bot` | La app no tiene bot activo en el canal — configuración faltante |
| `502 send_failed` | El proveedor rechazó el envío |

Repetir la llamada con la misma `idempotencyKey` devuelve la misma respuesta
sin mandar un segundo mensaje. Sin clave no hay deduplicación.

`POST /v1/schedules` acepta `{ userId, name, cron, timezone }` y devuelve
`{ scheduleId, name, nextRunAt }`. Es alta o actualización por
`(app, userId, name)`. Un cron o una zona inválidos dan `400 invalid_cron` o
`400 invalid_timezone` **antes** de guardar: un programado que nunca dispara no
se descubre hasta que falta el aviso.

Al vencer, comm-tool **no compone el mensaje**. Postea al
`schedule_callback_url` de la app, firmado con el mismo HMAC de la entrega:

```
POST <apps.schedule_callback_url>
X-Comm-Signature:   t=<unix>,v1=<hmac-sha256(t + "." + body)>
X-Comm-Delivery-Id: <scheduleId>:<horarioAgendado>

{ scheduleId, name, userId, firedAt }
```

La app arma el texto y llama a `/v1/messages`. El `X-Comm-Delivery-Id` es
estable entre reintentos del mismo disparo, así que deduplicando por él el
aviso no sale dos veces.

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor local con recarga en caliente |
| `bun run test` | Vitest |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:migrate` | Aplica las migraciones pendientes |

## Estado

Fases 0 a 3 completas: scaffold, identidad y vinculación, entrega firmada con
reintentos, y salientes.

**El webhook del bot no apunta a este servicio hoy**, así que el camino de
entrada está inerte en producción. Ver [`CLAUDE.md`](CLAUDE.md) para el estado
detallado, los gotchas del tooling y las fases siguientes.
