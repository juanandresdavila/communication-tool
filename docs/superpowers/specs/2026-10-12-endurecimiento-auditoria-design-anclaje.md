# Anclaje: endurecimiento por la auditoría de octubre

**Fecha:** 2026-10-12
**SHA del código:** `c3885f4` (= `origin/main`), rama
`claude/endurecimiento-auditoria`, worktree propio.
**Spec anclado:** `2026-10-12-endurecimiento-auditoria-design.md`, en su primera
versión.
**Quién:** un verificador aparte (subagente de solo lectura), que no escribió el
spec, leyendo cada cita contra el código real.

⚠️ **Desvío de la skill, dicho a propósito.** `anclar-spec` pide no corregir el
spec en la misma pasada, porque lo que se corrige lo decide Juan. Acá el spec es
un borrador que Juan todavía no vio, escrito por la misma sesión que encargó el
anclaje. Por eso se corrigieron **solo los errores de hecho** (líneas corridas,
afirmaciones que no coincidían con el código) y se agregó lo que el spec no
veía. Ninguna decisión se tomó: siguen todas en «Decisiones pendientes de Juan»
del spec, más las que suma este archivo abajo.

## Resultado

**121 afirmaciones: 115 ✅, 0 ❌, 5 ⚠️, 1 🔍.**

Las 115 ✅ incluyen todas las líneas que la auditoría citó para los nueve ítems
del Grupo A: `src/env.ts:16`, `src/secrets.ts:12`,
`src/middleware/internal-auth.ts:16-18`, `src/server.ts:6-8`,
`src/routes/telegram-webhook.ts:65`, `:67-70`, `:93-97`, `:98-100`,
`:122-134`, `:146`, `:180-195`, `:204-206` y `:209`, `src/delivery/deliver.ts`
(`:52`, `:55`, `:63-67`, `:78`, `:82-97`, `:88`, `:92`, `:121`),
`src/routes/internal.ts:8`, `:18-22`, `:27`, `:29-32` y `:43-55`,
`src/schedules/fire.ts:34-39`, `:63` y `:66-70`, `src/schedules/cron.ts:27-36`,
`src/db/repositories/schedules.ts:75-91` y `:109-118`,
`src/db/repositories/inbound-messages.ts:79-95`, `src/delivery/client.ts:25-41`,
`src/channels/telegram/client.ts:112-123` y `:131-140`,
`src/routes/link-codes.ts:18`, `src/routes/messages.ts:19-26`,
`src/outbound/botones.ts:12`, `:28` y `:30`, `src/create-app.ts:61-64`, `:70` y
`:80-84`, `scripts/ver-circuito.ts:31-57`, `scripts/receptor-de-prueba.ts:21` y
`:26`, `migrations/0004_schedules.sql:9-15`, `vitest.config.ts:5-6`,
`Dockerfile:1`, y las de `CLAUDE.md`, `.env.example`, los planes y el spec del
20/09.

## Los que no dieron ✅, y qué se hizo

| # | El spec decía | Real | Estado | En el spec |
|---|---|---|---|---|
| 5 | `src/env.test.ts:7`, `:20` y `:33` fijan `'s'` como válido | Lo fijan `:7-10` y `:33-37`; en `:20` es relleno de un test que espera que falle `DATABASE_URL` | ⚠️ | Corregido |
| 62 | Contrato del puerto en `src/db/ports.ts:265-271` | El bloque de `marcarFallido` es `:263-270`; la `:271` ya es `marcarPerdido` | ⚠️ | Corregido |
| 75 | `data` se copia tal cual en `parse-update.ts:66` | Se lee en `:62` y se devuelve en `:81`; la `:66` es el chequeo de tipo | ⚠️ | Corregido |
| 92 | «El índice único corta antes: un valor enorme da 500» | El `UNIQUE` existe (`0004:15`), pero Postgres comprime las tuplas de índice: un valor enorme y compresible puede entrar | ⚠️ | Corregido |
| 101 | La opción de vista previa viaja en `PedidoSaliente`, también para la edición | La edición usa `PedidoEdicion` (`src/outbound/edit.ts:6-13`) | ⚠️ | Corregido |
| 116 | Grupo B 9: «`provider_bot_id` único» | La columna no existe: la migración la tiene que crear y llenar | 🔍 | Aclarado en la tabla del Grupo B |

## Lo que el spec no veía (ya incorporado)

- `src/wire.ts` y la interfaz `Wired`: el aviso al arrancar necesita repos que
  hoy `wireApp` no devuelve.
- Comentarios que quedan falsos con la punta 4: `telegram-webhook.ts:93-95` y
  `:201-203`, `telegram-webhook.test.ts:196-199` y `src/index.ts:8-10`.
- No hay logger en `Deps`; el servicio usa `console`.
- Puertos, repos y dobles que cambian (`ports.ts`, `apps.ts`, `bots.ts`,
  `schedules.ts`, `fake-repos.ts`, `fake-schedules.ts`).
- Tres archivos de test que no existen: rutas de schedules, integración del repo
  de schedules, integración del webhook contra el repo real.
- Siete dobles de `TelegramClient` que dependen de su firma posicional.
- El borde de la vista previa con una `idempotencyKey` compartida entre `/v1` y
  `/mcp`.
- Lo que rompe la regla de la punta 1 en un secreto de la base: un token de bot
  da 500 en todo el webhook de ese bot (`telegram-webhook.ts:72`) y 502 en
  `/v1/messages`, `/mcp` y la edición (`send.ts:80`, `edit.ts:51`).
- El `grep -cF '[SENSITIVE]'` propuesto daba falso positivo con el comentario de
  `.env.example:16`; se cambió por uno anclado a líneas de asignación, probado
  con un archivo de mentira.
- El test de la punta 4 con el secreto faltante deja de cazar la mutación una
  vez aplicada la punta 5; la mutación se prueba con errores de la base.
- `README.md`: la tabla de códigos no tiene 413 y `/v1/schedules` no dice que se
  rechazan los crons de un solo disparo. Por eso el «Alcance» ya no dice «sin
  cambio de contrato» a secas: nombra las respuestas de error nuevas.
- `CLAUDE.md:398-401`, `.env.example:7-9`, `dist/` (no se toca) y el orden de
  `ver-circuito` con filas terminales.
- `bodyLimit` necesita `onError` propio para contestar JSON, y sin
  `Content-Length` lee hasta el tope en memoria.

## Decisiones abiertas que sumó el anclaje

Sin elegir; la recomendación va primero.

- **Logger de la punta 4.**
  - Recomendada: `console.error` en el sitio y un spy en el test. Es lo que ya
    usa el servicio y no toca `Deps`.
  - Alternativa: inyectarlo en `Deps`. Más limpio para probar, pero toca
    `create-app.ts`, `wire.ts`, `fake-deps.ts` y el armado de los tests.
- **Dónde corre el aviso al arrancar (punta 5, si entra).**
  - Recomendada: en `server.ts`, después de `Bun.serve`, sin bloquear el
    arranque.
  - Alternativa: adentro de `wireApp`. Lo haría correr también en Vercel, que es
    justo lo que se quiere dar de baja.

## PARADA

Anclaje listo: 115 ✅, 0 ❌, 5 ⚠️, 1 🔍, y 2 decisiones abiertas nuevas (más las
del spec). Los 6 que no dieron ✅ ya están corregidos en el borrador. Falta que
Juan revise el spec y decida antes del plan.
