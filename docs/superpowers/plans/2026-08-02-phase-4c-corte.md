# communication-tool — Fase 4C: El corte

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los entrantes del bot de GymTracker pasen por comm-tool, sin que el usuario pierda la capacidad de registrar series en ningún momento.

**Architecture:** El corte es una sola llamada a `setWebhook`, y todo lo demás son preparativos para que esa llamada sea segura y reversible. Se verifica el camino de entrega **antes** de moverlo, firmando una entrega a mano contra el endpoint de producción de GymTracker: si la firma no valida, se entera ahora y no con el bot ya roto.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

> **Nota posterior a la ejecución.** Los pasos de abajo nombran scripts
> (`scripts/probar-entrega.ts`, `scripts/mover-webhook.ts`, …) que en su
> momento se corrieron como scripts sueltos y no quedaron en el repo. De ese
> conjunto sobrevivieron los dos que sirven más de una vez:
> **`scripts/ver-webhook.ts`** y **`scripts/ver-circuito.ts`**. El resto eran
> de una sola vez; los comandos equivalentes están en CLAUDE.md, §El corte.

## El rollback, escrito antes de tocar nada

Estado capturado el 2026-08-02 antes de empezar:

| | |
|---|---|
| `url` | `https://gym-tracker-brown-one.vercel.app/api/telegram` |
| `pending_update_count` | 0 |
| `allowed_updates` | `["message"]` |
| `max_connections` | 40 |

**Para volver atrás**, con el token en `TELEGRAM_BOT_TOKEN` y el secreto en
`TELEGRAM_WEBHOOK_SECRET`, los dos del `.env.local` de `gym-tracker`:

```bash
cd ~/Projects/gym-tracker && T="$(grep '^TELEGRAM_BOT_TOKEN=' .env.local | cut -d= -f2- | tr -d '"')" && S="$(grep '^TELEGRAM_WEBHOOK_SECRET=' .env.local | cut -d= -f2- | tr -d '"')" && curl -s -X POST "https://api.telegram.org/bot$T/setWebhook" -H 'Content-Type: application/json' -d "{\"url\":\"https://gym-tracker-brown-one.vercel.app/api/telegram\",\"secret_token\":\"$S\",\"allowed_updates\":[\"message\"]}" && unset T S
```

Vuelve en una sola llamada y sin deploy: `/api/telegram` nunca dejó de existir.
**Ese es el punto de todo el diseño de esta etapa** — los dos caminos conviven,
así que el corte es un cambio de registro y no una migración de código.

## Por qué hay que rotar dos secretos

Ninguno de los dos se puede leer: en Vercel están marcados como sensibles y
`vercel env pull` los devuelve como `[SENSITIVE]`. Y los dos tienen que
coincidir con algo del otro lado:

| Secreto | Tiene que coincidir con |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET_GYM` (comm-tool) | El `secret_token` que se le pasa a `setWebhook` |
| `DELIVERY_SECRET_GYM` (comm-tool) | `COMM_TOOL_DELIVERY_SECRET` (gym-tracker) |

Rotarlos hoy es inofensivo: no hay contactos vinculados en comm-tool, no hay
entregas en curso, y el webhook todavía no le llega. Después del corte deja de
serlo.

## Un bug que hay que arreglar antes

`apps.delivery_url` de `gym-tracker` apunta a
`https://gym-tracker.vercel.app/api/messaging/inbound`. Ese dominio **no es el
deploy de GymTracker** — devuelve 302. El real es
`gym-tracker-brown-one.vercel.app`. Con el dominio mal, cada entrega daría 302,
que no es 2xx: cinco reintentos y `failed`, con toda la pinta de "la app no
recibe".

---

## Task 1: Arreglar el `delivery_url`

- [ ] **Step 1: Apuntarlo al deploy real**

```bash
bun run scripts/apuntar-delivery-url.ts
```

- [ ] **Step 2: Verificar que el destino responde**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://gym-tracker-brown-one.vercel.app/api/messaging/inbound
```

Esperado: `401` — el endpoint existe y rechaza lo que no viene firmado. Un
`404` significa que el deploy de la etapa 4B todavía no salió; un `302`, que el
dominio sigue mal.

---

## Task 2: Rotar los secretos y cablear GymTracker

- [ ] **Step 1: Rotar `DELIVERY_SECRET_GYM` y espejarlo en GymTracker**

Se genera uno solo y se carga en los dos lados, que es todo el punto: si
difieren, la firma no valida y la entrega muere con 401.

```bash
SECRETO="$(openssl rand -hex 32)"
printf '%s' "$SECRETO" | (cd ~/Projects/communication-tool && bun --bun x vercel env rm DELIVERY_SECRET_GYM production --yes >/dev/null 2>&1; bun --bun x vercel env add DELIVERY_SECRET_GYM production)
printf '%s' "$SECRETO" | (cd ~/Projects/gym-tracker && bun --bun x vercel env add COMM_TOOL_DELIVERY_SECRET production)
unset SECRETO
```

- [ ] **Step 2: Cargar el resto de las variables de GymTracker**

```bash
cd ~/Projects/gym-tracker
printf 'https://communication-tool-beta.vercel.app' | bun --bun x vercel env add COMM_TOOL_URL production
grep '^GYM_API_KEY=' ~/Projects/communication-tool/.env | cut -d= -f2- | tr -d '\n' | bun --bun x vercel env add COMM_TOOL_API_KEY production
```

- [ ] **Step 3: Redeployar los dos**

**Las variables de entorno en Vercel solo aplican a deploys nuevos.** Sin esto
el servicio sigue con las viejas y la entrega falla con un 401 que parece un
problema de firma cuando es de despliegue.

```bash
cd ~/Projects/communication-tool && bun --bun x vercel redeploy --yes
```

```bash
cd ~/Projects/gym-tracker && bun --bun x vercel redeploy --yes
```

---

## Task 3: Verificar la entrega ANTES de mover el webhook

Es la tarea que justifica el orden entero de la fase.

- [ ] **Step 1: Crear el contacto en comm-tool**

El `app_user_id` es el **user id real de GymTracker**, no uno inventado:
`message_log.user_id` referencia `auth.users`, así que un id falso haría fallar
el endpoint por clave foránea y parecería un problema de configuración.

```bash
bun run scripts/vincular-a-mano.ts
```

- [ ] **Step 2: Firmar una entrega a mano y mandarla a producción**

```bash
bun run scripts/probar-entrega.ts
```

Esperado: `200 {"ok":true}`.

Cómo leer otros resultados:

| Código | Qué significa |
|---|---|
| `401` | Los secretos no coinciden, o falta el redeploy |
| `500` | La firma validó pero el dominio falló — mirar los logs de GymTracker |
| `302` | El `delivery_url` sigue mal |

- [ ] **Step 3: Confirmar que el mensaje llegó a `message_log`**

```bash
cd ~/Projects/gym-tracker && bun run scripts/ver-message-log.ts
```

Esperado: una fila con `source = 'comm-tool'`.

---

## Task 4: El corte

Recién acá se toca el registro del webhook. **Es el paso irreversible en el
momento**: mientras el webhook apunte a comm-tool, `/api/telegram` no recibe
nada.

- [ ] **Step 1: Rotar el secreto del webhook y moverlo**

```bash
bun run scripts/mover-webhook.ts
```

- [ ] **Step 2: Verificar el registro**

```bash
bun run scripts/ver-webhook.ts
```

Esperado: `url` apuntando a
`https://communication-tool-beta.vercel.app/webhooks/telegram/gym`,
`pending_update_count: 0` y sin error nuevo.

- [ ] **Step 3: La prueba de verdad — mandarle un mensaje al bot**

Desde tu Telegram, mandale a `@gymtrackerjaddbot`:

```
press banca 3x8 70
```

Esperado: el bot contesta como siempre. Si contesta, el circuito completo
—Telegram → comm-tool → entrega firmada → GymTracker → respuesta por
`/v1/messages` → Telegram— funcionó.

- [ ] **Step 4: Confirmarlo en las dos bases**

```bash
bun run scripts/ver-circuito.ts
```

Esperado: una fila en `inbound_messages` con `delivery_status = 'delivered'` y
una en `outbound_messages` con `status = 'sent'`.

**Si algo de esto falla, corré el rollback de arriba.** No hay que deshacer
ningún deploy ni revertir código: los dos caminos siguen construidos.

---

## Verificación de la fase

- [ ] `curl` sin firma a `/api/messaging/inbound` devuelve 401.
- [ ] Una entrega firmada a mano devuelve 200 y deja una fila con
      `source = 'comm-tool'` en `message_log`.
- [ ] `getWebhookInfo` apunta a comm-tool, sin errores nuevos.
- [ ] Un mensaje real al bot se registra y el bot contesta.
- [ ] `inbound_messages` muestra `delivered` y `outbound_messages` muestra `sent`.
- [ ] El rollback está probado o, como mínimo, escrito y listo para pegar.

El que cierra la fase es el mensaje real: es el único que ejercita las dos
direcciones y los cuatro secretos a la vez.
