# communication-tool — Fase 4B: El lado de GymTracker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que GymTracker pueda recibir y mandar mensajes a través de comm-tool sin que el dominio se entere, y que la equivalencia entre las dos implementaciones esté **verificada** y no prometida.

**Architecture:** GymTracker instala el paquete cliente como dependencia git y gana un segundo endpoint, `/api/messaging/inbound`, que recibe las entregas firmadas de comm-tool y las mete por el **mismo** `handleMessage` que ya usa el webhook de Telegram. Cuál de los dos adapters se usa lo decide una variable de entorno. Los dos endpoints conviven: el corte es la fase 4C.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Supabase, `communication-tool/client`.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

**Repo donde se trabaja:** `gym-tracker`, rama `claude/fase-4-comm-tool`.

---

## Lo que ya está hecho y verificado

Las tareas 1 y 2 se ejecutaron primero, a propósito: el valor entero de esta
etapa depende de que la implementación vieja pase la suite, y si no pasaba el
plan era otro. Los resultados:

**Task 1 — el paquete instalado.** `bun add github:juanandresdavila/communication-tool#v0.1.0`
resolvió sin credenciales y quedó en `package.json`.

**Task 2 — la suite contra Telegram directo: los 10 casos pasan.** Es el
momento que el spec describe en §Suite de conformidad. Con las dos
implementaciones pasando los mismos casos, «cambiar una variable de entorno»
dejó de ser una promesa.

Se verificó además que el enganche no es vacuo: cambiando el `userId` esperado
a uno falso, el caso correspondiente **falla**. Una suite que pasa siempre es
peor que no tenerla.

`src/lib/__tests__/conformidad.test.ts` engancha los casos reusando lo que
GymTracker ya tenía —`IdentidadFalsa`, los fixtures `telegram-message.json` y
`telegram-photo.json`, el helper `request()`—, con dos equivalencias que vale
explicitar:

| Concepto del contrato | Telegram directo | comm-tool |
|---|---|---|
| Request no autenticado | Sin `x-telegram-bot-api-secret-token` | Firma HMAC inválida |
| `messageId` (id de entrega) | `update_id` | El UUID de `inbound_messages` |

## Lo que falta

| Task | Qué |
|---|---|
| 3 | `/api/messaging/inbound`, el endpoint que recibe las entregas firmadas |
| 4 | Elegir adapter por variable de entorno |
| 5 | Documentar y abrir el PR |

**No entra: mover el webhook.** Es la fase 4C. Al terminar esta etapa GymTracker
tiene los dos caminos construidos y sigue recibiendo por Telegram directo,
exactamente como hoy. Nada de lo que se hace acá cambia el comportamiento en
producción — y eso es deliberado, porque el corte necesita que el endpoint
exista y esté verificado **antes**.

**Dato que evita una migración innecesaria:** el enum `message_source` de
GymTracker ya incluye `'comm-tool'` (`supabase/migrations/0002_domain_schema.sql`).
No hay que tocar el esquema.

---

## Task 3: El endpoint de entrega

**Files:**
- Create: `src/app/api/messaging/inbound/route.ts` (en `gym-tracker`)
- Create: `src/lib/messaging/comm-tool.ts`
- Test: `src/lib/__tests__/comm-tool.test.ts`

- [ ] **Step 1: Escribir la fábrica del adapter**

Envuelve al paquete para que las variables de entorno se lean en un solo lugar,
igual que `createTelegramMessaging` hace con las suyas.

`src/lib/messaging/comm-tool.ts`:

```ts
import { createCommToolMessaging } from "communication-tool/client";
import type { Messaging } from "@/lib/messaging/types";

/**
 * El adapter de comm-tool. Todo lo que sabe de Telegram —el token, el chat_id,
 * el secreto del webhook— vive del otro lado: acá no queda nada.
 */
export function createCommToolAdapter(fetchFn?: typeof fetch): Messaging {
  const baseUrl = process.env.COMM_TOOL_URL;
  const apiKey = process.env.COMM_TOOL_API_KEY;
  const deliverySecret = process.env.COMM_TOOL_DELIVERY_SECRET;

  // Falla al construir, no al usar: una variable faltante tiene que romper el
  // arranque del request y no aparecer como un mensaje que nunca llegó.
  if (!baseUrl || !apiKey || !deliverySecret) {
    throw new Error(
      "Faltan COMM_TOOL_URL, COMM_TOOL_API_KEY o COMM_TOOL_DELIVERY_SECRET",
    );
  }

  return createCommToolMessaging({
    baseUrl,
    apiKey,
    deliverySecret,
    ...(fetchFn ? { fetchFn } : {}),
  });
}
```

- [ ] **Step 2: Escribir los tests que fallan**

`src/lib/__tests__/comm-tool.test.ts`:

```ts
import { headerDeFirma } from "communication-tool/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommToolAdapter } from "@/lib/messaging/comm-tool";

const SECRETO = "secreto-de-entrega";
const ENTREGA = {
  messageId: "uuid-de-comm-tool",
  userId: "user-1",
  channel: "telegram",
  text: "banca 4x10 60",
  receivedAt: "2026-08-02T12:00:00.000Z",
  raw: { update_id: 900001 },
};

function firmada(cuerpo: Record<string, unknown>, secreto = SECRETO): Request {
  const texto = JSON.stringify(cuerpo);
  const t = Math.floor(Date.now() / 1000);
  return new Request("https://gym.test/api/messaging/inbound", {
    method: "POST",
    headers: { "x-comm-signature": headerDeFirma(secreto, texto, t) },
    body: texto,
  });
}

beforeEach(() => {
  process.env.COMM_TOOL_URL = "https://comm.test";
  process.env.COMM_TOOL_API_KEY = "clave";
  process.env.COMM_TOOL_DELIVERY_SECRET = SECRETO;
});

afterEach(() => {
  delete process.env.COMM_TOOL_URL;
  delete process.env.COMM_TOOL_API_KEY;
  delete process.env.COMM_TOOL_DELIVERY_SECRET;
});

describe("createCommToolAdapter", () => {
  it("tira al construirse si falta una variable", () => {
    delete process.env.COMM_TOOL_API_KEY;
    expect(() => createCommToolAdapter()).toThrow(/COMM_TOOL_API_KEY/);
  });

  it("parsea una entrega bien firmada", async () => {
    const res = await createCommToolAdapter().parseIncoming(firmada(ENTREGA));
    expect(res?.userId).toBe("user-1");
    expect(res?.text).toBe("banca 4x10 60");
    expect(res?.messageId).toBe("uuid-de-comm-tool");
  });

  it("devuelve null si la firma es de otro secreto", async () => {
    const req = firmada(ENTREGA, "otro-secreto");
    expect(await createCommToolAdapter().parseIncoming(req)).toBeNull();
  });

  it("manda por la API de comm-tool y devuelve el id del proveedor", async () => {
    const llamadas: { url: string; body: unknown }[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      llamadas.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ messageId: "u", providerMessageId: "77" }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await createCommToolAdapter(fetchFn).sendMessage({
      userId: "user-1",
      text: "anotado",
      kind: "reply",
    });

    expect(res).toEqual({ messageId: "77" });
    expect(llamadas[0]?.url).toBe("https://comm.test/v1/messages");
  });
});
```

- [ ] **Step 3: Correr los tests**

```bash
cd ~/Projects/gym-tracker && bun run test src/lib/__tests__/comm-tool.test.ts
```

Esperado: PASS, 4 tests.

- [ ] **Step 4: Escribir el endpoint**

`src/app/api/messaging/inbound/route.ts`:

```ts
import { handleMessage } from "@/lib/bot/handle";
import { createSupabaseBotRepo } from "@/lib/bot/supabase-repo";
import { createCommToolAdapter } from "@/lib/messaging/comm-tool";
import { createServiceClient } from "@/lib/supabase/service";

export const maxDuration = 30;

/**
 * Las entregas de communication-tool. Es el gemelo de /api/telegram: cambia
 * QUIÉN trae el mensaje, no qué se hace con él — los dos terminan en el mismo
 * `handleMessage`, que es la prueba de que el dominio no se entera del
 * transporte.
 */
export async function POST(req: Request) {
  const messaging = createCommToolAdapter();

  // `null` = firma inválida o vencida. Se contesta 401 y NO 2xx: comm-tool
  // reintenta y después lo deja en `failed` con el error a la vista, que es lo
  // que uno quiere de una configuración mal puesta. Un 200 la escondería.
  const incoming = await messaging.parseIncoming(req);
  if (!incoming) return new Response("unauthorized", { status: 401 });

  const client = createServiceClient();
  // El discriminante de idempotencia: el único es (source, external_message_id),
  // así que un mismo id de dos transportes distintos no colisiona.
  const repo = createSupabaseBotRepo(client, { source: "comm-tool" });

  let reply: string | null;
  try {
    reply = await handleMessage(incoming, { repo, now: new Date() });
  } catch (error) {
    // Que comm-tool reintente: todavía no se guardó nada. El reintento rebota
    // solo contra el único si el crudo sí llegó a entrar.
    console.error("[comm-tool] handleMessage", error);
    return new Response("error", { status: 500 });
  }

  if (reply) {
    try {
      await messaging.sendMessage({
        userId: incoming.userId,
        text: reply,
        kind: "reply",
      });
    } catch (error) {
      // Lo escrito ya está escrito: pedir un reintento repetiría el envío,
      // nunca las series. Mismo criterio que /api/telegram.
      console.error("[comm-tool] sendMessage", error);
    }
  }

  return Response.json({ ok: true });
}
```

- [ ] **Step 5: Verificar y commitear**

```bash
cd ~/Projects/gym-tracker && bun run typecheck && bun run lint && bun run test
```

```bash
cd ~/Projects/gym-tracker && git add -A && git commit -m "feat: endpoint de entrega de communication-tool"
```

---

## Task 4: Elegir el adapter por variable de entorno

Es la variable que el spec promete desde el día uno: «migrar es cambiar una
variable de entorno».

**Files:**
- Create: `src/lib/messaging/index.ts`
- Test: `src/lib/__tests__/messaging-factory.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/lib/__tests__/messaging-factory.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { transporteElegido } from "@/lib/messaging";

afterEach(() => {
  delete process.env.MESSAGING_TRANSPORT;
});

describe("transporteElegido", () => {
  it("usa Telegram directo por defecto", () => {
    // El default es el statu quo a propósito: olvidarse de setear la variable
    // no puede cambiar por dónde habla el bot en producción.
    expect(transporteElegido()).toBe("telegram");
  });

  it("usa comm-tool cuando la variable lo pide", () => {
    process.env.MESSAGING_TRANSPORT = "comm-tool";
    expect(transporteElegido()).toBe("comm-tool");
  });

  it("cae a Telegram ante un valor que no entiende", () => {
    process.env.MESSAGING_TRANSPORT = "chamuyo";
    expect(transporteElegido()).toBe("telegram");
  });
});
```

- [ ] **Step 2: Escribir la fábrica**

`src/lib/messaging/index.ts`:

```ts
export type Transporte = "telegram" | "comm-tool";

/**
 * Qué transporte usa el bot. El default es `telegram` —el statu quo— para que
 * olvidarse de la variable no cambie el comportamiento en producción: el
 * cambio tiene que ser una decisión explícita.
 */
export function transporteElegido(): Transporte {
  return process.env.MESSAGING_TRANSPORT === "comm-tool"
    ? "comm-tool"
    : "telegram";
}
```

- [ ] **Step 3: Correr los tests y commitear**

```bash
cd ~/Projects/gym-tracker && bun run test src/lib/__tests__/messaging-factory.test.ts
```

Esperado: PASS, 3 tests.

```bash
cd ~/Projects/gym-tracker && git add -A && git commit -m "feat: el transporte de mensajería se elige por variable de entorno"
```

**Por qué no se cablea todavía en las rutas.** Cada endpoint ya sabe cuál es su
adapter: `/api/telegram` usa Telegram y `/api/messaging/inbound` usa comm-tool.
La variable la va a leer el **saliente programado** de la fase 5 y el corte de
la 4C, que es cuando hay una decisión real que tomar. Meterla ahora en las
rutas sería indirección sin beneficio.

---

## Task 5: Documentar y abrir el PR

**Files:**
- Modify: `CLAUDE.md`, `.env.example` (en `gym-tracker`)

- [ ] **Step 1: Documentar las variables nuevas**

Sumá a `.env.example` de GymTracker:

```bash
# communication-tool. Solo hacen falta si MESSAGING_TRANSPORT=comm-tool, pero
# el endpoint /api/messaging/inbound las exige siempre que reciba una entrega.
# COMM_TOOL_DELIVERY_SECRET tiene que ser IDÉNTICO al DELIVERY_SECRET_GYM de
# comm-tool: es el secreto con el que firma lo que manda.
COMM_TOOL_URL=https://communication-tool-beta.vercel.app
COMM_TOOL_API_KEY=
COMM_TOOL_DELIVERY_SECRET=
# telegram (default) | comm-tool
MESSAGING_TRANSPORT=telegram
```

- [ ] **Step 2: Documentar el estado en `CLAUDE.md` de GymTracker**

Sumá una sección:

```markdown
## communication-tool

GymTracker tiene los dos transportes construidos y **usa Telegram directo**.

- `/api/telegram` — el webhook de Telegram. Es el que recibe hoy.
- `/api/messaging/inbound` — las entregas firmadas de comm-tool. Construido y
  probado, pero **no recibe nada todavía**: el webhook del bot sigue apuntando
  acá, no a comm-tool.

Las dos implementaciones de `Messaging` pasan la **misma** suite de
conformidad (`src/lib/__tests__/conformidad.test.ts`), que viene del paquete
`communication-tool/conformance`. Si tocás una y no la otra, el CI lo dice.

**El corte es exclusivo.** Un bot de Telegram tiene un solo webhook: el día que
apunte a comm-tool, `/api/telegram` deja de recibir en el acto y sin aviso. No
mover el `setWebhook` hasta que `/api/messaging/inbound` esté verificado contra
producción — es la fase 4C de comm-tool.
```

- [ ] **Step 3: Verificar todo y abrir el PR**

```bash
cd ~/Projects/gym-tracker && bun run typecheck && bun run lint && bun run test
```

```bash
cd ~/Projects/gym-tracker && git add -A && git commit -m "docs: los dos transportes de mensajería"
```

```bash
cd ~/Projects/gym-tracker && git push -u origin HEAD
```

```bash
cd ~/Projects/gym-tracker && gh pr create --title "Fase 4: los dos transportes de mensajería" --body "Instala el paquete cliente de communication-tool, corre su suite de conformidad contra la implementación de Telegram directo, y suma el endpoint de entrega. **No cambia el comportamiento en producción**: el bot sigue recibiendo por /api/telegram."
```

---

## Verificación de la etapa

- [ ] `bun run lint && bun run typecheck && bun run test` en verde en `gym-tracker`.
- [ ] Los 10 casos de conformidad pasan contra `createTelegramMessaging`.
- [ ] Romper el `userId` esperado **hace fallar** el caso correspondiente.
- [ ] `/api/messaging/inbound` devuelve 401 ante una firma inválida.
- [ ] El endpoint viejo `/api/telegram` sigue funcionando sin cambios.
- [ ] `bun run build` de Next pasa con el paquete instalado desde git.
- [ ] El CI de GymTracker pasa en GitHub — es donde se comprueba que la
      dependencia git resuelve sin credenciales.

El que cierra la etapa es el del CI: localmente el paquete resuelve con tus
credenciales de git aunque algo esté mal configurado. En CI no.

## Lo que sigue

**4C — el corte.** Arreglar el `delivery_url` de `apps` (hoy apunta a
`gym-tracker.vercel.app`, que devuelve 302 y no es el deploy real), cargar las
variables en Vercel, verificar la entrega de punta a punta contra producción, y
recién ahí mover el `setWebhook`. Con el rollback escrito **antes** de tocarlo.
