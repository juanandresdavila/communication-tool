# Endurecimiento del webhook de Telegram — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sacar la respuesta al chat no vinculado del camino síncrono del webhook, ponerle timeout al cliente de Telegram, presupuestar las respuestas por chat en memoria, y dejar de guardar el crudo de las filas que nunca se entregan.

**Architecture:** Cuatro cambios acotados sobre `src/routes/telegram-webhook.ts` y `src/channels/telegram/client.ts`, más un módulo nuevo sin estado compartido (`src/presupuesto.ts`) que se inyecta desde `wire.ts` como cualquier otra dependencia. Sin migración, sin cambios de contrato, sin paso de ops.

**Tech Stack:** Bun, Hono, TypeScript (`module: nodenext`), Vitest, postgres.js.

**Spec:** `docs/superpowers/specs/2026-09-20-endurecimiento-del-webhook-design.md`

---

## Antes de empezar

Línea base, que hay que reproducir antes de tocar nada:

```bash
DATABASE_URL='' bun run test
```

Esperado: `Test Files 30 passed | 4 skipped (34)` y `Tests 252 passed | 20 skipped (272)`.

🚨 **Los imports relativos llevan `.js` siempre**, aunque el archivo sea `.ts`. Sin eso el deploy rompe en runtime con todos los tests en verde. `bun run typecheck` lo detecta.

🚨 **No encadenar las verificaciones con pipes**: `bun run lint | tail` devuelve el exit code de `tail` y tapa el fallo. Comandos sueltos.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/presupuesto.ts` **(nuevo)** | Contador por clave con ventana fija y tope de claves. Sin dependencias, sin reloj propio: el `Date` entra por parámetro. |
| `src/presupuesto.test.ts` **(nuevo)** | Sus tests, puros. |
| `src/channels/telegram/client.ts` | Suma `AbortSignal.timeout` y el timeout inyectable por la factory. La interfaz `TelegramClient` **no cambia**. |
| `src/create-app.ts` | Suma `presupuesto` a `Deps`. |
| `src/wire.ts` | Construye el presupuesto con los valores de producción. |
| `src/test-support/fake-deps.ts` | Le da uno real a los tests de app completa. |
| `src/routes/telegram-webhook.ts` | Respuestas por `waitUntil` con `.catch` propio, presupuestadas, y `raw` nulo en las `skipped`. |
| `src/db/repositories/inbound-messages.integration.test.ts` | Verifica contra base real que `raw` nulo no viola el `NOT NULL`. |
| `CLAUDE.md` | Dos invariantes nuevas y dos gotchas: lo que se paga caro si se invierte. |

Nadie más construye un `Deps`: verificado con grep, los tests de app completa pasan todos por `createFakeDeps`, así que los únicos sitios de construcción son `wire.ts` y `test-support/fake-deps.ts`.

---

### Task 1: El módulo del presupuesto

Es puro y no depende de nada del resto: se hace primero y se puede revisar solo.

**Files:**
- Create: `src/presupuesto.ts`
- Test: `src/presupuesto.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Crear `src/presupuesto.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { crearPresupuesto } from './presupuesto.js'

const T0 = new Date('2026-09-20T12:00:00.000Z')

/** Azúcar para no escribir `new Date(T0.getTime() + n)` en cada línea. */
function enT(ms: number): Date {
  return new Date(T0.getTime() + ms)
}

describe('crearPresupuesto', () => {
  it('deja pasar hasta el tope y después no', () => {
    const p = crearPresupuesto({
      porVentana: 2,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('a', T0)).toBe(true)
    expect(p.consumir('a', enT(1))).toBe(true)
    expect(p.consumir('a', enT(2))).toBe(false)
  })

  it('cuenta cada clave por separado', () => {
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('bot-1:111', T0)).toBe(true)
    expect(p.consumir('bot-1:222', T0)).toBe(true)
    expect(p.consumir('bot-1:111', T0)).toBe(false)
  })

  it('renueva la ventana al cumplirse, no antes', () => {
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('a', T0)).toBe(true)
    expect(p.consumir('a', enT(59_999))).toBe(false)
    expect(p.consumir('a', enT(60_000))).toBe(true)
  })

  it('con presupuesto cero no deja pasar ni la primera', () => {
    // La rama de "ventana nueva" es la que se cuela si no hay guarda arriba:
    // la primera llamada de cada clave no encuentra ventana previa contra la
    // cual comparar el contador.
    const p = crearPresupuesto({
      porVentana: 0,
      ventanaMs: 60_000,
      maxClaves: 10,
    })

    expect(p.consumir('a', T0)).toBe(false)
  })

  it('no crece más allá del tope de claves', () => {
    // El tope es lo que impide que el propio limitador sea el memory leak:
    // sin él, cambiar el chat id en cada mensaje llena la RAM en vez de la
    // base, que es peor que el problema que se quiere resolver.
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 3_600_000,
      maxClaves: 2,
    })

    expect(p.consumir('a', T0)).toBe(true)
    expect(p.consumir('b', enT(1))).toBe(true)
    // Entra 'c' con el mapa lleno y ninguna vencida: se expulsa la más vieja.
    expect(p.consumir('c', enT(2))).toBe(true)

    // 'a' fue expulsada y arranca de cero. Perder el contador de la clave más
    // vieja es el precio de acotar la RAM, y es el precio correcto.
    expect(p.consumir('a', enT(3))).toBe(true)
    // 'c' sigue viva y ya gastó lo suyo.
    expect(p.consumir('c', enT(4))).toBe(false)
  })

  it('reutiliza el lugar de una clave vencida antes de expulsar una viva', () => {
    const p = crearPresupuesto({
      porVentana: 1,
      ventanaMs: 60_000,
      maxClaves: 2,
    })

    expect(p.consumir('vieja', T0)).toBe(true)
    expect(p.consumir('viva', enT(59_000))).toBe(true)
    // 'vieja' ya venció, así que la barrida le hace lugar a 'nueva' sin tocar
    // a 'viva'.
    expect(p.consumir('nueva', enT(61_000))).toBe(true)
    expect(p.consumir('viva', enT(61_001))).toBe(false)
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

```bash
DATABASE_URL='' bun --bun x vitest run src/presupuesto.test.ts
```

Esperado: FAIL. El archivo `./presupuesto.js` no existe, así que falla al resolver el import.

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/presupuesto.ts`:

```ts
export interface OpcionesDePresupuesto {
  /** Respuestas permitidas por clave y por ventana. */
  porVentana: number
  /** Duración de la ventana, en milisegundos. */
  ventanaMs: number
  /** Máximo de claves vivas en memoria. */
  maxClaves: number
}

export interface PresupuestoDeRespuestas {
  /** Consume una unidad para `clave`. Devuelve false si ya no quedaba. */
  consumir(clave: string, ahora: Date): boolean
}

/**
 * Valores de producción. El 5 sale del flujo real de vinculación, que necesita
 * entre 2 y 4 mensajes (escribirle al bot, leer la pista, mandar el código,
 * quizás un typo). Ver el spec del 2026-09-20.
 */
export const PRESUPUESTO_POR_DEFECTO: OpcionesDePresupuesto = {
  porVentana: 5,
  ventanaMs: 60 * 60_000,
  maxClaves: 5_000,
}

interface Ventana {
  desde: number
  usadas: number
}

/**
 * Contador por clave con ventana FIJA: arranca con la primera unidad y al
 * cumplirse se descarta entera. Una ventana deslizante obligaría a guardar un
 * timestamp por respuesta en vez de un contador, y acá el objetivo es
 * amortiguar, no medir con precisión.
 *
 * 🚨 Cuenta por PROCESO. Es válido porque comm-tool es un container Bun de
 * proceso largo desde la migración al VPS; en un deploy serverless (el
 * rollback de Vercel) cada invocación arranca con el mapa vacío y esto degrada
 * a no limitar nada. Degrada, no rompe.
 */
export function crearPresupuesto(
  op: OpcionesDePresupuesto,
): PresupuestoDeRespuestas {
  const ventanas = new Map<string, Ventana>()

  function barrerVencidas(ahora: number): void {
    for (const [clave, v] of ventanas) {
      if (ahora - v.desde >= op.ventanaMs) ventanas.delete(clave)
    }
  }

  /**
   * Se busca el mínimo `desde` en vez de usar el orden de inserción del Map:
   * un `set` sobre una clave que ya existe conserva su posición original pero
   * le pone un `desde` nuevo, así que el orden de inserción NO es el orden de
   * antigüedad. Es O(n), pero solo corre al desbordar.
   */
  function expulsarMasVieja(): void {
    let candidata: string | undefined
    let masVieja = Infinity
    for (const [clave, v] of ventanas) {
      if (v.desde < masVieja) {
        masVieja = v.desde
        candidata = clave
      }
    }
    if (candidata !== undefined) ventanas.delete(candidata)
  }

  return {
    consumir(clave, ahora) {
      // Con presupuesto cero no hay nada que anotar. La guarda va acá arriba
      // porque si no, la primera llamada de cada clave se colaría por la rama
      // de ventana nueva, que no tiene contra qué comparar.
      if (op.porVentana < 1) return false

      const t = ahora.getTime()
      const actual = ventanas.get(clave)

      if (actual && t - actual.desde < op.ventanaMs) {
        if (actual.usadas >= op.porVentana) return false
        actual.usadas += 1
        return true
      }

      // Ventana nueva. Si la clave no estaba, el mapa va a crecer: hay que
      // hacerle lugar antes.
      if (!actual && ventanas.size >= op.maxClaves) {
        barrerVencidas(t)
        if (ventanas.size >= op.maxClaves) expulsarMasVieja()
      }

      ventanas.set(clave, { desde: t, usadas: 1 })
      return true
    },
  }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
DATABASE_URL='' bun --bun x vitest run src/presupuesto.test.ts
```

Esperado: PASS, 6 tests.

- [ ] **Step 5: Lint y typecheck**

```bash
bun run lint
```

```bash
bun run typecheck
```

Esperado: los dos sin salida y con exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/presupuesto.ts src/presupuesto.test.ts && git commit -m "feat: presupuesto de respuestas por clave, con ventana fija y tope de claves"
```

---

### Task 2: Timeout en el cliente de Telegram

Hoy `createTelegramClient` hace `fetch` sin `AbortSignal`, al revés que `createDeliveryClient`, que sí usa `AbortSignal.timeout(pedido.timeoutMs)`. Un api.telegram.org colgado cuelga el request.

El timeout entra como segundo parámetro **de la factory**, no de `sendMessage`: así la interfaz `TelegramClient` no cambia y ningún sitio de llamada ni ningún doble de test se toca.

**Files:**
- Modify: `src/channels/telegram/client.ts`
- Test: `src/channels/telegram/client.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final del `describe('createTelegramClient', ...)` en `src/channels/telegram/client.test.ts`, antes de la llave que lo cierra:

```ts
  it('le pasa un AbortSignal al fetch', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 81 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola')

    expect(llamadas[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborta el envío cuando vence el timeout', async () => {
    // Un fetch que no resuelve nunca por su cuenta: la única forma de que este
    // test termine es que el cliente lo aborte. Sin AbortSignal, el test cuelga
    // hasta el timeout de Vitest.
    const fake = async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolver, rechazar) => {
        init?.signal?.addEventListener('abort', () => {
          rechazar(new Error('The operation was aborted'))
        })
      })

    const cliente = createTelegramClient(fake, 10)

    await expect(cliente.sendMessage('TOKEN', '1', 'hola')).rejects.toThrow(
      /abort/i,
    )
  })
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

```bash
DATABASE_URL='' bun --bun x vitest run src/channels/telegram/client.test.ts
```

Esperado: FAIL. El primero por `expected undefined to be an instance of AbortSignal`; el segundo por timeout de Vitest a los 5 s, porque nadie aborta el fetch.

- [ ] **Step 3: Escribir la implementación**

En `src/channels/telegram/client.ts`, agregar la constante arriba de `replyParameters`:

```ts
/**
 * Mismo criterio que TIMEOUT_ENTREGA_MS en delivery/deliver.ts. Sin esto, un
 * api.telegram.org colgado cuelga el request que lo llamó: el webhook retenía
 * un slot del pool de Telegram y el saliente quedaba en `sending` sin marcar.
 */
export const TIMEOUT_TELEGRAM_MS = 10_000
```

Y cambiar la firma de la factory y el `fetch`:

```ts
export function createTelegramClient(
  fetchImpl: Fetch = fetch,
  timeoutMs: number = TIMEOUT_TELEGRAM_MS,
): TelegramClient {
  return {
    async sendMessage(token, chatId, text, replyToMessageId) {
      const res = await fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...replyParameters(replyToMessageId),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      )
```

El resto del cuerpo de `sendMessage` queda igual.

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
DATABASE_URL='' bun --bun x vitest run src/channels/telegram/client.test.ts
```

Esperado: PASS, 8 tests.

- [ ] **Step 5: Correr la suite entera**

```bash
DATABASE_URL='' bun run test
```

Esperado: `260 passed | 20 skipped`. El cambio alcanza también al saliente de `/v1/messages`; `enviarSaliente` ya envuelve `sendMessage` en `try/catch`, así que un timeout se vuelve `send_failed` y sus tests siguen en verde.

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram/client.ts src/channels/telegram/client.test.ts && git commit -m "fix: timeout en el cliente de Telegram, que hasta ahora esperaba para siempre"
```

---

### Task 3: Cablear el presupuesto, sin usarlo todavía

Solo plomería: el presupuesto entra en `Deps` y llega al webhook, pero nadie lo llama. Se separa para que el commit del comportamiento (Task 5) sea chico y revisable.

**Files:**
- Modify: `src/create-app.ts`
- Modify: `src/wire.ts`
- Modify: `src/test-support/fake-deps.ts`
- Modify: `src/routes/telegram-webhook.ts`
- Modify: `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Sumar la dependencia a `Deps`**

En `src/create-app.ts`, agregar el import junto a los demás:

```ts
import type { PresupuestoDeRespuestas } from './presupuesto.js'
```

Y el campo en la interfaz `Deps`, después de `internalSecret`:

```ts
  internalSecret: string
  presupuesto: PresupuestoDeRespuestas
  waitUntil: (promesa: Promise<unknown>) => void
```

- [ ] **Step 2: Construirlo en `wire.ts`**

En `src/wire.ts`, agregar el import:

```ts
import { crearPresupuesto, PRESUPUESTO_POR_DEFECTO } from './presupuesto.js'
```

Y el campo dentro del objeto que recibe `createApp`, después de `internalSecret`:

```ts
    internalSecret: env.INTERNAL_SECRET,
    // Se construye acá, y no adentro de createApp, porque tiene estado: el
    // invariante es que createApp recibe todo inyectado. De paso queda visible
    // en la capa de cableado que esto cuenta por proceso.
    presupuesto: crearPresupuesto(PRESUPUESTO_POR_DEFECTO),
    waitUntil,
```

- [ ] **Step 3: Sumarlo a `createFakeDeps`**

En `src/test-support/fake-deps.ts`, agregar el import:

```ts
import { crearPresupuesto, PRESUPUESTO_POR_DEFECTO } from '../presupuesto.js'
```

Y el campo, después de `internalSecret`:

```ts
    internalSecret: 'secreto-interno',
    // Uno nuevo por llamada: los tests no comparten contador.
    presupuesto: crearPresupuesto(PRESUPUESTO_POR_DEFECTO),
    waitUntil: () => {},
```

- [ ] **Step 4: Sumarlo a `TelegramWebhookDeps`**

En `src/routes/telegram-webhook.ts`, agregar el import junto a los demás:

```ts
import type { PresupuestoDeRespuestas } from '../presupuesto.js'
```

Y el campo en la interfaz, después de `inbound`:

```ts
  inbound: InboundMessagesRepo
  presupuesto: PresupuestoDeRespuestas
  waitUntil: (promesa: Promise<unknown>) => void
```

- [ ] **Step 5: Sumarlo al `armar()` del test del webhook**

En `src/routes/telegram-webhook.test.ts`, agregar los imports arriba, junto a los demás:

```ts
import {
  crearPresupuesto,
  PRESUPUESTO_POR_DEFECTO,
  type PresupuestoDeRespuestas,
} from '../presupuesto.js'
```

Extender las opciones de `armar`:

```ts
function armar(
  opts: {
    contactos?: Contact[]
    codigos?: LinkCode[]
    entregaFalla?: boolean
    presupuesto?: PresupuestoDeRespuestas
  } = {},
) {
```

Y pasarlo al construir las rutas, después de `inbound`:

```ts
      inbound,
      presupuesto:
        opts.presupuesto ?? crearPresupuesto(PRESUPUESTO_POR_DEFECTO),
```

- [ ] **Step 6: Correr la suite entera**

```bash
DATABASE_URL='' bun run test
```

Esperado: `260 passed | 20 skipped`. Nada cambió de comportamiento.

- [ ] **Step 7: Lint y typecheck**

```bash
bun run lint
```

```bash
bun run typecheck
```

Esperado: los dos limpios. Si `typecheck` se queja de que falta `presupuesto` en algún objeto `Deps`, es un sitio de construcción que no se cubrió: agregarlo ahí también.

- [ ] **Step 8: Commit**

```bash
git add src/create-app.ts src/wire.ts src/test-support/fake-deps.ts src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts && git commit -m "chore: inyectar el presupuesto de respuestas como dependencia del webhook"
```

---

### Task 4: La respuesta sale del camino síncrono

Hoy al vinculado se le contesta 200 al toque y la entrega va por `waitUntil`; al **no vinculado** se le hace `await responder(...)`, o sea que el request queda retenido esperando a api.telegram.org. Telegram entrega webhooks con un pool acotado y frena si el webhook va lento: los mensajes de desconocidos ocupan slots y los del usuario real hacen cola atrás.

**Files:**
- Modify: `src/routes/telegram-webhook.ts`
- Test: `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Preparar los dobles de envío en `armar()`**

En `src/routes/telegram-webhook.test.ts`, extender las opciones:

```ts
function armar(
  opts: {
    contactos?: Contact[]
    codigos?: LinkCode[]
    entregaFalla?: boolean
    envioFalla?: boolean
    envioColgado?: boolean
    presupuesto?: PresupuestoDeRespuestas
  } = {},
) {
```

Y reemplazar el doble de `telegram` por:

```ts
      telegram: {
        async sendMessage(_token, chatId, text) {
          enviados.push({ chatId, text })
          // Un envío que no resuelve nunca por su cuenta: sirve para probar
          // que el webhook NO lo espera.
          if (opts.envioColgado) return new Promise<never>(() => {})
          if (opts.envioFalla) {
            throw new Error('Telegram rechazó sendMessage: chat not found')
          }
          return { messageId: '1' }
        },
      },
```

- [ ] **Step 2: Escribir los tests que fallan**

Agregar al final del `describe('chat no vinculado', ...)`, antes de la llave que lo cierra:

```ts
  it('contesta 200 sin esperar a que salga la respuesta', async () => {
    // El envío no resuelve nunca. Si el webhook lo esperara, este test no
    // fallaría con un assert: colgaría hasta el timeout de Vitest. Es
    // deliberado, es la única forma honesta de probar que NO se espera.
    // Ojo: no se llama a drenar(), que por definición nunca terminaría.
    const { server } = armar({ envioColgado: true })

    const res = await postear(server, update('hola'))

    expect(res.status).toBe(200)
  })

  it('contesta 200 aunque el envío a Telegram falle', async () => {
    const { server } = armar({ envioFalla: true })

    const res = await postear(server, update('hola'))

    expect(res.status).toBe(200)
  })

  it('la promesa que se programa resuelve aunque el envío falle', async () => {
    // 🚨 El motivo de este test: el waitUntil de server.ts es `void promesa`,
    // que NO captura rejections, y sendMessage tira cuando Telegram rechaza.
    // Sin el .catch del webhook, acá quedaría una unhandled rejection que en
    // producción no la agarra nadie.
    const { server, drenar } = armar({ envioFalla: true })

    await postear(server, update('hola'))

    await expect(drenar()).resolves.toBeUndefined()
  })
```

- [ ] **Step 3: Correr los tests y verificar que fallan**

```bash
DATABASE_URL='' bun --bun x vitest run src/routes/telegram-webhook.test.ts
```

Esperado: los tres FAIL. El primero por timeout de Vitest a los 5 s (hoy el `await` cuelga); el segundo con `expected 500 to be 200`; el tercero también por el 500, y si se arreglara solo el status, por el rechazo de `drenar()`.

- [ ] **Step 4: Escribir la implementación**

En `src/routes/telegram-webhook.ts`, reemplazar el bloque que define `responder`:

```ts
    const token = deps.secrets(bot.tokenEnv)
    const responder = (texto: string) =>
      deps.telegram.sendMessage(token, update.chatId, texto)
```

por:

```ts
    const token = deps.secrets(bot.tokenEnv)

    // Las respuestas que origina el webhook salen FUERA del camino síncrono,
    // igual que la entrega. Esperarlas retiene un slot del pool de Telegram
    // (`max_connections`, 40 por defecto) y hace que los mensajes del usuario
    // real hagan cola atrás de los de un desconocido.
    const responder = (texto: string): void => {
      deps.waitUntil(
        // 🚨 El .catch no es decorativo: sendMessage TIRA cuando Telegram
        // rechaza, y el waitUntil de server.ts es `void promesa`, que no
        // captura rejections. Sin esto cada respuesta fallida deja una suelta.
        // Se traga el error a propósito: no hay a quién avisarle de que un
        // desconocido no recibió su pista, y reintentar sería amplificar más.
        deps.telegram
          .sendMessage(token, update.chatId, texto)
          .catch(() => undefined),
      )
    }
```

Cambiar la llamada de la rama de vinculación, que pierde el `await`:

```ts
    const comando = parseCommand(update.text)
    if (comando && COMANDOS_DE_VINCULACION.has(comando.nombre)) {
      responder(await vincular(deps, bot, update.chatId, comando.args))
      return c.json({ ok: true })
    }
```

Y la del chat no vinculado, que también lo pierde:

```ts
    if (!contacto) {
      responder(bot.unlinkedMessage)
      return c.json({ ok: true })
    }
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

```bash
DATABASE_URL='' bun --bun x vitest run src/routes/telegram-webhook.test.ts
```

Esperado: PASS, 22 tests. Los tests viejos que miran `enviados` siguen pasando **sin** `drenar()` porque el doble hace `enviados.push` de forma síncrona, antes del primer `await`.

- [ ] **Step 6: Correr la suite entera, lint y typecheck**

```bash
DATABASE_URL='' bun run test
```

```bash
bun run lint
```

```bash
bun run typecheck
```

Esperado: `263 passed | 20 skipped`, lint y typecheck limpios.

- [ ] **Step 7: Commit**

```bash
git add src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts && git commit -m "fix: la respuesta del webhook sale por waitUntil y ya no retiene el request"
```

---

### Task 5: Aplicar el presupuesto

Una sola regla, sin excepciones: **toda respuesta que el webhook origina consume presupuesto**, con clave `(bot.id, chatId)`. No hace falta un caso especial para vinculados: al usuario vinculado el webhook casi nunca le contesta, sus mensajes van por entrega y sus respuestas por `/v1/messages`, que es otro camino y no está presupuestado.

**Files:**
- Modify: `src/routes/telegram-webhook.ts`
- Test: `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar un `describe` nuevo al final de `src/routes/telegram-webhook.test.ts`:

```ts
describe('presupuesto de respuestas', () => {
  /** Mismo update con otro update_id, para esquivar el dedupe. */
  function updateN(n: number, text = 'hola', chatId = '12345') {
    return { ...update(text, chatId), update_id: n }
  }

  it('deja de contestarle al chat que se pasa del presupuesto', async () => {
    const { server, enviados } = armar({
      presupuesto: crearPresupuesto({
        porVentana: 2,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, updateN(1))
    await postear(server, updateN(2))
    await postear(server, updateN(3))

    expect(enviados).toHaveLength(2)
  })

  it('un /vincular también consume presupuesto', async () => {
    // La regla es única y no tiene excepciones: si /vincular quedara afuera,
    // seguiría habiendo un camino de amplificación sin tope.
    const { server, enviados } = armar({
      presupuesto: crearPresupuesto({
        porVentana: 1,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, updateN(1, '/vincular ZZZZZZ'))
    await postear(server, updateN(2, '/vincular ZZZZZZ'))

    expect(enviados).toHaveLength(1)
  })

  it('chats distintos no se comen el presupuesto entre sí', async () => {
    // Guarda contra la clave equivocada: si se contara por bot en vez de por
    // (bot, chat), el primer desconocido que llegue dejaría sin respuesta a
    // todos los demás, incluido alguien que viene a vincularse de verdad.
    const { server, enviados } = armar({
      presupuesto: crearPresupuesto({
        porVentana: 1,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, updateN(1, 'hola', '111'))
    await postear(server, updateN(2, 'hola', '222'))

    expect(enviados.map((e) => e.chatId)).toEqual(['111', '222'])
  })

  it('el contacto vinculado se entrega igual con el presupuesto agotado', async () => {
    // Guarda contra la implementación equivocada plausible: poner el
    // presupuesto delante de la ENTREGA y no solo de la respuesta. Con
    // porVentana en 0 no sale ninguna respuesta, y la entrega tiene que salir
    // igual.
    const { server, entregados, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      presupuesto: crearPresupuesto({
        porVentana: 0,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, update('banca 4x10 60'))
    await drenar()

    expect(entregados).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

```bash
DATABASE_URL='' bun --bun x vitest run src/routes/telegram-webhook.test.ts
```

Esperado: los dos primeros FAIL, con `expected 3 to be 2` y `expected 2 to be 1`.

Los otros dos **pasan ya**, y está bien que así sea: son guardas contra dos implementaciones equivocadas plausibles (contar por bot en vez de por chat, y poner el presupuesto delante de la entrega). Sin el módulo del presupuesto ni siquiera compilarían, así que no son verdes vacíos, pero no hay que esperar que fallen en este paso.

- [ ] **Step 3: Escribir la implementación**

En `src/routes/telegram-webhook.ts`, dentro de `responder`, agregar la guarda como primera línea del cuerpo:

```ts
    const token = deps.secrets(bot.tokenEnv)
    const claveDePresupuesto = `${bot.id}:${update.chatId}`

    // Las respuestas que origina el webhook salen FUERA del camino síncrono,
    // igual que la entrega. Esperarlas retiene un slot del pool de Telegram
    // (`max_connections`, 40 por defecto) y hace que los mensajes del usuario
    // real hagan cola atrás de los de un desconocido.
    const responder = (texto: string): void => {
      // Toda respuesta que origina el webhook está presupuestada, sin
      // excepciones: /vincular también. Es la única forma de que no quede un
      // camino de amplificación abierto, porque /vincular tiene que poder
      // contestarle a un desconocido para que la vinculación exista.
      if (!deps.presupuesto.consumir(claveDePresupuesto, deps.now())) return

      deps.waitUntil(
        // 🚨 El .catch no es decorativo: sendMessage TIRA cuando Telegram
        // rechaza, y el waitUntil de server.ts es `void promesa`, que no
        // captura rejections. Sin esto cada respuesta fallida deja una suelta.
        // Se traga el error a propósito: no hay a quién avisarle de que un
        // desconocido no recibió su pista, y reintentar sería amplificar más.
        deps.telegram
          .sendMessage(token, update.chatId, texto)
          .catch(() => undefined),
      )
    }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
DATABASE_URL='' bun --bun x vitest run src/routes/telegram-webhook.test.ts
```

Esperado: PASS, 26 tests.

- [ ] **Step 5: Correr la suite entera, lint y typecheck**

```bash
DATABASE_URL='' bun run test
```

```bash
bun run lint
```

```bash
bun run typecheck
```

Esperado: `267 passed | 20 skipped`, lint y typecheck limpios. Los tests viejos siguen en verde porque ninguno manda más de 2 mensajes al mismo chat y el presupuesto por defecto es de 5.

- [ ] **Step 6: Commit**

```bash
git add src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts && git commit -m "feat: presupuestar por chat las respuestas que origina el webhook"
```

---

### Task 6: El crudo solo en las filas entregables

Verificado sobre el código: el único lector de `inbound_messages.raw` es `cuerpoDeEntrega` en `src/delivery/deliver.ts`; `reencolar` filtra por `WHERE ... AND delivery_status = 'failed'`, así que una fila `skipped` no vuelve a `pending` nunca; y el índice parcial del ticker es `WHERE delivery_status = 'pending'`. **El `raw` de una fila `skipped` es dato de solo escritura.**

La fila **se conserva**: es la única telemetría de que alguien encontró el bot.

**Files:**
- Modify: `src/routes/telegram-webhook.ts`
- Test: `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final del `describe('persistencia y entrega', ...)`, antes de la llave que lo cierra:

```ts
  it('no guarda el crudo de un chat no vinculado, pero sí la fila', async () => {
    // El comentario de arriba del insert dice que el crudo se persiste SIEMPRE
    // "si el parser de la app o la entrega fallan". Una fila skipped no se
    // entrega nunca y ningún camino lee su raw, así que esa razón no la cubre.
    // La FILA sí se conserva: es lo único que avisa que alguien encontró el bot.
    const { server, inbound, drenar } = armar()
    await postear(server, update('hola'))
    await drenar()

    const guardado = await inbound.findById('msg-1')
    expect(guardado?.deliveryStatus).toBe('skipped')
    expect(guardado?.text).toBe('hola')
    expect(guardado?.raw).toBeNull()
  })
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
DATABASE_URL='' bun --bun x vitest run src/routes/telegram-webhook.test.ts
```

Esperado: FAIL con `expected { update_id: 1, message: { … } } to be null`.

- [ ] **Step 3: Escribir la implementación**

En `src/routes/telegram-webhook.ts`, reemplazar el comentario y la línea del `raw` dentro de `insertIfNew`:

```ts
    // El crudo se persiste SIEMPRE y antes de cualquier otra cosa para las
    // filas ENTREGABLES: si el parser de la app o la entrega fallan, el dato
    // no se pierde. Una fila `skipped` no entra en esa razón —no se entrega
    // nunca (`reencolar` filtra por 'failed') y ningún camino lee su `raw`—,
    // así que guarda el crudo en null. La FILA sí se conserva: es la única
    // señal de que alguien encontró el bot.
    const guardado = await deps.inbound.insertIfNew({
      botId: bot.id,
      appId: bot.appId,
      channel: 'telegram',
      providerUpdateId: update.updateId,
      externalId: update.chatId,
      appUserId: contacto?.appUserId ?? null,
      text: update.text,
      replyToMessageId: update.replyToMessageId ?? null,
      raw: contacto ? crudo : null,
      deliveryStatus: contacto ? 'pending' : 'skipped',
      nextAttemptAt: contacto ? deps.now() : null,
    })
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
DATABASE_URL='' bun --bun x vitest run src/routes/telegram-webhook.test.ts
```

Esperado: PASS, 27 tests. El test viejo `'guarda el crudo antes de intentar entregar'` sigue en verde porque usa un contacto vinculado.

- [ ] **Step 5: Correr la suite entera, lint y typecheck**

```bash
DATABASE_URL='' bun run test
```

```bash
bun run lint
```

```bash
bun run typecheck
```

Esperado: `268 passed | 20 skipped`, lint y typecheck limpios.

- [ ] **Step 6: Commit**

```bash
git add src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts && git commit -m "feat: no guardar el crudo de las filas que no se entregan nunca"
```

---

### Task 7: Verificar contra base real que el `raw` nulo entra

⚠️ **Esto no se puede asumir.** La columna es `raw jsonb NOT NULL` y el repositorio inserta con `${sql.json(input.raw as Json)}`. Que postgres.js convierta `null` en un JSON `null` (válido) y no en un SQL `NULL` (que violaría el `NOT NULL`) es exactamente el tipo de detalle que pasa en verde en la suite sin base y revienta en producción.

**Files:**
- Test: `src/db/repositories/inbound-messages.integration.test.ts`

- [ ] **Step 1: Escribir el test**

Agregar dentro del `correr('inbound_messages contra una base real', ...)`, después del test `'guarda y devuelve el raw como objeto, no como string'`:

```ts
  it('acepta un raw nulo, que es lo que guardan las filas skipped', async () => {
    // La columna es jsonb NOT NULL. JSON null es un valor válido y distinto de
    // SQL NULL, pero que sql.json(null) produzca uno y no el otro hay que
    // verificarlo contra una base: la suite sin DATABASE_URL no lo ve.
    const creado = await repo.insertIfNew({
      ...base('1010'),
      appUserId: null,
      raw: null,
      deliveryStatus: 'skipped' as const,
      nextAttemptAt: null,
    })
    if (!creado) throw new Error('no se insertó')

    const leido = await repo.findById(creado.id)
    expect(leido?.deliveryStatus).toBe('skipped')
    expect(leido?.raw).toBeNull()
  }, 30_000)
```

- [ ] **Step 2: Correrlo contra la base**

🚨 `bun run test` **NO carga el `.env`**: vitest corre bajo node y no lo ve, así que los tests de integración se saltean **en silencio** y la suite sale verde igual. Hay que pasar la variable explícita. Y 🚨 **la base viva es la del VPS**, no la de Neon, que quedó renombrada a `DATABASE_URL_ROLLBACK`.

La cadena sale del `.env` del stack en el VPS (`/opt/stacks/comm-tool/`), no del `.env` local: ése describe el deploy de Vercel + Neon, que hoy es el **rollback**. Corriendo el test **en el VPS** (`ssh vps`, dentro de `/opt/src/communication-tool`):

```bash
DATABASE_URL="$(grep '^DATABASE_URL=' /opt/stacks/comm-tool/comm-tool.env | cut -d= -f2-)" bun --bun x vitest run src/db/repositories/inbound-messages.integration.test.ts
```

Esperado: PASS. Antes de dar por bueno el resultado, confirmar que el archivo **no se salteó**: la salida tiene que decir `Test Files 1 passed` y no `1 skipped`. Un archivo salteado con la variable puesta significa que no llegó al proceso, y entonces este paso no midió nada.

- [ ] **Step 3: Si falla, aplicar la contingencia**

Si el insert revienta con `null value in column "raw" violates not-null constraint`, entonces postgres.js está produciendo SQL `NULL`. La salida **no** es una migración: es pasar un JSON null explícito. En `src/db/repositories/inbound-messages.ts`, cambiar el bind del `raw` por:

```ts
          ${sql.json((input.raw ?? null) as Json)}::jsonb,
```

y si eso tampoco alcanza, guardar el literal desde el webhook (`raw: contacto ? crudo : {}`) y ajustar en consecuencia los dos tests que esperan `null` (el de la Task 6 y éste), a `toEqual({})`. Dejar anotado en el commit cuál de las dos salió.

- [ ] **Step 4: Confirmar que la suite sin base sigue verde**

```bash
DATABASE_URL='' bun run test
```

Esperado: `268 passed | 21 skipped`, con **4 archivos salteados**. El skipped sube de 20 a 21 porque el test nuevo de integración se saltea con los otros. Si se ven menos de 4 archivos, algo quedó leyendo la variable de entorno.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/inbound-messages.integration.test.ts && git commit -m "test: verificar contra base real que una fila skipped acepta raw nulo"
```

---

### Task 8: Documentar en CLAUDE.md

El `CLAUDE.md` del repo es la fuente de verdad técnica del proyecto. Tres cosas que se pagan caro si se invierten.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Sumar la invariante**

En la sección `## Invariantes`, agregar después del bullet de "Un saliente se reserva antes de mandarse":

```markdown
- **El crudo se guarda solo en las filas entregables.** Una fila `skipped` —un
  mensaje de un chat no vinculado— guarda `raw` nulo. No se entrega nunca
  (`reencolar` filtra por `failed`), no entra en el índice parcial del ticker
  (`WHERE delivery_status = 'pending'`) y su `raw` no lo lee ningún camino: el
  único lector es `cuerpoDeEntrega`. La **fila** sí se conserva, y es la única
  señal de que alguien encontró el bot.
- **Toda respuesta que origina el webhook está presupuestada**, `/vincular`
  incluido: 5 por `(bot, chat)` por hora, contadas en memoria del proceso. 🚨
  Solo cuenta con el deploy self-host del VPS. En el rollback de Vercel cada
  invocación arranca con el mapa vacío y esto degrada a no limitar nada, que es
  lo correcto: degrada, no rompe.
```

- [ ] **Step 2: Sumar el gotcha**

En la sección `## Gotchas del tooling`, agregar al final:

```markdown
- **Una respuesta del webhook no se puede `await`ear.** Sale por `waitUntil` y
  con su propio `.catch`. Dos razones, las dos medidas: esperar a
  api.telegram.org retiene un slot del pool de Telegram (`max_connections`, 40
  por defecto) y hace que los mensajes del usuario real hagan cola atrás de los
  de un desconocido; y `sendMessage` **tira** cuando Telegram rechaza, mientras
  que el `waitUntil` de `server.ts` es `void promesa`, que no captura
  rejections. Sin el `.catch`, cada respuesta fallida deja una suelta.
- **El cliente de Telegram tiene timeout** (`TIMEOUT_TELEGRAM_MS`, 10 s), igual
  que el de entrega. Hasta el 20/09/2026 no lo tenía y un api.telegram.org
  colgado colgaba el request: el webhook retenía el slot y el saliente quedaba
  en `sending` sin marcar.
```

- [ ] **Step 3: Corregir la descripción vieja de la fase 2**

```bash
grep -n "crudo" CLAUDE.md
```

Esperado: además de lo que se acaba de agregar, la línea 100 de la sección de la
fase 2, que dice «el webhook persistiendo el crudo antes del ack». Quedó
incompleta: ajustarla a

```markdown
persistiendo el crudo de los entrantes entregables antes del ack, entrega firmada con HMAC al `delivery_url`
```

Si el grep devuelve alguna otra mención del crudo que afirme que se guarda
siempre, ajustarla también.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md && git commit -m "docs: el presupuesto de respuestas, el crudo acotado y el timeout de Telegram"
```

---

## Verificación final

- [ ] **Suite completa sin base, como corre CI**

```bash
DATABASE_URL='' bun run test
```

Esperado: `Test Files 31 passed | 4 skipped (35)` y `Tests 268 passed | 21 skipped (289)`.

- [ ] **Lint**

```bash
bun run lint
```

- [ ] **Typecheck**

```bash
bun run typecheck
```

- [ ] **Build de Vercel, que es lo que detecta el entrypoint roto**

```bash
bun --bun x vercel build --yes
```

Después, confirmar el handler:

```bash
cat .vercel/output/functions/index.func/.vc-config.json
```

Esperado: `"handler": "src/index.js"`. Si dice otra cosa, el preset eligió mal el entrypoint.

- [ ] **Revisar los commits**

```bash
git log --oneline origin/main..HEAD
```

Esperado: 8 commits chicos, sin líneas `Co-Authored-By`.

## Después del merge, y es de Juan

Nada de esto lo hace el agente:

1. **Deploy al VPS**: `ssh vps`, `cd /opt/src/communication-tool && git pull`, y después `cd /opt/stacks/comm-tool && docker compose build app && docker compose up -d app`.
2. **Verificación contra producción**, que es lo único que cierra el trabajo:
   - Mandarle un mensaje al bot desde un chat **no vinculado** y confirmar en la base que quedó `delivery_status = 'skipped'` y `raw` nulo.
   - Mandarle seis seguidos desde ese mismo chat y confirmar que llegan cinco respuestas, no seis.
   - Mandar un mensaje desde el chat **vinculado** y confirmar que la serie se registra: es el circuito del gimnasio y está en el camino crítico.

```sql
SELECT external_id, delivery_status, raw IS NULL AS sin_crudo, received_at
FROM inbound_messages ORDER BY received_at DESC LIMIT 10;
```

3. 🚨 **`setWebhook` no se toca en ningún momento.** Este trabajo no cambia el registro. Si después del deploy un entrante "no llega", lo primero es mirar el webhook (`bun run scripts/ver-webhook.ts`), no el código.
