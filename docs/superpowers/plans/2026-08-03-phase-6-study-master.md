# communication-tool — Fase 6: Study Master

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una segunda app se enchufe a comm-tool con una API key y una URL, y que hacerlo **no requiera tocar el código del servicio**.

**Architecture:** Study Master adopta la interfaz `Messaging` desde el día uno —se ahorra la migración que sí tuvo GymTracker— y usa el paquete cliente contra la API HTTP. Del lado de comm-tool no se agrega ninguna capacidad: se da de alta una fila en `apps`, una en `bots`, y tres variables de entorno. Los recordatorios de entregas son un programado más sobre el scheduler de la fase 5.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## La fase es la prueba del diseño, no una funcionalidad nueva

Todo lo que hace falta ya existe: identidad, entrega, salientes, paquete y
scheduler. Si sumar Study Master obliga a escribir lógica nueva en comm-tool,
el servicio no era multi-app y hay que enterarse ahora.

**La única excepción legítima es el script de alta.** `scripts/registrar-app.ts`
tiene `gym-tracker` hardcodeado —slug, nombre, `delivery_url`, y el bot `gym`
con sus variables— así que hoy no puede dar de alta una segunda app. Eso no es
una capacidad faltante del servicio: es una herramienta que se escribió para un
caso y ahora tiene dos.

## Dependencia externa, bloqueante

**Un segundo bot de Telegram, creado con @BotFather.** El spec lo lista en
§Dependencias externas como algo que resuelve el usuario. Sin él se puede
construir y probar todo, pero no verificar el circuito.

De ahí salen tres secretos nuevos, que van a Vercel y **nunca al repo**:

| Variable | De dónde sale |
|---|---|
| `TELEGRAM_TOKEN_STUDY` | BotFather, al crear el bot |
| `TELEGRAM_WEBHOOK_SECRET_STUDY` | `openssl rand -hex 32` |
| `DELIVERY_SECRET_STUDY` | `openssl rand -hex 32`, espejado en Study Master |

## Qué entra y qué no

**Entra:** el script de alta generalizado, el alta de `study-master` y su bot, el
lado de mensajería de Study Master (adapter, endpoint de entrega, endpoint de
programados), y el recordatorio de entregas.

**No entra:** un bot inteligente para Study Master. GymTracker parsea series con
un LLM; acá el entrante solo tiene que registrarse. Qué hace Study Master con lo
que le escriban es decisión suya y de otra fase.

**Un detalle de su dominio:** Study Master **no guarda zona horaria por
usuario** — el grep no encontró ninguna columna. El recordatorio se registra
con una zona fija (`America/Argentina/Buenos_Aires`) y queda anotado que el día
que haya usuarios en otra zona hay que sumarla. comm-tool ya la soporta por
programado; el que no la tiene es Study Master.

---

## Task 1: Generalizar el script de alta

**Files:**
- Modify: `scripts/registrar-app.ts`

- [ ] **Step 1: Reescribirlo para que tome parámetros**

`scripts/registrar-app.ts`:

```ts
import { Client } from '@neondatabase/serverless'
import { hashApiKey } from '../src/identity/api-key.js'

/**
 * Da de alta una app y su bot, o los actualiza si ya existen.
 *
 *   bun run scripts/registrar-app.ts \
 *     --slug study-master --name "Study Master" \
 *     --api-key "$KEY" \
 *     --delivery-url https://study.example/api/messaging/inbound \
 *     --schedule-url https://study.example/api/messaging/schedule \
 *     --bot-slug study --bot-username studymasterjaddbot \
 *     --token-env TELEGRAM_TOKEN_STUDY \
 *     --webhook-secret-env TELEGRAM_WEBHOOK_SECRET_STUDY \
 *     --delivery-secret-env DELIVERY_SECRET_STUDY
 *
 * Guarda el NOMBRE de cada variable de entorno, nunca su valor: es la
 * invariante del spec y lo que hace que mudar de host sea copiar un .env.
 */
function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function exigido(nombre: string): string {
  const v = arg(nombre)
  if (!v) {
    console.error(`Falta --${nombre}`)
    process.exit(1)
  }
  return v
}

const slug = exigido('slug')
const name = exigido('name')
const apiKey = exigido('api-key')
const deliveryUrl = exigido('delivery-url')
const scheduleUrl = arg('schedule-url') ?? null
const deliverySecretEnv = exigido('delivery-secret-env')
const botSlug = exigido('bot-slug')
const botUsername = arg('bot-username') ?? null
const tokenEnv = exigido('token-env')
const webhookSecretEnv = exigido('webhook-secret-env')
const unlinked =
  arg('unlinked-message') ??
  `Hola. Para usar este bot vinculá tu cuenta: entrá a ${name}, generá un código y mandámelo con /vincular <código>.`

const client = new Client(process.env.DATABASE_URL)
await client.connect()

const { rows } = await client.query<{ id: string }>(
  `INSERT INTO apps (slug, name, api_key_hash, delivery_url,
                     schedule_callback_url, delivery_secret_env)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (slug) DO UPDATE
   SET name = EXCLUDED.name,
       api_key_hash = EXCLUDED.api_key_hash,
       delivery_url = EXCLUDED.delivery_url,
       schedule_callback_url = EXCLUDED.schedule_callback_url,
       delivery_secret_env = EXCLUDED.delivery_secret_env
   RETURNING id`,
  [slug, name, hashApiKey(apiKey), deliveryUrl, scheduleUrl, deliverySecretEnv],
)
const fila = rows[0]
if (!fila) throw new Error('El INSERT de apps no devolvió el id')

await client.query(
  `INSERT INTO bots (app_id, channel, slug, username, token_env,
                     webhook_secret_env, unlinked_message)
   VALUES ($1, 'telegram', $2, $3, $4, $5, $6)
   ON CONFLICT (slug) DO UPDATE
   SET username = EXCLUDED.username,
       token_env = EXCLUDED.token_env,
       webhook_secret_env = EXCLUDED.webhook_secret_env,
       unlinked_message = EXCLUDED.unlinked_message`,
  [fila.id, botSlug, botUsername, tokenEnv, webhookSecretEnv, unlinked],
)

console.log(`app ${slug}: ${fila.id}`)
console.log(`bot ${botSlug}: webhook en /webhooks/telegram/${botSlug}`)
await client.end()
```

**El `ON CONFLICT` de `bots` es por `slug`, no por `(app_id, channel)`**, aunque
ese único también exista: `slug` es lo que va en la URL del webhook y lo que
identifica al bot de forma estable entre corridas.

- [ ] **Step 2: Verificar que re-registrar gym-tracker no lo rompe**

El script se usa para rotar la API key, así que tiene que ser idempotente sobre
lo que ya existe.

```bash
bun run scripts/ver-circuito.ts
```

Anotá el `schedule_callback_url` de `gym-tracker`; el paso siguiente tiene que
dejarlo igual.

```bash
KEY="$(grep '^GYM_API_KEY=' .env | cut -d= -f2-)" && bun run scripts/registrar-app.ts \
  --slug gym-tracker --name GymTracker --api-key "$KEY" \
  --delivery-url https://gym-tracker-brown-one.vercel.app/api/messaging/inbound \
  --schedule-url https://gym-tracker-brown-one.vercel.app/api/messaging/schedule \
  --delivery-secret-env DELIVERY_SECRET_GYM \
  --bot-slug gym --bot-username gymtrackerjaddbot \
  --token-env TELEGRAM_TOKEN_GYM \
  --webhook-secret-env TELEGRAM_WEBHOOK_SECRET_GYM
```

```bash
bun run scripts/ver-circuito.ts
```

Esperado: el programado sigue con `callback: ok` y el check-in intacto. Si el
`schedule_callback_url` volvió a `NULL`, el `ON CONFLICT` está mal.

- [ ] **Step 3: Commit**

```bash
git add scripts/ && git commit -m "refactor: el script de alta sirve para cualquier app"
```

---

## Task 2: El bot de Study Master

**Requiere al usuario.** Sin el bot no hay nada que registrar.

- [ ] **Step 1: Crear el bot en @BotFather**

`/newbot`, nombre y username. Anotá el token — es lo único que BotFather no te
vuelve a mostrar sin revocar.

- [ ] **Step 2: Cargar los tres secretos en Vercel**

```bash
cd ~/Projects/communication-tool
printf '%s' "<EL_TOKEN_DE_BOTFATHER>" | bun --bun x vercel env add TELEGRAM_TOKEN_STUDY production
printf '%s' "$(openssl rand -hex 32)" | bun --bun x vercel env add TELEGRAM_WEBHOOK_SECRET_STUDY production
```

El de entrega se genera una vez y va a los **dos** proyectos, igual que en la
fase 4C: si difieren, la firma no valida y la entrega muere con 401.

```bash
SECRETO="$(openssl rand -hex 32)"
printf '%s' "$SECRETO" | (cd ~/Projects/communication-tool && bun --bun x vercel env add DELIVERY_SECRET_STUDY production)
printf '%s' "$SECRETO" | (cd ~/Projects/study-master && bun --bun x vercel env add COMM_TOOL_DELIVERY_SECRET production)
unset SECRETO
```

- [ ] **Step 3: Redeployar comm-tool**

Las variables solo aplican a deploys nuevos. Sin esto el webhook del bot nuevo
devuelve 500 al primer update.

```bash
cd ~/Projects/communication-tool && bun --bun x vercel redeploy "$(bun --bun x vercel ls --prod 2>&1 | grep -oE 'https://communication-tool-[a-z0-9-]+\.vercel\.app' | head -1)"
```

- [ ] **Step 4: Dar de alta la app y el bot**

```bash
KEY="$(openssl rand -hex 24)" && echo "STUDY_API_KEY=$KEY" >> .env && bun run scripts/registrar-app.ts \
  --slug study-master --name "Study Master" --api-key "$KEY" \
  --delivery-url https://<DOMINIO_DE_STUDY>/api/messaging/inbound \
  --schedule-url https://<DOMINIO_DE_STUDY>/api/messaging/schedule \
  --delivery-secret-env DELIVERY_SECRET_STUDY \
  --bot-slug study --bot-username <USERNAME_DEL_BOT> \
  --token-env TELEGRAM_TOKEN_STUDY \
  --webhook-secret-env TELEGRAM_WEBHOOK_SECRET_STUDY
```

- [ ] **Step 5: Registrar el webhook**

```bash
T="<EL_TOKEN>" && S="<EL_WEBHOOK_SECRET>" && curl -s -X POST "https://api.telegram.org/bot$T/setWebhook" -H 'Content-Type: application/json' -d "{\"url\":\"https://communication-tool-beta.vercel.app/webhooks/telegram/study\",\"secret_token\":\"$S\",\"allowed_updates\":[\"message\"]}" && unset T S
```

**Este `setWebhook` es seguro**, a diferencia del de la fase 4C: es un bot
nuevo que nadie estaba usando, así que no le saca el webhook a nadie.

---

## Task 3: La mensajería de Study Master

**Files (en `study-master`):**
- Create: `src/lib/messaging/types.ts`, `src/lib/messaging/comm-tool.ts`
- Create: `src/app/api/messaging/inbound/route.ts`
- Test: `src/lib/__tests__/conformidad.test.ts`

- [ ] **Step 1: Instalar el paquete**

```bash
cd ~/Projects/study-master && bun add "github:juanandresdavila/communication-tool#v0.2.0"
```

- [ ] **Step 2: Copiar el contrato**

`src/lib/messaging/types.ts` es **idéntico** al de GymTracker y al de
`src/client/types.ts` de comm-tool. Que las tres copias no se separen es lo que
verifica la suite de conformidad.

- [ ] **Step 3: El adapter**

`src/lib/messaging/comm-tool.ts`, igual que el de GymTracker: lee
`COMM_TOOL_URL`, `COMM_TOOL_API_KEY` y `COMM_TOOL_DELIVERY_SECRET`, y tira al
construirse si falta alguna.

- [ ] **Step 4: Enganchar la suite de conformidad**

```ts
import { CASOS_DE_CONFORMIDAD } from 'communication-tool/conformance'
```

Study Master tiene **una sola** implementación, así que la suite verifica menos
que en GymTracker —no hay dos que comparar— pero sigue sirviendo: fija que su
adapter cumple el mismo contrato que el resto del ecosistema.

- [ ] **Step 5: El endpoint de entrega**

`/api/messaging/inbound`: verifica la firma, registra el entrante y contesta.
**Sin parser**: qué hace Study Master con lo que le escriban es de otra fase.

---

## Task 4: El recordatorio de entregas

**Files (en `study-master`):**
- Create: `src/lib/recordatorios.ts`, `src/app/api/messaging/schedule/route.ts`

- [ ] **Step 1: El texto, puro**

`src/lib/recordatorios.ts`:

```ts
export type EntregaProxima = {
  title: string
  dueAt: string
  projectName: string
}

/**
 * El texto del recordatorio. Puro: el copy se prueba sin base ni red.
 */
export function mensajeDeEntregas(
  entregas: EntregaProxima[],
  ahora: Date,
): string | null {
  // Sin entregas no se manda nada. Un "no tenés entregas" diario entrena al
  // usuario a ignorar al bot, y entonces tampoco lee el que sí importa.
  if (entregas.length === 0) return null

  const lineas = entregas.map((e) => {
    const dias = Math.ceil(
      (new Date(e.dueAt).getTime() - ahora.getTime()) / 86_400_000,
    )
    const cuando =
      dias <= 0 ? 'HOY' : dias === 1 ? 'mañana' : `en ${dias} días`
    return `• ${e.title} (${e.projectName}) — ${cuando}`
  })

  return [`Entregas que se vienen:`, ...lineas].join('\n')
}
```

- [ ] **Step 2: El endpoint de programados**

Mismo molde que el de GymTracker: valida el HMAC, mira el `name`, consulta
`deliverables` con `status = 'pendiente'` y `due_at` dentro de los próximos 7
días, y manda —pasando el `X-Comm-Delivery-Id` como `idempotencyKey`—.

**Si `mensajeDeEntregas` devuelve `null`, se contesta 200 sin mandar nada.** No
es un error: es que no había nada que avisar.

- [ ] **Step 3: Registrar el programado**

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/v1/schedules \
  -H "Authorization: Bearer $(grep '^STUDY_API_KEY=' ~/Projects/communication-tool/.env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"<USER_ID_DE_STUDY>","name":"entregas","cron":"0 9 * * *","timezone":"America/Argentina/Buenos_Aires"}'
```

Las 9 de la mañana: un recordatorio de entregas sirve al empezar el día, no a
las 22:00 como el check-in del gimnasio.

---

## Verificación de la fase

- [ ] `bun run lint && bun run typecheck && bun run test` en verde en los dos repos.
- [ ] **comm-tool no ganó ni una línea de lógica nueva.** Solo el script de alta.
- [ ] Re-registrar `gym-tracker` con el script nuevo **no** le pisa el `schedule_callback_url`.
- [ ] `/vincular` funciona en el bot de Study Master.
- [ ] Un mensaje al bot de Study Master llega a su `/api/messaging/inbound`.
- [ ] El recordatorio dispara y llega al Telegram.
- [ ] **El bot de GymTracker sigue funcionando igual.** Es lo que prueba que
      dos apps conviven: mismo servicio, mismo ticker, misma base.

El que cierra la fase es el último: si sumar una app rompiera la otra, comm-tool
no sería un servicio multi-app sino uno con un cliente y un invitado.
