# communication-tool — Fase 4A: El paquete cliente

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que exista un paquete cliente delgado que implemente la interfaz `Messaging` contra la API HTTP de comm-tool, y una suite de conformidad ejecutable que verifique —no que prometa— que las dos implementaciones son intercambiables.

**Architecture:** El paquete vive en este mismo repo bajo `src/client/`, se compila a `dist/` con un `prepare`, y se consume como **dependencia git** (`github:juanandresdavila/communication-tool#v0.1.0`). No tiene dependencias en runtime: solo `fetch` y `node:crypto`. La suite de conformidad se exporta como **datos, no como tests**: una lista de casos que cada repo engancha a su propio runner, para que el paquete no arrastre Vitest.

**Este repo es público desde el 2026-08-02**, y eso es un requisito de la
dependencia git, no una casualidad: con el repo privado, el `bun install` del
CI de GymTracker y el build de Vercel no pueden clonarlo —el `GITHUB_TOKEN` de
Actions solo alcanza al repo propio— y el fallo aparece recién como un build
rojo en la etapa 4B. Antes de publicar se auditó el historial completo: ningún
`.env` fue commiteado nunca, no hay tokens ni cadenas de conexión reales, y el
único hex largo es el golden value del HMAC calculado del secreto literal
`"secreto"`. La invariante de §Invariantes se sostiene en la práctica.

**Tech Stack:** TypeScript, `node:crypto`, Vitest (solo del lado de quien corre la suite).

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## Dónde encaja: la fase 4 son tres etapas y el orden no es negociable

| Etapa | Qué entrega | Repo |
|---|---|---|
| **4A — este plan** | Paquete cliente + suite de conformidad, verde contra la implementación de comm-tool | `communication-tool` |
| 4B | GymTracker instala el paquete, su implementación de Telegram **también** pasa la suite, y se escribe el endpoint de entrega | `gym-tracker` |
| 4C | El corte: arreglar el `delivery_url`, verificar la entrega, mover el webhook | los dos |

**La restricción que manda sobre todo el resto, y que hay que tener presente desde ahora:**

> Un bot de Telegram tiene **un solo webhook y es exclusivo**. El último que
> llama a `setWebhook` se queda con todos los updates y el anterior deja de
> recibir sin error ni aviso. Hoy lo tiene GymTracker. Moverlo a comm-tool
> **antes** de que su endpoint de entrega exista y esté verificado deja al
> usuario sin poder registrar series, y no hay señal de que algo se rompió.

Por eso 4C va último y por eso 4B incluye verificar la entrega **contra
`scripts/receptor-de-prueba.ts` y contra el endpoint real**, las dos, antes de
tocar el registro del webhook.

**Un bug ya identificado, que se arregla en 4C:** `apps.delivery_url` de
`gym-tracker` apunta a `https://gym-tracker.vercel.app/api/messaging/inbound`,
y ese dominio **no es el deploy de GymTracker** — devuelve 302. El real es
`gym-tracker-brown-one.vercel.app`. Con el dominio mal, cada entrega daría 302,
que no es 2xx: cinco reintentos y `failed`, con pinta de "la app no recibe".

## Por qué la suite de conformidad no es ceremonia

El spec (§Testing) es explícito: sin ella, «cambiar una variable de entorno»
es una promesa; con ella, está verificado. La migración de GymTracker se apoya
entera en que las dos implementaciones se comporten igual, y las diferencias
que importan son justo las que no se ven leyendo el código —qué devuelve
`parseIncoming` ante una firma inválida, si un mensaje sin texto llega como
`""` o como `null`, si `sendMessage` tira o devuelve un id vacío cuando el
usuario no está vinculado.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/client/types.ts` | `Messaging`, `IncomingMessage`, `OutgoingMessage`. **Sin dependencias** |
| `src/client/signature.ts` | **Mover** desde `src/delivery/signature.ts`. La fase 2 ya anotó que este era su destino |
| `src/client/index.ts` | `createCommToolMessaging`: `sendMessage` vía `POST /v1/messages`, `parseIncoming` verificando el HMAC |
| `src/client/conformance.ts` | La suite, como lista de casos. Sin importar Vitest |
| `src/client/index.test.ts` | Tests del cliente contra un `fetch` falso |
| `src/client/conformance.test.ts` | Corre la suite contra `createCommToolMessaging` |
| `tsconfig.client.json` | Compila **solo** `src/client` a `dist/` con `.d.ts` |
| `package.json` | **Modificar**: `exports`, `files`, `prepare` |
| `src/delivery/deliver.ts` | **Modificar**: importar la firma desde su lugar nuevo |

**El corte que sostiene la etapa:** el paquete no importa **nada** del
servicio. Si algún día `src/client/` importara `src/db/` o `hono`, GymTracker
se llevaría medio comm-tool en su `node_modules` y la migración dejaría de ser
barata. La Task 6 lo blinda con un test.

---

## Task 1: Mover la firma al paquete

La fase 2 dejó `firmaValida` en `src/delivery/signature.ts` con una nota: «no la
usa comm-tool: la usa **la app receptora**. En la fase 4 se va al paquete
cliente». Es ahora.

**Files:**
- Create: `src/client/signature.ts`, `src/client/signature.test.ts`
- Delete: `src/delivery/signature.ts`, `src/delivery/signature.test.ts`
- Modify: `src/delivery/deliver.ts`

- [ ] **Step 1: Mover los dos archivos sin tocar su contenido**

```bash
mkdir -p src/client && git mv src/delivery/signature.ts src/client/signature.ts && git mv src/delivery/signature.test.ts src/client/signature.test.ts
```

- [ ] **Step 2: Corregir el import del servicio**

En `src/delivery/deliver.ts`, cambiá:

```ts
import { headerDeFirma } from './signature.js'
```

por:

```ts
import { headerDeFirma } from '../client/signature.js'
```

- [ ] **Step 3: Corregir el import del receptor de prueba**

En `scripts/receptor-de-prueba.ts`, cambiá:

```ts
import { firmaValida } from '../src/delivery/signature.js'
```

por:

```ts
import { firmaValida } from '../src/client/signature.js'
```

- [ ] **Step 4: Verificar que no quedó ninguna referencia vieja**

```bash
grep -rn "delivery/signature" src scripts docs || echo "sin referencias viejas"
```

Esperado: `sin referencias viejas`.

- [ ] **Step 5: Correr todo**

```bash
bun run typecheck
```

```bash
DATABASE_URL='' bun run test
```

Esperado: 181 tests, los mismos de antes. Mover un archivo no cambia ningún comportamiento.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: la firma HMAC se muda al paquete cliente"
```

---

## Task 2: Los tipos del contrato

**Files:**
- Create: `src/client/types.ts`

- [ ] **Step 1: Escribir los tipos**

`src/client/types.ts`:

```ts
/**
 * El contrato de mensajería del spec, §El contrato. Es el MISMO archivo que
 * vive en `src/lib/messaging/types.ts` de GymTracker: que las dos copias no
 * se separen es justamente lo que verifica la suite de conformidad.
 *
 * Este archivo no importa nada, ni siquiera de este repo. Es la raíz de que el
 * paquete sea delgado.
 */

export type Channel = 'telegram' | 'whatsapp'

export interface IncomingMessage {
  /** El `app_user_id` YA RESUELTO. Nunca un chat_id. */
  userId: string
  /** Un entrante sin texto llega con `""`, no con null: decide la app. */
  text: string
  channel: Channel
  /**
   * El id de la ENTREGA, que es lo que hace idempotente al receptor. Con
   * Telegram directo lleva el `update_id`; con comm-tool, su `messageId`.
   */
  messageId: string
  /**
   * El id del MENSAJE respondido, en el espacio de ids **del proveedor** —el
   * mismo que devuelve `sendMessage`—, para poder correlacionar.
   */
  replyToMessageId?: string
  receivedAt: string
  raw: unknown
}

export interface OutgoingMessage {
  userId: string
  text: string
  /**
   * En Telegram no cambia nada. Existe para que el día que haya WhatsApp el
   * call site ya declare su intención.
   */
  kind: 'reply' | 'notification'
  replyToMessageId?: string
  template?: { name: string; vars: Record<string, string> }
}

export interface Messaging {
  /** Devuelve el id del mensaje enviado: es la mecánica de correlación. */
  sendMessage(msg: OutgoingMessage): Promise<{ messageId: string }>
  /** `null` cuando el request no es un mensaje procesable. */
  parseIncoming(req: Request): Promise<IncomingMessage | null>
}
```

- [ ] **Step 2: Verificar y commitear**

```bash
bun run typecheck
```

```bash
git add src/client/types.ts && git commit -m "feat: los tipos del contrato Messaging en el paquete cliente"
```

---

## Task 3: El cliente

**Files:**
- Create: `src/client/index.ts`
- Test: `src/client/index.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/client/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { headerDeFirma } from './signature.js'
import { createCommToolMessaging } from './index.js'

const BASE_URL = 'https://comm.test'
const API_KEY = 'clave-de-la-app'
const SECRETO = 'secreto-de-entrega'

function fetchQue(estado: number, cuerpo: unknown) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init })
    return new Response(JSON.stringify(cuerpo), { status: estado })
  }
  return { fake, llamadas }
}

function crear(fetchImpl: typeof fetch) {
  return createCommToolMessaging({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    deliverySecret: SECRETO,
    fetchFn: fetchImpl,
  })
}

/** Un request de entrega como el que manda comm-tool, bien firmado. */
function entregaFirmada(
  cuerpo: Record<string, unknown>,
  opts: { secreto?: string; t?: number } = {},
): Request {
  const texto = JSON.stringify(cuerpo)
  const t = opts.t ?? Math.floor(Date.now() / 1000)
  return new Request('https://app.test/api/messaging/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Comm-Signature': headerDeFirma(opts.secreto ?? SECRETO, texto, t),
      'X-Comm-Delivery-Id': String(cuerpo['messageId'] ?? 'del-1'),
    },
    body: texto,
  })
}

const ENTREGA = {
  messageId: 'uuid-de-comm-tool',
  userId: 'user-1',
  channel: 'telegram',
  text: 'banca 4x10 60',
  receivedAt: '2026-08-02T12:00:00.000Z',
  raw: { update_id: 900_001 },
}

describe('sendMessage', () => {
  it('postea a /v1/messages con la API key', async () => {
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'uuid',
      providerMessageId: '77',
      status: 'sent',
    })

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'anotado',
      kind: 'reply',
    })

    expect(llamadas[0]?.url).toBe('https://comm.test/v1/messages')
    const headers = new Headers(llamadas[0]?.init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      userId: 'user-1',
      text: 'anotado',
      kind: 'reply',
    })
  })

  it('devuelve el providerMessageId, no el id de comm-tool', async () => {
    // Es LA decisión del cliente. El `messageId` que devuelve `sendMessage` se
    // compara después contra el `replyToMessageId` de un entrante, que viene
    // del proveedor. Devolver el UUID de comm-tool rompería la correlación en
    // silencio: nunca matchearía con nada.
    const { fake } = fetchQue(200, {
      messageId: 'uuid-de-comm-tool',
      providerMessageId: '77',
      status: 'sent',
    })

    expect(await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'x',
      kind: 'reply',
    })).toEqual({ messageId: '77' })
  })

  it('manda replyToMessageId y template solo si vienen', async () => {
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'u',
      providerMessageId: '1',
      status: 'sent',
    })

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: 'x',
      kind: 'notification',
      replyToMessageId: '55',
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      userId: 'user-1',
      text: 'x',
      kind: 'notification',
      replyToMessageId: '55',
      template: { name: 'checkin', vars: { hora: '22:00' } },
    })
  })

  it('tira si el usuario no está vinculado', async () => {
    // Mismo comportamiento que el adapter de Telegram directo, que tira
    // "no tiene chat de Telegram vinculado". La suite de conformidad lo exige.
    const { fake } = fetchQue(404, { code: 'not_linked' })
    await expect(
      crear(fake).sendMessage({ userId: 'user-9', text: 'x', kind: 'reply' }),
    ).rejects.toThrow(/not_linked/)
  })

  it('tira si comm-tool devuelve un error del proveedor', async () => {
    const { fake } = fetchQue(502, { code: 'send_failed', error: 'chat not found' })
    await expect(
      crear(fake).sendMessage({ userId: 'user-1', text: 'x', kind: 'reply' }),
    ).rejects.toThrow(/send_failed/)
  })

  it('nunca incluye la API key en el mensaje de error', async () => {
    const { fake } = fetchQue(500, { code: 'boom' })
    await expect(
      crear(fake).sendMessage({ userId: 'user-1', text: 'x', kind: 'reply' }),
    ).rejects.toThrow(/^(?!.*clave-de-la-app).*$/s)
  })
})

describe('parseIncoming', () => {
  const sinRed = (async () => {
    throw new Error('parseIncoming no debería llamar a la red')
  }) as unknown as typeof fetch

  it('devuelve el mensaje cuando la firma es válida', async () => {
    const res = await crear(sinRed).parseIncoming(entregaFirmada(ENTREGA))

    expect(res).toEqual({
      userId: 'user-1',
      text: 'banca 4x10 60',
      channel: 'telegram',
      messageId: 'uuid-de-comm-tool',
      receivedAt: '2026-08-02T12:00:00.000Z',
      raw: { update_id: 900_001 },
    })
  })

  it('devuelve null si la firma es de otro secreto', async () => {
    const req = entregaFirmada(ENTREGA, { secreto: 'otro' })
    expect(await crear(sinRed).parseIncoming(req)).toBeNull()
  })

  it('devuelve null si falta el header de firma', async () => {
    const req = new Request('https://app.test/x', {
      method: 'POST',
      body: JSON.stringify(ENTREGA),
    })
    expect(await crear(sinRed).parseIncoming(req)).toBeNull()
  })

  it('devuelve null si la firma venció la ventana anti-replay', async () => {
    const viejo = Math.floor(Date.now() / 1000) - 400
    expect(
      await crear(sinRed).parseIncoming(entregaFirmada(ENTREGA, { t: viejo })),
    ).toBeNull()
  })

  it('un entrante sin texto llega con text vacío, NO con null', async () => {
    // Es la diferencia que el spec marca explícitamente: una foto no se
    // descarta, se entrega con text "" y decide la app.
    const res = await crear(sinRed).parseIncoming(
      entregaFirmada({ ...ENTREGA, text: '' }),
    )
    expect(res?.text).toBe('')
    expect(res).not.toBeNull()
  })

  it('propaga replyToMessageId cuando viene', async () => {
    const res = await crear(sinRed).parseIncoming(
      entregaFirmada({ ...ENTREGA, replyToMessageId: '55' }),
    )
    expect(res?.replyToMessageId).toBe('55')
  })

  it('devuelve null ante un cuerpo que no es una entrega', async () => {
    const req = entregaFirmada({ cualquiera: 'cosa' })
    expect(await crear(sinRed).parseIncoming(req)).toBeNull()
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
DATABASE_URL='' bun run test src/client/index.test.ts
```

Esperado: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Escribir el cliente**

`src/client/index.ts`:

```ts
import { firmaValida } from './signature.js'
import type {
  Channel,
  IncomingMessage,
  Messaging,
  OutgoingMessage,
} from './types.js'

export type { Channel, IncomingMessage, Messaging, OutgoingMessage }
export { firmaValida, headerDeFirma } from './signature.js'

export interface CommToolConfig {
  /** Sin barra final, por ejemplo `https://communication-tool-beta.vercel.app`. */
  baseUrl: string
  /** La API key de la app. Va en el header, nunca en la URL. */
  apiKey: string
  /** El secreto con el que comm-tool firma las entregas hacia esta app. */
  deliverySecret: string
  /** Inyectable para que los tests no toquen la red. */
  fetchFn?: typeof fetch
  now?: () => Date
}

interface RespuestaEnvio {
  messageId?: string
  providerMessageId?: string
  code?: string
  error?: string
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function createCommToolMessaging(config: CommToolConfig): Messaging {
  const doFetch = config.fetchFn ?? fetch
  const now = config.now ?? (() => new Date())

  return {
    async sendMessage(msg: OutgoingMessage) {
      const res = await doFetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          userId: msg.userId,
          text: msg.text,
          kind: msg.kind,
          ...(msg.replyToMessageId
            ? { replyToMessageId: msg.replyToMessageId }
            : {}),
          ...(msg.template ? { template: msg.template } : {}),
        }),
      })

      const cuerpo = (await res.json().catch(() => null)) as RespuestaEnvio | null

      if (!res.ok || !cuerpo?.providerMessageId) {
        // Nunca se incluye la request ni la clave en el error: solo el código
        // que devolvió comm-tool.
        throw new Error(
          `comm-tool rechazó el envío: ${cuerpo?.code ?? res.status}`,
        )
      }

      // El id DEL PROVEEDOR, no el de comm-tool. Es el que después matchea
      // contra el `replyToMessageId` de un entrante.
      return { messageId: cuerpo.providerMessageId }
    },

    async parseIncoming(req: Request): Promise<IncomingMessage | null> {
      // El cuerpo se lee como texto porque la firma es sobre los bytes
      // exactos: volver a serializar el objeto parseado cambiaría el HMAC.
      const cuerpo = await req.text()
      const firma = req.headers.get('X-Comm-Signature') ?? ''

      if (!firmaValida(config.deliverySecret, cuerpo, firma, now().getTime())) {
        return null
      }

      const datos: unknown = JSON.parse(cuerpo) as unknown
      if (!esObjeto(datos)) return null

      const { messageId, userId, channel, text, receivedAt } = datos
      if (
        typeof messageId !== 'string' ||
        typeof userId !== 'string' ||
        typeof channel !== 'string' ||
        typeof text !== 'string' ||
        typeof receivedAt !== 'string'
      ) {
        return null
      }

      const replyTo = datos['replyToMessageId']

      return {
        userId,
        text,
        channel: channel as Channel,
        messageId,
        ...(typeof replyTo === 'string' ? { replyToMessageId: replyTo } : {}),
        receivedAt,
        raw: datos['raw'],
      }
    },
  }
}
```

**`parseIncoming` no deduplica, y es a propósito.** La app tiene que hacerlo
con el `messageId` que recibe, que es el `X-Comm-Delivery-Id` — en GymTracker
cae solo contra el único `(source, external_message_id)`. Deduplicar acá
obligaría al paquete a tener estado, y un paquete con estado deja de ser
delgado.

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
DATABASE_URL='' bun run test src/client/index.test.ts
```

Esperado: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/client/ && git commit -m "feat: cliente de comm-tool que implementa Messaging"
```

---

## Task 4: La suite de conformidad

**Files:**
- Create: `src/client/conformance.ts`

- [ ] **Step 1: Escribir la suite**

`src/client/conformance.ts`:

```ts
import type { Messaging } from './types.js'

/**
 * La suite de conformidad del spec, §Suite de conformidad.
 *
 * Se exporta como DATOS, no como tests: una lista de casos que cada repo
 * engancha a su propio runner. Así el paquete no depende de Vitest, y
 * GymTracker puede correrla con el suyo sin alinear versiones.
 *
 *     import { CASOS_DE_CONFORMIDAD } from 'communication-tool/conformance'
 *     for (const caso of CASOS_DE_CONFORMIDAD) {
 *       it(caso.nombre, () => caso.ejecutar(contexto))
 *     }
 */

export interface ContextoDeConformidad {
  /** La implementación bajo prueba, ya armada con sus dobles. */
  messaging: Messaging
  /** Un request de entrada válido, que corresponde a `esperado`. */
  requestValido(): Request | Promise<Request>
  /** El mismo request pero con la firma o el secreto mal. */
  requestInvalido(): Request | Promise<Request>
  /** Un request válido cuyo mensaje no trae texto. */
  requestSinTexto(): Request | Promise<Request>
  /** Lo que `parseIncoming(requestValido())` tiene que devolver. */
  esperado: { userId: string; text: string; messageId: string }
  /** Un userId que SÍ está vinculado, y uno que no. */
  userIdVinculado: string
  userIdSinVincular: string
}

export interface CasoDeConformidad {
  nombre: string
  ejecutar(ctx: ContextoDeConformidad): Promise<void>
}

/** Assert mínimo propio: el paquete no depende de ningún runner. */
function afirmar(condicion: boolean, mensaje: string): asserts condicion {
  if (!condicion) throw new Error(`conformidad: ${mensaje}`)
}

function igual(actual: unknown, esperado: unknown, que: string): void {
  afirmar(
    actual === esperado,
    `${que} — esperaba ${JSON.stringify(esperado)}, recibí ${JSON.stringify(actual)}`,
  )
}

export const CASOS_DE_CONFORMIDAD: CasoDeConformidad[] = [
  {
    nombre: 'parseIncoming devuelve el userId ya resuelto',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      igual(res.userId, ctx.esperado.userId, 'userId')
    },
  },
  {
    nombre: 'parseIncoming devuelve el texto del mensaje',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      igual(res.text, ctx.esperado.text, 'text')
    },
  },
  {
    nombre: 'parseIncoming devuelve el id de la entrega como messageId',
    async ejecutar(ctx) {
      // Es la clave de idempotencia del receptor. Si las dos
      // implementaciones no coinciden en QUÉ id es, migrar duplica mensajes.
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      igual(res.messageId, ctx.esperado.messageId, 'messageId')
    },
  },
  {
    nombre: 'parseIncoming marca el canal',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      afirmar(
        res.channel === 'telegram' || res.channel === 'whatsapp',
        `channel inválido: ${res.channel}`,
      )
    },
  },
  {
    nombre: 'parseIncoming devuelve un receivedAt en ISO 8601',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      afirmar(
        !Number.isNaN(new Date(res.receivedAt).getTime()),
        `receivedAt no parsea como fecha: ${res.receivedAt}`,
      )
    },
  },
  {
    nombre: 'parseIncoming devuelve null si el request no está autenticado',
    async ejecutar(ctx) {
      const res = await ctx.messaging.parseIncoming(await ctx.requestInvalido())
      igual(res, null, 'un request sin autenticar')
    },
  },
  {
    nombre: 'un entrante sin texto llega con text vacío, no con null',
    async ejecutar(ctx) {
      // El spec lo dice explícito: una foto o un audio no se descartan.
      // Devolver null acá haría que el dominio nunca se entere del mensaje.
      const res = await ctx.messaging.parseIncoming(await ctx.requestSinTexto())
      afirmar(res !== null, 'un mensaje sin texto NO debe devolver null')
      igual(res.text, '', 'text de un mensaje sin texto')
    },
  },
  {
    nombre: 'parseIncoming nunca filtra un chat_id al dominio',
    async ejecutar(ctx) {
      // La invariante central del spec. `raw` queda excluido a propósito: el
      // crudo del proveedor lo trae por contrato, y el dominio no lo mira.
      const res = await ctx.messaging.parseIncoming(await ctx.requestValido())
      afirmar(res !== null, 'un request válido no puede devolver null')
      const sinRaw = { ...res, raw: undefined }
      const serializado = JSON.stringify(sinRaw)
      for (const prohibido of ['chatId', 'chat_id', 'externalId']) {
        afirmar(
          !serializado.includes(prohibido),
          `el mensaje expone ${prohibido} al dominio`,
        )
      }
    },
  },
  {
    nombre: 'sendMessage devuelve un messageId no vacío',
    async ejecutar(ctx) {
      const res = await ctx.messaging.sendMessage({
        userId: ctx.userIdVinculado,
        text: 'mensaje de conformidad',
        kind: 'reply',
      })
      afirmar(
        typeof res.messageId === 'string' && res.messageId.length > 0,
        `sendMessage devolvió un messageId inservible: ${JSON.stringify(res.messageId)}`,
      )
    },
  },
  {
    nombre: 'sendMessage tira si el usuario no está vinculado',
    async ejecutar(ctx) {
      // Las dos implementaciones tienen que FALLAR, no devolver un id falso.
      // Si una tirara y la otra no, migrar cambiaría el flujo de errores del
      // dominio sin que nadie lo note.
      let tiro = false
      try {
        await ctx.messaging.sendMessage({
          userId: ctx.userIdSinVincular,
          text: 'no debería salir',
          kind: 'reply',
        })
      } catch {
        tiro = true
      }
      afirmar(tiro, 'sendMessage a un usuario sin vincular tiene que tirar')
    },
  },
]
```

- [ ] **Step 2: Verificar y commitear**

```bash
bun run typecheck
```

```bash
git add src/client/conformance.ts && git commit -m "feat: suite de conformidad de la interfaz Messaging"
```

---

## Task 5: Correr la suite contra el cliente de comm-tool

**Files:**
- Create: `src/client/conformance.test.ts`

- [ ] **Step 1: Escribir el enganche**

`src/client/conformance.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ContextoDeConformidad } from './conformance.js'
import { CASOS_DE_CONFORMIDAD } from './conformance.js'
import { createCommToolMessaging } from './index.js'
import { headerDeFirma } from './signature.js'

const BASE_URL = 'https://comm.test'
const SECRETO = 'secreto-de-entrega'
const VINCULADO = 'user-1'
const SIN_VINCULAR = 'user-9'

function entrega(over: Record<string, unknown> = {}): Request {
  const cuerpo = JSON.stringify({
    messageId: 'uuid-de-comm-tool',
    userId: VINCULADO,
    channel: 'telegram',
    text: 'banca 4x10 60',
    receivedAt: '2026-08-02T12:00:00.000Z',
    raw: { update_id: 900_001, message: { chat: { id: 12_345 } } },
    ...over,
  })
  const t = Math.floor(Date.now() / 1000)
  return new Request('https://app.test/api/messaging/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Comm-Signature': headerDeFirma(SECRETO, cuerpo, t),
    },
    body: cuerpo,
  })
}

const fetchFalso = (async (_url: string, init?: RequestInit) => {
  const enviado = JSON.parse(String(init?.body)) as { userId: string }
  if (enviado.userId === SIN_VINCULAR) {
    return new Response(JSON.stringify({ code: 'not_linked' }), { status: 404 })
  }
  return new Response(
    JSON.stringify({
      messageId: 'uuid',
      providerMessageId: '77',
      status: 'sent',
    }),
    { status: 200 },
  )
}) as unknown as typeof fetch

const contexto: ContextoDeConformidad = {
  messaging: createCommToolMessaging({
    baseUrl: BASE_URL,
    apiKey: 'clave',
    deliverySecret: SECRETO,
    fetchFn: fetchFalso,
  }),
  requestValido: () => entrega(),
  requestInvalido: () =>
    new Request('https://app.test/api/messaging/inbound', {
      method: 'POST',
      headers: { 'X-Comm-Signature': 't=1,v1=falsa' },
      body: JSON.stringify({ messageId: 'x' }),
    }),
  requestSinTexto: () => entrega({ text: '' }),
  esperado: {
    userId: VINCULADO,
    text: 'banca 4x10 60',
    messageId: 'uuid-de-comm-tool',
  },
  userIdVinculado: VINCULADO,
  userIdSinVincular: SIN_VINCULAR,
}

describe('conformidad — implementación de comm-tool', () => {
  it('la suite no está vacía', () => {
    // Un enganche que itera una lista vacía pasa en verde y no prueba nada.
    expect(CASOS_DE_CONFORMIDAD.length).toBeGreaterThan(5)
  })

  for (const caso of CASOS_DE_CONFORMIDAD) {
    it(caso.nombre, async () => {
      await caso.ejecutar(contexto)
    })
  }
})
```

El primer test parece trivial y no lo es: **un `for` sobre una lista vacía pasa
en verde**. Sin esa guarda, romper el import de la suite dejaría la
conformidad "verificada" sin ejecutar un solo caso.

- [ ] **Step 2: Correr y verificar**

```bash
DATABASE_URL='' bun run test src/client/conformance.test.ts
```

Esperado: PASS, 11 tests (los 10 casos más la guarda).

- [ ] **Step 3: Verificar que la suite detecta una implementación rota**

Comprobación manual de que la suite sirve. Editá `src/client/index.ts` y en
`parseIncoming` cambiá el `return null` de la firma inválida por
`return { userId: 'x', text: '', channel: 'telegram', messageId: 'x', receivedAt: new Date().toISOString(), raw: null }`.

```bash
DATABASE_URL='' bun run test src/client/conformance.test.ts
```

Esperado: **FALLA** el caso `parseIncoming devuelve null si el request no está autenticado`. Después revertí el cambio:

```bash
git checkout src/client/index.ts
```

```bash
DATABASE_URL='' bun run test src/client/conformance.test.ts
```

Esperado: PASS de nuevo, 11 tests.

- [ ] **Step 4: Commit**

```bash
git add src/client/conformance.test.ts && git commit -m "test: la implementación de comm-tool pasa la suite de conformidad"
```

---

## Task 6: Empaquetar

**Files:**
- Create: `tsconfig.client.json`, `src/client/paquete.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Escribir el test que blinda la delgadez**

`src/client/paquete.test.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// import.meta.dir no existe cuando Vitest carga el módulo. Ver CLAUDE.md.
const DIR = dirname(fileURLToPath(import.meta.url))

async function archivosDelCliente(): Promise<string[]> {
  const entradas = await readdir(DIR)
  return entradas.filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
}

describe('el paquete cliente es delgado', () => {
  it('no importa nada del servicio ni de node_modules', async () => {
    // Si esto se rompe, GymTracker se lleva medio comm-tool en su
    // node_modules y la migración deja de ser barata. Solo se permiten
    // imports relativos dentro de src/client y módulos node: nativos.
    const archivos = await archivosDelCliente()
    expect(archivos.length).toBeGreaterThan(3)

    for (const archivo of archivos) {
      const codigo = await readFile(join(DIR, archivo), 'utf8')
      const imports = [...codigo.matchAll(/from '([^']+)'/g)].map((m) => m[1])

      for (const modulo of imports) {
        const permitido =
          modulo?.startsWith('./') || modulo?.startsWith('node:')
        expect(
          permitido,
          `${archivo} importa "${modulo}", que no está permitido en el paquete`,
        ).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 2: Correr el test**

```bash
DATABASE_URL='' bun run test src/client/paquete.test.ts
```

Esperado: PASS, 1 test.

- [ ] **Step 3: Escribir el tsconfig del paquete**

`tsconfig.client.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": []
  },
  "include": ["src/client/**/*.ts"],
  "exclude": ["src/client/**/*.test.ts"]
}
```

`"types": []` saca los tipos de bun: el paquete lo va a compilar quien lo
instale, y ahí bun puede no estar.

- [ ] **Step 4: Declarar los puntos de entrada**

En `package.json`, sumá `exports`, `files` y los scripts. **`private: true` se
queda**: impide publicar a npm por accidente, y no estorba a una dependencia
git.

```json
  "files": [
    "dist"
  ],
  "exports": {
    "./client": {
      "types": "./dist/client/index.d.ts",
      "default": "./dist/client/index.js"
    },
    "./conformance": {
      "types": "./dist/client/conformance.d.ts",
      "default": "./dist/client/conformance.js"
    }
  },
```

y a `scripts`:

```json
    "build:client": "tsc -p tsconfig.client.json",
    "prepare": "tsc -p tsconfig.client.json"
```

**`prepare` es lo que hace que la dependencia git funcione**: npm y bun lo
corren al instalar desde git, así que el consumidor recibe `dist/` ya
compilado y no necesita transpilar TypeScript de `node_modules`.

Y sumá `dist` a `.gitignore`:

```bash
echo "dist" >> .gitignore
```

- [ ] **Step 5: Verificar que compila y que emite lo declarado**

```bash
bun run build:client
```

```bash
ls dist/client/
```

Esperado: `index.js`, `index.d.ts`, `types.js`, `types.d.ts`, `signature.js`, `signature.d.ts`, `conformance.js`, `conformance.d.ts`. **Ningún `.test.js`**.

- [ ] **Step 6: Verificar que el `prepare` no rompe el deploy**

Es el riesgo real de este cambio: `prepare` corre en cada `install`, también en
Vercel, y si falla el deploy no sale.

```bash
bun --bun x vercel build --yes >/dev/null 2>&1 && grep handler .vercel/output/functions/index.func/.vc-config.json
```

Esperado: `"handler": "src/index.js"`.

- [ ] **Step 7: Correr todo y commitear**

```bash
bun run typecheck
```

```bash
bun run lint
```

```bash
DATABASE_URL='' bun run test
```

Esperado: los tests de antes más los del cliente, y **4** archivos de integración salteados — el paquete no agrega ninguno, porque no toca la base.

```bash
git add -A && git commit -m "feat: el paquete cliente se compila y se exporta"
```

---

## Task 7: Etiquetar la versión

La dependencia git se ancla a un tag, no a una rama: sin eso, GymTracker
reinstalaría cualquier cosa que esté en `main` en ese momento.

- [ ] **Step 1: Abrir el PR y mergear**

```bash
git push -u origin HEAD
```

```bash
gh pr create --title "Fase 4A: paquete cliente y suite de conformidad" --body "Paquete cliente delgado que implementa \`Messaging\` contra la API de comm-tool, y la suite de conformidad del spec como datos enganchables a cualquier runner. Plan: \`docs/superpowers/plans/2026-08-02-phase-4a-client-package.md\`."
```

Esperá el CI en verde y mergeá.

- [ ] **Step 2: Etiquetar**

```bash
git fetch origin main && git tag -a v0.1.0 origin/main -m "Paquete cliente: Messaging sobre la API de comm-tool" && git push origin v0.1.0
```

- [ ] **Step 3: Verificar que se instala de verdad desde git**

La prueba que importa: instalarlo como lo va a instalar GymTracker, en un
directorio limpio y afuera de este repo.

```bash
mkdir -p /tmp/prueba-paquete && cd /tmp/prueba-paquete && bun init -y >/dev/null && bun add "github:juanandresdavila/communication-tool#v0.1.0" 2>&1 | tail -3
```

```bash
cd /tmp/prueba-paquete && bun -e "const m = await import('communication-tool/client'); console.log('exporta:', Object.keys(m).join(', '))"
```

Esperado: `exporta: createCommToolMessaging, firmaValida, headerDeFirma`.

```bash
cd /tmp/prueba-paquete && bun -e "const c = await import('communication-tool/conformance'); console.log('casos:', c.CASOS_DE_CONFORMIDAD.length)"
```

Esperado: `casos: 10`.

Si el import falla con `ERR_PACKAGE_PATH_NOT_EXPORTED`, el `exports` está mal.
Si falla con `Cannot find module './dist/...'`, el `prepare` no corrió y hay
que revisar que `tsconfig.client.json` esté commiteado.

**Probalo también sin credenciales de git**, que es la condición real del CI de
GymTracker y del build de Vercel:

```bash
mkdir -p /tmp/prueba-anonima && cd /tmp/prueba-anonima && bun init -y >/dev/null && GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 bun add "github:juanandresdavila/communication-tool#v0.1.0" 2>&1 | tail -3
```

Esperado: instala igual. Si pidiera credenciales, el repo volvió a privado y
la etapa 4B va a fallar en CI aunque en tu máquina ande.

```bash
rm -rf /tmp/prueba-anonima
```

- [ ] **Step 4: Limpiar**

```bash
rm -rf /tmp/prueba-paquete
```

---

## Verificación de la etapa

- [ ] `bun run lint && bun run typecheck && bun run test` en verde.
- [ ] `DATABASE_URL='' bun run test` saltea 4 archivos de integración y sale con 0.
- [ ] Los 10 casos de conformidad corren contra `createCommToolMessaging` y pasan.
- [ ] Romper `parseIncoming` a propósito **hace fallar** la suite (Task 5, Step 3).
- [ ] El test de delgadez impide que el paquete importe algo del servicio.
- [ ] `bun run build:client` emite `.js` y `.d.ts`, y **ningún** `.test.js`.
- [ ] `vercel build` sigue dejando `"handler": "src/index.js"` con el `prepare` puesto.
- [ ] El paquete se instala desde `github:...#v0.1.0` en un directorio limpio y exporta lo declarado.

El que cierra la etapa es el de romper `parseIncoming` a propósito: prueba que
la suite **detecta** una diferencia de comportamiento. Una suite de conformidad
que pasa siempre es peor que no tenerla, porque justifica una migración que no
verificó nada.

## Lo que sigue

**4B — el lado de GymTracker.** Instalar el paquete, enganchar la misma suite a
`createTelegramMessaging` —el momento en que «cambiar una variable de entorno»
deja de ser promesa—, escribir `/api/messaging/inbound`, y elegir el adapter
por variable de entorno.

**4C — el corte.** Arreglar el `delivery_url` (hoy apunta a un dominio que
devuelve 302), verificar la entrega de punta a punta, y recién entonces mover
el webhook. Con rollback escrito antes de tocarlo.
