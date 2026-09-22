# Transporte interactivo: botones, toques y edición — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que comm-tool pueda mandar mensajes con botones inline, entregar a la app cada toque de un botón (`callback_query`) y editar un mensaje que ya mandó, sin entender qué significa ningún botón.

**Architecture:** Tres mecánicas nuevas de transporte. (1) `POST /v1/messages` acepta `buttons` y los guarda en la fila del saliente. (2) El webhook lee `callback_query`, lo contesta en el acto con `answerCallbackQuery` y lo guarda y entrega como un entrante de `kind = 'callback'`. (3) `POST /v1/messages/edit` edita un mensaje propio resolviendo el `chat_id` por el contacto. El contrato del cliente suma todo como **opcional** y sale como `v0.3.0`: GymTracker sigue en `v0.2.0` sin tocar nada.

**Tech Stack:** Bun, Hono, TypeScript (`module: nodenext`), Vitest, postgres.js, zod 4.

**Spec:** vive en **study-master**, porque el frente es de los dos repos:
`docs/superpowers/specs/2026-09-22-bot-de-telegram-interactivo-design.md`, rama
`claude/telegram-interactive-messaging-120560`
([GitHub](https://github.com/juanandresdavila/study-master/blob/claude/telegram-interactive-messaging-120560/docs/superpowers/specs/2026-09-22-bot-de-telegram-interactivo-design.md)).
Este plan cubre su §1 y la parte de comm-tool de §Verificación y §Orden. El de
StudyMaster es otro plan y va **después**: no se puede probar de punta a punta
sin el `v0.3.0` de este.

---

## Antes de empezar

Trabajar en el worktree `.claude/worktrees/transporte-interactivo` (rama
`claude/transporte-interactivo`, creada desde `origin/main` = `6aedeaf`). 🚨 **El
checkout principal de comm-tool está en otra rama con commits sin pushear**
(`claude/claude-md-urls-vps-y-raw-json-null`): no tocarlo.

Línea base, que hay que reproducir antes de tocar nada:

```bash
DATABASE_URL='' bun run test
```

Esperado: `Test Files 31 passed | 4 skipped (35)` y `Tests 268 passed | 21 skipped (289)`.

Reglas del repo que muerden en este plan:

- 🚨 **Los imports relativos llevan `.js` siempre**, aunque el archivo sea `.ts`. `bun run typecheck` lo detecta.
- 🚨 **Todo commit que toque `src/client/` lleva el `dist/` rebuildeado** (`bun run build:client`) en el mismo commit. CI corre `git diff --exit-code dist` y falla si quedó desincronizado.
- 🚨 **`src/client/` no puede importar nada de fuera de `src/client/`** (lo afirma `src/client/paquete.test.ts`). Al revés sí: el servicio importa `Button` de `../client/types.js`, como `deliver.ts` ya importa `../client/signature.js`.
- **No encadenar las verificaciones con pipes**: `bun run lint | tail` devuelve el exit code de `tail`. Comandos sueltos.
- **Commits sin `Co-Authored-By`** y sin líneas de autoría de IA (`CLAUDE.md`).
- **Zod 4 se importa como namespace**: `import * as z from 'zod'`.

### Lo que el relevamiento encontró y conviene tener a mano

- 🚨 **El `data` de un toque puede traer cualquier cosa.** La doc de `CallbackQuery.data` (Bot API 10.3) dice: *«Be aware that the message originated the query can contain no callback buttons with this data»*. El update es auténtico (viene de Telegram, con el secreto del webhook), pero el `data` no está garantizado. comm-tool lo trata como **opaco** y lo pasa tal cual; la app lo valida.
- **`answerCallbackQuery` es obligatorio**: *«Telegram clients will display a progress bar until you call answerCallbackQuery. It is, therefore, necessary to react by calling answerCallbackQuery even if no notification to the user is needed»*.
- **`callback_data`: «1-64 bytes»**. Bytes, no caracteres.
- **La Bot API no publica un límite de botones por mensaje** (buscado el 22/09/2026). El tope de 100 de este plan es propio.
- **Un toque puede llegar sin `message`** (botón de un mensaje inline) **o sin `data`** (juegos). comm-tool no manda ninguno de los dos, así que esos se descartan como hoy.
- **El `message` de un toque puede ser «inaccesible»** (`MaybeInaccessibleMessage`, con `date: 0`), pero igual trae `chat` y `message_id`, que es lo único que se lee.
- ⚠️ **El texto del error de Telegram al editar sin cambios («message is not modified») NO está en la doc.** Se matchea con `/message is not modified/i` y se confirma con una llamada real en la Task 12.

## Estructura de archivos

| Archivo | Responsabilidad | Task |
|---|---|---|
| `src/client/types.ts` | El contrato: `Button`, `buttons`, `callback`, `EditMessage`, `editMessage?` | 1 |
| `src/channels/telegram/types.ts` | `UpdateNormalizado` pasa a ser unión: mensaje o toque | 2 |
| `src/channels/telegram/parse-update.ts` | Lee `callback_query` | 2 |
| `src/routes/telegram-webhook.ts` | Narrowing provisorio (2); toques y `/start <código>` (7) | 2, 7 |
| `src/channels/telegram/client.ts` | `reply_markup`, `answerCallbackQuery`, `editMessageText` | 3 |
| `src/test-support/fake-telegram.ts` | **nuevo**: `telegramFalso()`, un cliente que no hace nada | 3 |
| seis dobles de Telegram en tests | pasan a partir de `telegramFalso()` | 3 |
| `migrations/0005_interactivo.sql` | **nuevo**: columnas de toques y de botones | 4 |
| `src/db/ports.ts` | `InboundKind`, campos nuevos de entrantes y salientes | 4, 5 |
| `src/db/repositories/inbound-messages.ts` + fake + integración | guardan y leen los toques | 4 |
| `src/db/repositories/outbound-messages.ts` + fake + integración | guardan y leen los botones | 5 |
| `src/outbound/send.ts` | los botones viajan en la fila y a Telegram | 5 |
| `src/mcp/tools.ts` | pasa `buttons: null` | 5 |
| `src/delivery/deliver.ts` | `callback` en el cuerpo de la entrega | 6 |
| `src/outbound/botones.ts` | **nuevo**: validación de un teclado | 8 |
| `src/routes/messages.ts` | `buttons` en `/v1/messages` (8) y la ruta `/v1/messages/edit` (9) | 8, 9 |
| `src/outbound/edit.ts` | **nuevo**: `editarSaliente` | 9 |
| `src/client/index.ts` + `dist/` | el cliente `v0.3.0` | 10 |
| `CLAUDE.md` | estado, invariantes y operación | 11 |

---

### Task 1: El contrato suma botones, toques y edición

Sólo tipos. Todo opcional, para que GymTracker siga en `v0.2.0` sin tocar nada.

**Files:**
- Modify: `src/client/types.ts`
- Modify (generado): `dist/client/types.d.ts`

- [ ] **Step 1: Reemplazar el comentario de cabecera de `src/client/types.ts`**

El comentario actual dice que el archivo es *el MISMO* que el de GymTracker. Desde `v0.3.0` eso deja de ser cierto hasta que GymTracker actualice, y está bien. Reemplazar el bloque que empieza con `/**\n * El contrato de mensajería del spec` por:

```ts
/**
 * El contrato de mensajería del spec, §El contrato. Nació como el MISMO
 * archivo que vive en `src/lib/messaging/types.ts` de GymTracker y de Study
 * Master, y que no se separen en lo obligatorio es lo que verifica la suite de
 * conformidad.
 *
 * Desde `v0.3.0` las copias pueden diferir en lo OPCIONAL: botones, toques y
 * edición entraron así a propósito, para que una app que no los usa se quede
 * en la versión anterior sin tocar nada.
 *
 * Este archivo no importa nada, ni siquiera de este repo. Es la raíz de que el
 * paquete sea delgado.
 */
```

- [ ] **Step 2: Agregar `Button` después de `export type Channel = ...`**

```ts
/**
 * Un botón de un teclado inline. Exactamente uno de `data` o `url`.
 *
 * `data` vuelve en `IncomingMessage.callback.data` cuando alguien lo toca. Son
 * de 1 a 64 BYTES UTF-8, no caracteres: un emoji ocupa 4.
 *
 * 🚨 Lo que vuelve puede no ser ninguno de los `data` que mandaste. La doc de
 * Telegram lo avisa (*«the message originated the query can contain no
 * callback buttons with this data»*): validalo siempre, como cualquier entrada.
 */
export interface Button {
  text: string
  data?: string
  url?: string
}
```

- [ ] **Step 3: Agregar `callback` al final de `IncomingMessage`**

Después de `raw: unknown`:

```ts
  /**
   * Presente cuando la entrega es un TOQUE de un botón y no un mensaje, y
   * entonces `text` llega como `""`. `messageId` es el id del proveedor del
   * mensaje que tenía el botón: el mismo que devolvió `sendMessage`, así que
   * sirve para editarlo.
   */
  callback?: { data: string; messageId: string }
```

- [ ] **Step 4: Agregar `buttons` al final de `OutgoingMessage`**

Después de `idempotencyKey?: string`:

```ts
  /**
   * Filas de botones inline. Con `idempotencyKey`, un reintento reenvía los
   * botones de la primera vez, igual que el texto.
   */
  buttons?: Button[][]
```

- [ ] **Step 5: Agregar `EditMessage` y `editMessage?` a `Messaging`**

Antes de `export interface Messaging`:

```ts
export interface EditMessage {
  userId: string
  /** El id DEL PROVEEDOR: el que devolvió `sendMessage`. */
  messageId: string
  text: string
  /** Sin botones, el teclado que tenía el mensaje se saca. */
  buttons?: Button[][]
}
```

Y dentro de `Messaging`, después de `parseIncoming`:

```ts
  /**
   * Edita un mensaje que el bot ya mandó. Opcional porque el transporte de
   * Telegram directo de GymTracker no lo implementa, y no lo necesita.
   */
  editMessage?(msg: EditMessage): Promise<void>
```

- [ ] **Step 6: Rebuildear el paquete y verificar**

```bash
bun run build:client
bun run typecheck
DATABASE_URL='' bun run test
```

Esperado: typecheck limpio, la suite igual que la línea base (268 / 21), y `git status` mostrando `dist/client/types.d.ts` modificado. `types.js` no cambia: son sólo tipos.

- [ ] **Step 7: Commit**

```bash
git add src/client/types.ts dist/client/types.d.ts
git commit -m "feat(client): el contrato suma botones, toques y editar un mensaje

Todo opcional: una app que no los usa se queda en v0.2.0 sin tocar nada."
```

---

### Task 2: El parser lee los toques

**Files:**
- Modify: `src/channels/telegram/types.ts`
- Modify: `src/channels/telegram/parse-update.ts`
- Modify: `src/channels/telegram/parse-update.test.ts`
- Modify: `src/routes/telegram-webhook.ts` (narrowing provisorio)

- [ ] **Step 1: Escribir los tests que fallan**

En `src/channels/telegram/parse-update.test.ts`, el primer caso pasa a esperar el `tipo`:

```ts
  it('extrae chat, texto e ids de un mensaje de texto', () => {
    expect(parseTelegramUpdate(MENSAJE_DE_TEXTO)).toEqual({
      tipo: 'message',
      updateId: '900001',
      chatId: '12345',
      messageId: '42',
      text: 'banca 4x10 60',
      replyToMessageId: undefined,
    })
  })
```

Y agregar, dentro de `describe('parseTelegramUpdate', ...)`, antes de `it('ignora updates sin mensaje'`:

```ts
  const TOQUE = {
    update_id: 900_010,
    callback_query: {
      id: '4382bfdwdsb323b2d9',
      from: { id: 12345, is_bot: false, first_name: 'Juan' },
      message: {
        message_id: 77,
        from: { id: 999, is_bot: true, first_name: 'Study' },
        chat: { id: 12345, type: 'private' },
        date: 1_785_264_000,
        text: '¿Lo guardo como…?',
      },
      chat_instance: '-123',
      data: 's1:k3Jd9aQ2xZ:t:examen',
    },
  }

  it('extrae un toque: chat, mensaje del bot, id del toque y data', () => {
    expect(parseTelegramUpdate(TOQUE)).toEqual({
      tipo: 'callback',
      updateId: '900010',
      chatId: '12345',
      // El mensaje del BOT que tenía el botón, no uno del usuario.
      messageId: '77',
      callbackId: '4382bfdwdsb323b2d9',
      data: 's1:k3Jd9aQ2xZ:t:examen',
    })
  })

  it('lee el toque aunque el mensaje del bot ya sea inaccesible', () => {
    // MaybeInaccessibleMessage: sin texto y con date 0, pero con chat y
    // message_id, que es lo único que hace falta.
    const inaccesible = {
      ...TOQUE,
      callback_query: {
        ...TOQUE.callback_query,
        message: { message_id: 77, chat: { id: 12345, type: 'private' }, date: 0 },
      },
    }
    expect(parseTelegramUpdate(inaccesible)).toMatchObject({
      tipo: 'callback',
      chatId: '12345',
      messageId: '77',
    })
  })

  it('ignora un toque sin data, que es de un juego', () => {
    expect(
      parseTelegramUpdate({
        update_id: 900_011,
        callback_query: { ...TOQUE.callback_query, data: undefined },
      }),
    ).toBeNull()
  })

  it('ignora un toque sin message, que es de un mensaje inline', () => {
    expect(
      parseTelegramUpdate({
        update_id: 900_012,
        callback_query: {
          ...TOQUE.callback_query,
          message: undefined,
          inline_message_id: 'abc',
        },
      }),
    ).toBeNull()
  })
```

El caso existente `'ignora updates sin mensaje'` (`callback_query: { id: 'x' }`) **se queda igual**: un toque sin `data` ni `message` sigue siendo null.

- [ ] **Step 2: Correr y verificar que fallan**

```bash
DATABASE_URL='' bun run test src/channels/telegram/parse-update.test.ts
```

Esperado: FAIL en el primer caso (falta `tipo`) y en el del toque (devuelve null).

- [ ] **Step 3: Reemplazar `UpdateNormalizado` en `src/channels/telegram/types.ts`**

```ts
interface UpdateBase {
  updateId: string
  chatId: string
  /**
   * En un mensaje, el del usuario. En un toque, el del BOT que tenía el
   * botón: es el que se edita después.
   */
  messageId: string
}

export interface UpdateDeMensaje extends UpdateBase {
  tipo: 'message'
  text: string
  replyToMessageId: string | undefined
}

export interface UpdateDeToque extends UpdateBase {
  tipo: 'callback'
  /** Lo que hay que pasarle a `answerCallbackQuery`. */
  callbackId: string
  /** Opaco para comm-tool, y puede no ser el de ningún botón nuestro. */
  data: string
}

/** Forma normalizada de un update, independiente del proveedor. */
export type UpdateNormalizado = UpdateDeMensaje | UpdateDeToque
```

`Comando` queda igual.

- [ ] **Step 4: Reescribir `parseTelegramUpdate` en `src/channels/telegram/parse-update.ts`**

Reemplazar el import y la función (dejar `esObjeto` y `parseCommand` como están):

```ts
import type {
  Comando,
  UpdateDeMensaje,
  UpdateDeToque,
  UpdateNormalizado,
} from './types.js'
```

```ts
export function parseTelegramUpdate(crudo: unknown): UpdateNormalizado | null {
  if (!esObjeto(crudo)) return null

  const updateId = crudo['update_id']
  if (typeof updateId !== 'number') return null

  const message = crudo['message']
  if (esObjeto(message)) return mensaje(String(updateId), message)

  const toque = crudo['callback_query']
  if (esObjeto(toque)) return callback(String(updateId), toque)

  return null
}

function idDeChat(chat: unknown): string | null {
  if (!esObjeto(chat)) return null
  const id = chat['id']
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null
}

function mensaje(
  updateId: string,
  message: Record<string, unknown>,
): UpdateDeMensaje | null {
  const chatId = idDeChat(message['chat'])
  const messageId = message['message_id']
  if (chatId === null || typeof messageId !== 'number') return null

  const replyTo = message['reply_to_message']
  const replyToId = esObjeto(replyTo) ? replyTo['message_id'] : undefined

  return {
    tipo: 'message',
    updateId,
    chatId,
    messageId: String(messageId),
    // Un mensaje sin texto (foto, audio) llega con text vacío y no se
    // descarta: el spec dice que la app decide qué hacer con él.
    text: typeof message['text'] === 'string' ? message['text'] : '',
    replyToMessageId:
      typeof replyToId === 'number' ? String(replyToId) : undefined,
  }
}

function callback(
  updateId: string,
  toque: Record<string, unknown>,
): UpdateDeToque | null {
  const id = toque['id']
  const data = toque['data']
  const message = toque['message']
  // Sin `message`, el botón era de un mensaje inline y no hay chat al que
  // resolver. Sin `data`, es un juego. comm-tool no manda ninguno de los dos.
  if (typeof id !== 'string' || typeof data !== 'string' || !esObjeto(message)) {
    return null
  }

  // Un mensaje "inaccesible" (date 0) igual trae chat y message_id.
  const chatId = idDeChat(message['chat'])
  const messageId = message['message_id']
  if (chatId === null || typeof messageId !== 'number') return null

  return {
    tipo: 'callback',
    updateId,
    chatId,
    messageId: String(messageId),
    callbackId: id,
    data,
  }
}
```

- [ ] **Step 5: Narrowing provisorio en el webhook**

`src/routes/telegram-webhook.ts` usa `update.text`, que ya no existe en la unión. Hasta la Task 7 los toques se siguen descartando como hoy. Reemplazar:

```ts
    const update = parseTelegramUpdate(crudo)
    // Un update que no sabemos leer (callback_query, edición, encuesta) se
    // acepta y se descarta: devolverle un error a Telegram provocaría
    // reintentos eternos de algo que nunca vamos a poder procesar.
    if (!update) return c.json({ ok: true })
```

por:

```ts
    const update = parseTelegramUpdate(crudo)
    // Un update que no sabemos leer (edición, encuesta) se acepta y se
    // descarta: devolverle un error a Telegram provocaría reintentos eternos
    // de algo que nunca vamos a poder procesar.
    if (!update) return c.json({ ok: true })
    // Provisorio: los toques se descartan hasta que el webhook los procese.
    if (update.tipo !== 'message') return c.json({ ok: true })
```

- [ ] **Step 6: Correr todo**

```bash
bun run typecheck
DATABASE_URL='' bun run test
```

Esperado: typecheck limpio; la suite verde con **4 tests más** que la línea base.

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram/types.ts src/channels/telegram/parse-update.ts src/channels/telegram/parse-update.test.ts src/routes/telegram-webhook.ts
git commit -m "feat(telegram): el parser lee los toques de los botones

Un toque sin data (juego) o sin message (mensaje inline) se sigue descartando:
comm-tool no manda ninguno de los dos. El webhook todavía los ignora."
```

---

### Task 3: El cliente de Telegram aprende botones, contestar un toque y editar

**Files:**
- Modify: `src/channels/telegram/client.ts`
- Modify: `src/channels/telegram/client.test.ts`
- Create: `src/test-support/fake-telegram.ts`
- Modify: `src/test-support/fake-deps.ts`, `src/routes/telegram-webhook.test.ts`, `src/routes/messages.test.ts`, `src/outbound/send.test.ts`, `src/mcp/tools.test.ts`, `src/routes/mcp.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `describe('createTelegramClient', ...)` en `src/channels/telegram/client.test.ts`:

```ts
  it('manda los botones como reply_markup inline', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 82 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', '¿Lo guardo como…?', null, [
      [
        { text: 'Tarea', data: 's1:abc:t:tarea' },
        { text: 'Nota', data: 's1:abc:t:nota' },
      ],
      [{ text: 'Abrir', url: 'https://study.jadd.com.ar' }],
    ])

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: '¿Lo guardo como…?',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Tarea', callback_data: 's1:abc:t:tarea' },
            { text: 'Nota', callback_data: 's1:abc:t:nota' },
          ],
          [{ text: 'Abrir', url: 'https://study.jadd.com.ar' }],
        ],
      },
    })
  })

  it('no manda reply_markup sin botones', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 83 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.sendMessage('TOKEN', '12345', 'hola', null, null)

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('contesta un toque con answerCallbackQuery', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, { ok: true, result: true })
    const cliente = createTelegramClient(fake)

    await cliente.answerCallbackQuery('TOKEN', 'cb-1')

    expect(llamadas[0]?.url).toBe(
      'https://api.telegram.org/botTOKEN/answerCallbackQuery',
    )
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      callback_query_id: 'cb-1',
    })
    expect(llamadas[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('edita un mensaje con texto y botones nuevos', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 77 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.editMessageText('TOKEN', '12345', '77', '¿En qué proyecto?', [
      [{ text: 'Redes', data: 's1:abc:p:0' }],
    ])

    expect(llamadas[0]?.url).toBe(
      'https://api.telegram.org/botTOKEN/editMessageText',
    )
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      message_id: 77,
      text: '¿En qué proyecto?',
      reply_markup: {
        inline_keyboard: [[{ text: 'Redes', callback_data: 's1:abc:p:0' }]],
      },
    })
  })

  it('al editar sin botones manda un teclado vacío, que saca el que había', async () => {
    // Explícito a propósito: omitir reply_markup también lo saca según la
    // práctica común, pero la doc no lo dice, y un teclado vacío no deja dudas.
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 77 },
    })
    const cliente = createTelegramClient(fake)

    await cliente.editMessageText('TOKEN', '12345', '77', '✅ Guardado', null)

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toMatchObject({
      reply_markup: { inline_keyboard: [] },
    })
  })

  it('al editar, un rechazo de Telegram nombra el método y no el token', async () => {
    const { fake } = fetchQueDevuelve(400, {
      ok: false,
      description: 'Bad Request: message is not modified',
    })
    const cliente = createTelegramClient(fake)

    const intento = cliente.editMessageText('TOKEN_SECRETO', '1', '7', 'x', null)

    await expect(intento).rejects.toThrow(
      /editMessageText: Bad Request: message is not modified/,
    )
    await expect(intento).rejects.toThrow(/^(?!.*TOKEN_SECRETO).*$/s)
  })
```

- [ ] **Step 2: Correr y verificar que fallan**

```bash
DATABASE_URL='' bun run test src/channels/telegram/client.test.ts
```

Esperado: FAIL (`answerCallbackQuery is not a function`, y el body sin `reply_markup`).

- [ ] **Step 3: Reescribir `src/channels/telegram/client.ts`**

Dejar `Fetch`, `TIMEOUT_TELEGRAM_MS` y `replyParameters` como están. Reemplazar la interfaz y `createTelegramClient`, y agregar el import y `tecladoInline`:

```ts
import type { Button } from '../../client/types.js'

export interface TelegramClient {
  sendMessage(
    token: string,
    chatId: string,
    text: string,
    replyToMessageId?: string | null,
    botones?: Button[][] | null,
  ): Promise<{ messageId: string }>
  /**
   * Obligatorio después de cada toque, aunque no haya nada que avisar: sin él
   * el botón queda con la barrita de carga (doc de la Bot API).
   */
  answerCallbackQuery(token: string, callbackId: string): Promise<void>
  editMessageText(
    token: string,
    chatId: string,
    messageId: string,
    text: string,
    botones?: Button[][] | null,
  ): Promise<void>
}
```

```ts
/**
 * `Button` del contrato → `InlineKeyboardButton` de Telegram. La validación
 * (exactamente uno de data o url, los 64 bytes) es de la ruta, no de acá.
 */
export function tecladoInline(botones: Button[][]): {
  inline_keyboard: Record<string, string>[][]
} {
  return {
    inline_keyboard: botones.map((fila) =>
      fila.map((b) =>
        b.url !== undefined
          ? { text: b.text, url: b.url }
          : { text: b.text, callback_data: b.data ?? '' },
      ),
    ),
  }
}

export function createTelegramClient(
  fetchImpl: Fetch = fetch,
  timeoutMs: number = TIMEOUT_TELEGRAM_MS,
): TelegramClient {
  async function llamar(
    token: string,
    metodo: string,
    cuerpo: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const respuesta = (await res.json().catch(() => null)) as {
      ok?: boolean
      result?: unknown
      description?: string
    } | null

    if (!res.ok || respuesta?.ok !== true) {
      // El token va en la URL: nunca se incluye el detalle de la request en
      // el error, solo la descripción que devuelve Telegram.
      throw new Error(
        `Telegram rechazó ${metodo}: ${respuesta?.description ?? res.status}`,
      )
    }

    return respuesta.result
  }

  return {
    async sendMessage(token, chatId, text, replyToMessageId, botones) {
      const resultado = (await llamar(token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...replyParameters(replyToMessageId),
        ...(botones && botones.length > 0
          ? { reply_markup: tecladoInline(botones) }
          : {}),
      })) as { message_id?: number } | undefined

      return { messageId: String(resultado?.message_id ?? '') }
    },

    async answerCallbackQuery(token, callbackId) {
      await llamar(token, 'answerCallbackQuery', {
        callback_query_id: callbackId,
      })
    },

    async editMessageText(token, chatId, messageId, text, botones) {
      await llamar(token, 'editMessageText', {
        chat_id: chatId,
        // La ruta valida que sea un entero; Telegram lo pide así.
        message_id: Number(messageId),
        text,
        // Siempre explícito: sin botones, un teclado vacío saca el que había.
        reply_markup: tecladoInline(botones ?? []),
      })
    },
  }
}
```

⚠️ Los dos tests viejos de error (`'falla si Telegram responde con error'` y `'no incluye el token'`) siguen pasando: el mensaje pasa de `Telegram rechazó sendMessage: …` a lo mismo, porque `metodo` es `sendMessage`.

- [ ] **Step 4: Crear `src/test-support/fake-telegram.ts`**

```ts
import type { TelegramClient } from '../channels/telegram/client.js'

/**
 * Un cliente de Telegram que no hace nada. Cada test pisa sólo lo que mide:
 *
 *     const telegram: TelegramClient = {
 *       ...telegramFalso(),
 *       async sendMessage() { ... },
 *     }
 */
export function telegramFalso(): TelegramClient {
  return {
    async sendMessage() {
      return { messageId: '1' }
    },
    async answerCallbackQuery() {},
    async editMessageText() {},
  }
}
```

- [ ] **Step 5: Adaptar los seis dobles de Telegram**

`bun run typecheck` los lista: les faltan los dos métodos nuevos. En cada uno, agregar el import de `telegramFalso` y el spread **como primera línea del objeto**, sin tocar el resto:

- `src/test-support/fake-deps.ts`: reemplazar el objeto `telegram: { async sendMessage() { return { messageId: '1' } } },` por `telegram: telegramFalso(),`. Import: `import { telegramFalso } from './fake-telegram.js'`.
- `src/routes/telegram-webhook.test.ts`: en `armar`, `telegram: {` pasa a `telegram: {\n        ...telegramFalso(),`. Import: `import { telegramFalso } from '../test-support/fake-telegram.js'`.
- `src/routes/messages.test.ts`, `src/outbound/send.test.ts`, `src/mcp/tools.test.ts` y `src/routes/mcp.test.ts`: `const telegram: TelegramClient = {` pasa a `const telegram: TelegramClient = {\n    ...telegramFalso(),`. Import: `import { telegramFalso } from '../test-support/fake-telegram.js'`.

- [ ] **Step 6: Correr todo**

```bash
bun run typecheck
bun run lint
DATABASE_URL='' bun run test
```

Esperado: limpio, y la suite verde con **6 tests más** que al terminar la Task 2.

- [ ] **Step 7: Mutación: el teclado vacío**

Cambiar `reply_markup: tecladoInline(botones ?? [])` por `...(botones ? { reply_markup: tecladoInline(botones) } : {})` y correr `DATABASE_URL='' bun run test src/channels/telegram/client.test.ts`. Esperado: rojo en `'al editar sin botones manda un teclado vacío'`.

Deshacer la mutación **a mano**, no con `git checkout --`: el archivo todavía no está commiteado, y el checkout se llevaría también la implementación. Vale para todas las mutaciones de este plan. Volver a correr en verde.

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram/client.ts src/channels/telegram/client.test.ts src/test-support/fake-telegram.ts src/test-support/fake-deps.ts src/routes/telegram-webhook.test.ts src/routes/messages.test.ts src/outbound/send.test.ts src/mcp/tools.test.ts src/routes/mcp.test.ts
git commit -m "feat(telegram): botones inline, answerCallbackQuery y editMessageText

Los tres métodos pasan por el mismo llamar(), con el timeout y sin el token en
el error. Editar sin botones manda un teclado vacío a propósito: la doc no
dice qué pasa si se omite."
```

---

### Task 4: La migración `0005` y los entrantes que son toques

**Files:**
- Create: `migrations/0005_interactivo.sql`
- Modify: `src/db/ports.ts`
- Modify: `src/db/repositories/inbound-messages.ts`
- Modify: `src/test-support/fake-repos.ts` (`unMensaje`, `createFakeInboundMessagesRepo`)
- Modify: `src/db/repositories/inbound-messages.integration.test.ts`

- [ ] **Step 1: Escribir la migración**

`migrations/0005_interactivo.sql`:

```sql
-- Transporte interactivo: un entrante puede ser el TOQUE de un botón y no un
-- mensaje, y un saliente puede llevar botones.
--
-- Aditiva: el código anterior no ve las columnas nuevas y los defaults cubren
-- sus inserts, así que se aplica ANTES de levantar el código nuevo y el
-- rollback de la imagen no necesita revertirla.

ALTER TABLE inbound_messages
  ADD COLUMN kind text NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'callback')),
  -- Opaco para comm-tool: lo que Telegram mande, tal cual. Puede no ser el de
  -- ningún botón nuestro (la doc de CallbackQuery.data lo avisa).
  ADD COLUMN callback_data text,
  -- El id DEL PROVEEDOR del mensaje del bot que tenía el botón.
  ADD COLUMN callback_message_id text;

-- Un toque sin data o sin mensaje no se puede entregar: que la base no lo
-- acepte en vez de descubrirlo al armar la entrega.
ALTER TABLE inbound_messages
  ADD CONSTRAINT inbound_callback_completo
    CHECK (kind = 'message'
           OR (callback_data IS NOT NULL AND callback_message_id IS NOT NULL));

-- Nullable y con SQL NULL de verdad: un saliente sin botones no tiene teclado.
-- Hace falta en la FILA porque enviarSaliente manda lo que dice la fila y no
-- lo que dice el pedido: sin la columna, un reintento idempotente reenviaría
-- el mensaje sin botones.
ALTER TABLE outbound_messages
  ADD COLUMN buttons jsonb;
```

- [ ] **Step 2: Levantar un Postgres descartable y aplicarla dos veces**

🚨 Nunca contra la base de producción. Docker.app puede estar apagado:

```bash
open -a Docker
docker version --format '{{.Server.Version}}'
```

Repetir el segundo comando hasta que conteste una versión. Después:

```bash
docker run -d --name ct-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:18-alpine
DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/postgres' bun run db:migrate
DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/postgres' bun run db:migrate
```

Esperado: la primera termina en `Listo. 5 migración(es) aplicada(s).` y la segunda dice `Sin migraciones pendientes (5 aplicadas).` Si la primera falla con conexión rechazada, el contenedor todavía arranca: esperar unos segundos y reintentar. `postgres:18` es la versión del VPS.

- [ ] **Step 3: Escribir los tests de integración que fallan**

Agregar al final de `correr('inbound_messages contra una base real', ...)` en `src/db/repositories/inbound-messages.integration.test.ts`:

```ts
  it('guarda un toque con su data y el mensaje del bot', async () => {
    const creado = await repo.insertIfNew({
      ...base('1020'),
      text: '',
      kind: 'callback',
      callbackData: 's1:abc:t:tarea',
      callbackMessageId: '77',
    })
    if (!creado) throw new Error('no se insertó')

    const leido = await repo.findById(creado.id)
    expect(leido?.kind).toBe('callback')
    expect(leido?.callbackData).toBe('s1:abc:t:tarea')
    expect(leido?.callbackMessageId).toBe('77')
  }, 30_000)

  it('un entrante sin kind queda como mensaje y sin data', async () => {
    const creado = await repo.insertIfNew(base('1021'))
    if (!creado) throw new Error('no se insertó')

    expect(creado.kind).toBe('message')
    expect(creado.callbackData).toBeNull()
    expect(creado.callbackMessageId).toBeNull()
  }, 30_000)

  it('la base rechaza un toque sin data', async () => {
    await expect(
      repo.insertIfNew({
        ...base('1022'),
        kind: 'callback',
        callbackData: null,
        callbackMessageId: '77',
      }),
    ).rejects.toThrow(/inbound_callback_completo/)
  }, 30_000)
```

- [ ] **Step 4: Ampliar los puertos**

En `src/db/ports.ts`, antes de `export interface InboundMessage`:

```ts
export type InboundKind = 'message' | 'callback'
```

En `InboundMessage`, después de `replyToMessageId: string | null`:

```ts
  kind: InboundKind
  /** Sólo en un toque. Opaco: puede no ser el de ningún botón nuestro. */
  callbackData: string | null
  /** Sólo en un toque: el id del proveedor del mensaje que tenía el botón. */
  callbackMessageId: string | null
```

En el `input` de `insertIfNew`, después de `replyToMessageId: string | null`:

```ts
    /** Default `'message'`: un mensaje no tiene por qué nombrarlo. */
    kind?: InboundKind
    callbackData?: string | null
    callbackMessageId?: string | null
```

- [ ] **Step 5: El repositorio real**

En `src/db/repositories/inbound-messages.ts`:

- importar `InboundKind` junto a los demás tipos de `../ports.js`;
- sumar a `interface Fila`: `kind: string`, `callback_data: string | null`, `callback_message_id: string | null`;
- sumar a `aMensaje`, después de `replyToMessageId: f.reply_to_message_id,`:

```ts
    kind: f.kind as InboundKind,
    callbackData: f.callback_data,
    callbackMessageId: f.callback_message_id,
```

- y reemplazar el `INSERT` de `insertIfNew` por:

```ts
      const filas = (await sql`
        INSERT INTO inbound_messages (
          bot_id, app_id, channel, provider_update_id, external_id,
          app_user_id, text, reply_to_message_id, raw, delivery_status,
          next_attempt_at, kind, callback_data, callback_message_id
        ) VALUES (
          ${input.botId}, ${input.appId}, ${input.channel},
          ${input.providerUpdateId}, ${input.externalId}, ${input.appUserId},
          ${input.text}, ${input.replyToMessageId},
          ${rawParaBind(sql, input.raw)}, ${input.deliveryStatus},
          ${input.nextAttemptAt?.toISOString() ?? null},
          ${input.kind ?? 'message'}, ${input.callbackData ?? null},
          ${input.callbackMessageId ?? null}
        )
        ON CONFLICT (bot_id, provider_update_id) DO NOTHING
        RETURNING *
      `) as Fila[]
```

`callback_data` y `callback_message_id` son `text` nullable, así que acá un `null` es SQL NULL y está bien: la trampa de `sql.json(null)` es sólo para `jsonb NOT NULL`.

- [ ] **Step 6: El doble**

En `src/test-support/fake-repos.ts`, `unMensaje` suma después de `replyToMessageId: null,`:

```ts
    kind: 'message',
    callbackData: null,
    callbackMessageId: null,
```

Y en `createFakeInboundMessagesRepo`, el objeto `creado` de `insertIfNew` pasa a ser:

```ts
      const creado: InboundMessage = {
        id: `msg-${siguienteId++}`,
        receivedAt: '2026-07-29T12:00:00.000Z',
        deliveryAttempts: 0,
        deliveredAt: null,
        lastError: null,
        ...input,
        // Después del spread: el input puede no traerlos, y la base pone estos
        // mismos defaults.
        kind: input.kind ?? 'message',
        callbackData: input.callbackData ?? null,
        callbackMessageId: input.callbackMessageId ?? null,
        nextAttemptAt: input.nextAttemptAt?.toISOString() ?? null,
      }
```

- [ ] **Step 7: Correr la integración contra el Postgres local**

```bash
DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/postgres' bun run test src/db/repositories/inbound-messages.integration.test.ts
```

Esperado: `Test Files 1 passed`, **no** `1 skipped`. Un archivo salteado con la variable puesta significa que no llegó al proceso, y entonces el paso no midió nada.

- [ ] **Step 8: Correr todo sin base**

```bash
bun run typecheck
DATABASE_URL='' bun run test
```

Esperado: limpio y verde. Los 3 casos nuevos cuentan entre los salteados.

- [ ] **Step 9: Commit**

```bash
git add migrations/0005_interactivo.sql src/db/ports.ts src/db/repositories/inbound-messages.ts src/test-support/fake-repos.ts src/db/repositories/inbound-messages.integration.test.ts
git commit -m "feat(db): 0005, un entrante puede ser un toque y un saliente lleva botones

Aditiva: se aplica antes del código nuevo. La base rechaza un toque sin data
o sin el mensaje que tenía el botón."
```

---

### Task 5: Los salientes llevan botones, y un reintento los reenvía

**Files:**
- Modify: `src/db/ports.ts`
- Modify: `src/db/repositories/outbound-messages.ts`
- Modify: `src/test-support/fake-repos.ts` (`unSaliente`, `createFakeOutboundMessagesRepo`)
- Modify: `src/outbound/send.ts`, `src/outbound/send.test.ts`
- Modify: `src/routes/messages.ts` (sólo pasa `buttons: null` por ahora)
- Modify: `src/mcp/tools.ts`
- Modify: `src/db/repositories/outbound-messages.integration.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

En `src/outbound/send.test.ts`:

- `unPedido` suma `buttons: null,` después de `idempotencyKey: null,`;
- el doble de Telegram en `armar` registra los botones: el tipo de `enviados` suma `botones: Button[][] | null | undefined` y el método pasa a ser:

```ts
    async sendMessage(token, chatId, text, replyToMessageId, botones) {
      enviados.push({ token, chatId, text, replyToMessageId, botones })
```

(import: `import type { Button } from '../client/types.js'`);

- y al final de `describe('enviarSaliente', ...)`:

```ts
  const BOTONES = [[{ text: 'Tarea', data: 's1:abc:t:tarea' }]]

  it('manda los botones y los guarda en la fila', async () => {
    const { deps, enviados, outbound } = armar()

    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ buttons: BOTONES, idempotencyKey: 'k-8' }),
    )

    expect(enviados[0]?.botones).toEqual(BOTONES)
    expect(
      (await outbound.findByIdempotencyKey(APP_ID, 'k-8'))?.buttons,
    ).toEqual(BOTONES)
  })

  it('reenvía los botones reservados, no los del pedido nuevo', async () => {
    // Mismo criterio que el texto: la clave identifica al mensaje entero.
    const { deps, enviados } = armar({ fallas: 1 })

    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ buttons: BOTONES, idempotencyKey: 'k-9' }),
    )
    await enviarSaliente(
      deps,
      APP_ID,
      unPedido({ buttons: null, idempotencyKey: 'k-9' }),
    )

    expect(enviados[1]?.botones).toEqual(BOTONES)
  })
```

- [ ] **Step 2: Correr y verificar que fallan**

```bash
DATABASE_URL='' bun run test src/outbound/send.test.ts
```

Esperado: FAIL de tipos o de aserción (`buttons` no existe en `PedidoSaliente`).

- [ ] **Step 3: Puertos**

En `src/db/ports.ts`, importar arriba `import type { Button } from '../client/types.js'`. En `OutboundMessage`, después de `template: OutboundTemplate | null`:

```ts
  buttons: Button[][] | null
```

Y en el `input` de `claim`, después de `template: OutboundTemplate | null`:

```ts
    buttons?: Button[][] | null
```

- [ ] **Step 4: El repositorio real**

En `src/db/repositories/outbound-messages.ts`: importar `Button` de `../../client/types.js`; sumar `buttons: unknown` a `Fila`; sumar `buttons: (f.buttons ?? null) as Button[][] | null,` a `aSaliente` después de `template`; y en el `INSERT` de `claim`, la lista de columnas pasa a terminar en `reply_to_message_id, idempotency_key, status, buttons` y la de valores en:

```ts
          ${input.replyToMessageId}, ${input.idempotencyKey}, 'sending',
          ${input.buttons ? sql.json(input.buttons as unknown as Json) : null}
```

Un `null` acá es SQL NULL y es lo que se quiere: la columna es nullable. El `DO UPDATE` **no** toca `buttons`, igual que no toca `text`: un reintento reenvía el teclado original.

- [ ] **Step 5: El doble**

En `src/test-support/fake-repos.ts`, `unSaliente` suma `buttons: null,` después de `template: null,`. En `createFakeOutboundMessagesRepo`, el `creado` de `claim` pasa a ser:

```ts
      const creado: OutboundMessage = {
        id: `out-${siguienteId++}`,
        providerMessageId: null,
        status: 'sending',
        error: null,
        createdAt: '2026-08-01T12:00:00.000Z',
        ...input,
        buttons: input.buttons ?? null,
      }
```

- [ ] **Step 6: `enviarSaliente`**

En `src/outbound/send.ts`: importar `import type { Button } from '../client/types.js'`; `PedidoSaliente` suma `buttons: Button[][] | null` después de `idempotencyKey`; `deps.outbound.claim({...})` suma `buttons: pedido.buttons,`; y el envío pasa a ser:

```ts
    const { messageId } = await deps.telegram.sendMessage(
      deps.secrets(bot.tokenEnv),
      contacto.externalId,
      reservado.text,
      reservado.replyToMessageId,
      reservado.buttons,
    )
```

- [ ] **Step 7: Los dos llamadores**

- `src/mcp/tools.ts`, en `enviar`: sumar `buttons: null,` al objeto que se le pasa a `enviarSaliente`, después de `idempotencyKey`. Las tools MCP siguen siendo sólo texto (spec, §1).
- `src/routes/messages.ts`: sumar `buttons: null,` al objeto de `enviarSaliente`. La Task 8 lo reemplaza por lo validado.

- [ ] **Step 8: Test de integración**

Al final del `correr(...)` de `src/db/repositories/outbound-messages.integration.test.ts`:

```ts
  it('guarda los botones como objeto y los conserva al re-reservar', async () => {
    const botones = [[{ text: 'Tarea', data: 's1:abc:t:tarea' }]]
    const creado = await repo.claim({ ...base('k-7'), buttons: botones })
    if (!creado) throw new Error('no se reservó')
    expect(creado.buttons).toEqual(botones)

    await repo.marcarFallido(creado.id, 'boom')
    const reclamado = await repo.claim({ ...base('k-7'), buttons: null })
    expect(reclamado?.buttons).toEqual(botones)
  }, 30_000)

  it('sin botones guarda SQL NULL', async () => {
    const creado = await repo.claim(base('k-8'))
    expect(creado?.buttons).toBeNull()
  }, 30_000)
```

- [ ] **Step 9: Correr todo**

```bash
bun run typecheck
DATABASE_URL='' bun run test
DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/postgres' bun run test src/db/repositories/outbound-messages.integration.test.ts
```

Esperado: limpio; la suite verde; y la integración con `Test Files 1 passed`, no `skipped`.

- [ ] **Step 10: Mutación: el `DO UPDATE` que pisa los botones**

En el `claim` real, sumar `buttons = EXCLUDED.buttons,` al `SET` del `DO UPDATE` y correr la integración de salientes. Esperado: rojo en `'guarda los botones como objeto y los conserva al re-reservar'`. Deshacer a mano y volver a verde.

- [ ] **Step 11: Commit**

```bash
git add src/db/ports.ts src/db/repositories/outbound-messages.ts src/test-support/fake-repos.ts src/outbound/send.ts src/outbound/send.test.ts src/routes/messages.ts src/mcp/tools.ts src/db/repositories/outbound-messages.integration.test.ts
git commit -m "feat(outbound): los salientes llevan botones y un reintento los reenvía

Los botones viven en la fila por la misma razón que el texto: enviarSaliente
manda lo que dice la fila, no lo que dice el pedido. Las tools MCP siguen
siendo sólo texto."
```

---

### Task 6: La entrega de un toque lleva `callback`

**Files:**
- Modify: `src/delivery/deliver.ts`
- Modify: `src/delivery/deliver.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Dentro de `describe('intentarEntrega', ...)` en `src/delivery/deliver.test.ts`:

```ts
  it('un toque se entrega con callback y texto vacío', async () => {
    const toque = unMensaje({
      text: '',
      kind: 'callback',
      callbackData: 's1:abc:t:tarea',
      callbackMessageId: '77',
    })
    const { deps, pedidos } = armar({ mensajes: [toque] })

    await intentarEntrega(deps, toque)

    const cuerpo = JSON.parse(pedidos[0]?.cuerpo ?? '{}') as Record<
      string,
      unknown
    >
    expect(cuerpo['text']).toBe('')
    expect(cuerpo['callback']).toEqual({
      data: 's1:abc:t:tarea',
      messageId: '77',
    })
  })

  it('un mensaje no lleva callback', async () => {
    const { deps, pedidos } = armar({})

    await intentarEntrega(deps, unMensaje())

    const cuerpo = JSON.parse(pedidos[0]?.cuerpo ?? '{}') as Record<
      string,
      unknown
    >
    expect('callback' in cuerpo).toBe(false)
  })
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
DATABASE_URL='' bun run test src/delivery/deliver.test.ts
```

Esperado: FAIL en el primero (`callback` undefined).

- [ ] **Step 3: `cuerpoDeEntrega`**

En `src/delivery/deliver.ts`:

```ts
function cuerpoDeEntrega(mensaje: InboundMessage): string {
  // userId, nunca externalId: la app no conoce el chat_id.
  return JSON.stringify({
    messageId: mensaje.id,
    userId: mensaje.appUserId,
    channel: mensaje.channel,
    text: mensaje.text,
    replyToMessageId: mensaje.replyToMessageId ?? undefined,
    receivedAt: mensaje.receivedAt,
    raw: mensaje.raw,
    // Una app en v0.2.0 ignora la clave: su parseIncoming no la mira.
    ...(mensaje.kind === 'callback'
      ? {
          callback: {
            data: mensaje.callbackData,
            messageId: mensaje.callbackMessageId,
          },
        }
      : {}),
  })
}
```

- [ ] **Step 4: Correr y commit**

```bash
DATABASE_URL='' bun run test
git add src/delivery/deliver.ts src/delivery/deliver.test.ts
git commit -m "feat(delivery): la entrega de un toque lleva callback

Una app en v0.2.0 la ignora: su parseIncoming no mira esa clave."
```

Esperado: verde.

---

### Task 7: El webhook contesta, guarda y entrega los toques; `/start <código>` vincula

**Files:**
- Modify: `src/routes/telegram-webhook.ts`
- Modify: `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Preparar el `armar` de los tests**

En `src/routes/telegram-webhook.test.ts`: `opts` suma `respuestaFalla?: boolean`; declarar `const respondidos: string[] = []` junto a `enviados`; y el doble de Telegram pasa a ser:

```ts
      telegram: {
        ...telegramFalso(),
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
        async answerCallbackQuery(_token, callbackId) {
          respondidos.push(callbackId)
          if (opts.respuestaFalla) {
            throw new Error('Telegram rechazó answerCallbackQuery: query is too old')
          }
        },
      },
```

Y devolver `respondidos` en el objeto de `armar`, junto a `enviados`.

- [ ] **Step 2: Escribir los tests que fallan**

Al final del archivo:

```ts
function toque(data = 's1:abc:t:tarea', chatId = '12345', updateId = 50) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(chatId), is_bot: false, first_name: 'Juan' },
      message: {
        message_id: 77,
        chat: { id: Number(chatId), type: 'private' },
        date: 1_785_264_000,
        text: '¿Lo guardo como…?',
      },
      chat_instance: '-1',
      data,
    },
  }
}

describe('toques de botones', () => {
  const VINCULADO = [unContacto({ externalId: '12345', appUserId: 'user-1' })]

  it('guarda y entrega el toque de un contacto vinculado', async () => {
    const { server, inbound, entregados, drenar } = armar({
      contactos: VINCULADO,
    })

    const res = await postear(server, toque())
    await drenar()

    expect(res.status).toBe(200)
    const guardado = await inbound.findById('msg-1')
    expect(guardado).toMatchObject({
      kind: 'callback',
      text: '',
      callbackData: 's1:abc:t:tarea',
      callbackMessageId: '77',
      appUserId: 'user-1',
    })
    expect(entregados).toEqual(['msg-1'])
  })

  it('contesta el toque con answerCallbackQuery', async () => {
    const { server, respondidos, drenar } = armar({ contactos: VINCULADO })

    await postear(server, toque())
    await drenar()

    expect(respondidos).toEqual(['cb-50'])
  })

  it('contesta el toque aunque el presupuesto del chat esté agotado', async () => {
    // El presupuesto es contra la amplificación: un toque no le escribe nada
    // al chat, y sin la respuesta el botón queda cargando para siempre.
    const { server, respondidos, drenar } = armar({
      contactos: VINCULADO,
      presupuesto: crearPresupuesto({
        porVentana: 0,
        ventanaMs: 3_600_000,
        maxClaves: 10,
      }),
    })

    await postear(server, toque())
    await drenar()

    expect(respondidos).toEqual(['cb-50'])
  })

  it('un toque repetido no se contesta ni se entrega dos veces', async () => {
    const { server, respondidos, entregados, drenar } = armar({
      contactos: VINCULADO,
    })

    await postear(server, toque())
    await postear(server, toque())
    await drenar()

    expect(respondidos).toHaveLength(1)
    expect(entregados).toHaveLength(1)
  })

  it('el toque de un chat no vinculado se contesta y queda skipped, sin unlinkedMessage', async () => {
    const { server, inbound, respondidos, enviados, entregados, drenar } =
      armar()

    await postear(server, toque())
    await drenar()

    expect(respondidos).toEqual(['cb-50'])
    expect(enviados).toEqual([])
    expect(entregados).toEqual([])
    const guardado = await inbound.findById('msg-1')
    expect(guardado?.deliveryStatus).toBe('skipped')
    expect(guardado?.raw).toBeNull()
  })

  it('contesta 200 y no deja rejections sueltas si answerCallbackQuery falla', async () => {
    const { server, drenar } = armar({
      contactos: VINCULADO,
      respuestaFalla: true,
    })

    const res = await postear(server, toque())

    expect(res.status).toBe(200)
    await expect(drenar()).resolves.toBeUndefined()
  })
})

describe('/start con código', () => {
  it('vincula con /start <código>, que es lo que manda el link t.me', async () => {
    const { server, contacts, inbound, enviados } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })

    await postear(server, update('/start ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(
      (await contacts.findByExternalId('app-1', 'telegram', '12345'))?.appUserId,
    ).toBe('user-1')
    expect(await inbound.findById('msg-1')).toBeNull()
  })

  it('/start sin código no es vinculación: sigue el camino de un mensaje', async () => {
    // Un usuario ya vinculado que abre el bot de nuevo no puede recibir
    // «Mandame el código junto al comando».
    const { server, enviados, entregados, drenar } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
    })

    await postear(server, update('/start'))
    await drenar()

    expect(enviados).toEqual([])
    expect(entregados).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Correr y verificar que fallan**

```bash
DATABASE_URL='' bun run test src/routes/telegram-webhook.test.ts
```

Esperado: FAIL en los ocho casos nuevos, salvo `'contesta 200 y no deja rejections sueltas'`, que puede pasar solo porque hoy el toque se descarta. Ése se confirma con la mutación del Step 6.

- [ ] **Step 4: Implementar en `src/routes/telegram-webhook.ts`**

Imports: sumar `Comando`, `UpdateDeToque` desde `../channels/telegram/types.js`.

Reemplazar el narrowing provisorio de la Task 2:

```ts
    // Provisorio: los toques se descartan hasta que el webhook los procese.
    if (update.tipo !== 'message') return c.json({ ok: true })

    const token = deps.secrets(bot.tokenEnv)
```

por:

```ts
    const token = deps.secrets(bot.tokenEnv)

    if (update.tipo === 'callback') {
      await recibirToque(deps, bot, token, update, crudo)
      return c.json({ ok: true })
    }
```

Reemplazar `if (comando && COMANDOS_DE_VINCULACION.has(comando.nombre)) {` por `if (comando && esVinculacion(comando)) {`.

Y agregar, después de `COMANDOS_DE_VINCULACION`:

```ts
function esVinculacion(comando: Comando): boolean {
  if (COMANDOS_DE_VINCULACION.has(comando.nombre)) return true
  // `/start <código>` es lo que manda Telegram al abrir t.me/<bot>?start=<código>.
  // Sin argumento es otra cosa —el primer contacto con el bot, o un usuario ya
  // vinculado que lo vuelve a abrir— y contestarle «Mandame el código junto al
  // comando» no tendría sentido.
  return comando.nombre === 'start' && comando.args !== ''
}
```

Y al final del archivo, antes de `vincular`:

```ts
/**
 * Un toque de un botón. Se guarda y se entrega igual que un mensaje —misma
 * deduplicación por update_id, mismo backoff—, con dos diferencias:
 *
 * - `answerCallbackQuery` sale SIEMPRE y FUERA del presupuesto. Sin él el botón
 *   queda con la barrita de carga (la doc lo exige aunque no haya nada que
 *   avisar), y no es amplificación: no le escribe nada al chat.
 * - Nunca es un comando ni recibe `unlinkedMessage`. Un chat no vinculado no
 *   tiene botones nuestros; si igual llega un toque, se guarda `skipped` y sólo
 *   se contesta el toque.
 *
 * El `data` va tal cual: la doc avisa que puede no ser el de ningún botón, y
 * validarlo es de la app, que es la que sabe qué significa.
 */
async function recibirToque(
  deps: TelegramWebhookDeps,
  bot: Bot,
  token: string,
  update: UpdateDeToque,
  crudo: unknown,
): Promise<void> {
  const contacto = await deps.contacts.findByExternalId(
    bot.appId,
    'telegram',
    update.chatId,
  )

  const guardado = await deps.inbound.insertIfNew({
    botId: bot.id,
    appId: bot.appId,
    channel: 'telegram',
    providerUpdateId: update.updateId,
    externalId: update.chatId,
    appUserId: contacto?.appUserId ?? null,
    text: '',
    replyToMessageId: null,
    kind: 'callback',
    callbackData: update.data,
    callbackMessageId: update.messageId,
    raw: contacto ? crudo : null,
    deliveryStatus: contacto ? 'pending' : 'skipped',
    nextAttemptAt: contacto ? deps.now() : null,
  })

  // null = un reintento de Telegram: el toque ya se contestó y ya se entregó.
  if (!guardado) return

  deps.waitUntil(
    // Mismo .catch que las respuestas: el waitUntil de server.ts no captura
    // rejections, y answerCallbackQuery tira cuando Telegram rechaza (por
    // ejemplo, un toque de hace más de unos segundos).
    deps.telegram
      .answerCallbackQuery(token, update.callbackId)
      .catch(() => undefined),
  )

  if (contacto) deps.waitUntil(entregarConReintentoInmediato(deps, guardado))
}
```

- [ ] **Step 5: Correr todo**

```bash
bun run typecheck
DATABASE_URL='' bun run test
```

Esperado: limpio y verde, incluidos los casos viejos de `/vincular` y del presupuesto.

- [ ] **Step 6: Tres mutaciones, una por decisión**

Cada una se aplica sola, se corre `DATABASE_URL='' bun run test src/routes/telegram-webhook.test.ts`, se anota **dónde** cayó el rojo y se deshace a mano antes de la siguiente:

| Mutación | Tiene que caer en |
|---|---|
| Reemplazar el `deps.waitUntil(deps.telegram.answerCallbackQuery(...))` por una llamada que antes pregunte `deps.presupuesto.consumir(\`${bot.id}:${update.chatId}\`, deps.now())` | `'contesta el toque aunque el presupuesto del chat esté agotado'` |
| Mover `if (!guardado) return` debajo del `waitUntil` del `answerCallbackQuery` | `'un toque repetido no se contesta ni se entrega dos veces'` (`respondidos` da 2) |
| Sacar el `.catch(() => undefined)` del `answerCallbackQuery` | `'contesta 200 y no deja rejections sueltas'` |
| En `esVinculacion`, devolver `comando.nombre === 'start'` sin mirar `args` | `'/start sin código no es vinculación'` |

Una mutación que tumba el caso **por otra línea** que la de la tabla se anota igual que una que no lo tumba: el caso no mide lo que dice.

- [ ] **Step 7: Commit**

```bash
git add src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts
git commit -m "feat(webhook): los toques se contestan, se guardan y se entregan

answerCallbackQuery sale siempre y fuera del presupuesto: no le escribe al
chat, y sin él el botón queda cargando. /start con código vincula, que es lo
que manda el link t.me; sin código sigue siendo un mensaje."
```

---

### Task 8: `POST /v1/messages` acepta botones, y los valida

**Files:**
- Create: `src/outbound/botones.ts`
- Create: `src/outbound/botones.test.ts`
- Modify: `src/routes/messages.ts`
- Modify: `src/routes/messages.test.ts`

- [ ] **Step 1: Escribir los tests que fallan del validador**

`src/outbound/botones.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { botonesSchema } from './botones.js'

const valido = (b: unknown) => botonesSchema.safeParse(b).success

describe('botonesSchema', () => {
  it('acepta filas de botones con data o con url', () => {
    expect(
      valido([
        [
          { text: 'Tarea', data: 's1:abc:t:tarea' },
          { text: 'Nota', data: 's1:abc:t:nota' },
        ],
        [{ text: 'Abrir', url: 'https://study.jadd.com.ar' }],
      ]),
    ).toBe(true)
  })

  it('cuenta el data en bytes y no en caracteres', () => {
    // 61 caracteres ASCII + un emoji de 4 bytes = 65 bytes, pero .length da
    // 63: una validación por .length lo dejaría pasar y Telegram lo rechazaría.
    const pasado = 'a'.repeat(61) + '🎓'
    expect(pasado.length).toBe(63)
    expect(valido([[{ text: 'x', data: pasado }]])).toBe(false)

    const justo = 'a'.repeat(60) + '🎓' // 64 bytes
    expect(valido([[{ text: 'x', data: justo }]])).toBe(true)
  })

  it('rechaza un data vacío', () => {
    expect(valido([[{ text: 'x', data: '' }]])).toBe(false)
  })

  it('exige exactamente uno de data o url', () => {
    expect(
      valido([[{ text: 'x', data: 'a', url: 'https://ejemplo.test' }]]),
    ).toBe(false)
    expect(valido([[{ text: 'x' }]])).toBe(false)
  })

  it('rechaza una url que no es https', () => {
    expect(valido([[{ text: 'x', url: 'http://ejemplo.test' }]])).toBe(false)
    expect(valido([[{ text: 'x', url: 'no es una url' }]])).toBe(false)
  })

  it('rechaza un botón sin texto', () => {
    expect(valido([[{ text: '', data: 'a' }]])).toBe(false)
  })

  it('rechaza una fila vacía y un teclado vacío', () => {
    expect(valido([[]])).toBe(false)
    expect(valido([])).toBe(false)
  })

  it('rechaza más de 100 botones', () => {
    const fila = Array.from({ length: 10 }, (_, i) => ({
      text: `b${i}`,
      data: `d${i}`,
    }))
    expect(valido(Array.from({ length: 10 }, () => fila))).toBe(true)
    expect(valido(Array.from({ length: 11 }, () => fila))).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
DATABASE_URL='' bun run test src/outbound/botones.test.ts
```

Esperado: FAIL (`Cannot find module './botones.js'`).

- [ ] **Step 3: Implementar `src/outbound/botones.ts`**

```ts
import { Buffer } from 'node:buffer'
import * as z from 'zod'

/** Bot API, `InlineKeyboardButton.callback_data`: «1-64 bytes». Bytes, no caracteres. */
export const MAX_BYTES_DATA = 64

/**
 * Tope propio. La Bot API no publica un límite de botones por mensaje (buscado
 * el 22/09/2026 en la doc de la 10.3), y un teclado más grande ya no se usa en
 * un teléfono.
 */
export const MAX_BOTONES = 100

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function esHttps(u: string): boolean {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

const botonSchema = z
  .object({
    text: z.string().min(1),
    data: z.string().optional(),
    url: z.string().optional(),
  })
  .refine(
    (b) => (b.data === undefined) !== (b.url === undefined),
    'exactamente uno de data o url',
  )
  .refine(
    (b) =>
      b.data === undefined ||
      (bytes(b.data) >= 1 && bytes(b.data) <= MAX_BYTES_DATA),
    `data de 1 a ${MAX_BYTES_DATA} bytes`,
  )
  .refine((b) => b.url === undefined || esHttps(b.url), 'url https')

/**
 * Valida en la ruta lo que Telegram rechazaría con un 400: así la app recibe
 * un 400 con causa en vez de un 502 que parece del proveedor.
 */
export const botonesSchema = z
  .array(z.array(botonSchema).min(1))
  .min(1)
  .refine(
    (filas) => filas.reduce((n, fila) => n + fila.length, 0) <= MAX_BOTONES,
    `como mucho ${MAX_BOTONES} botones`,
  )
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
DATABASE_URL='' bun run test src/outbound/botones.test.ts
```

Esperado: PASS.

- [ ] **Step 5: Mutación: contar caracteres**

Cambiar el cuerpo de `bytes` por `return s.length` y correr el mismo archivo. Esperado: rojo en `'cuenta el data en bytes y no en caracteres'`. Deshacer a mano.

- [ ] **Step 6: Tests de la ruta que fallan**

En `src/routes/messages.test.ts`, el doble de Telegram de `armar` registra los botones: declarar `const botonesEnviados: unknown[] = []` antes del doble, y el método pasa a ser:

```ts
    async sendMessage(_token, _chatId, _text, _replyTo, botones) {
      botonesEnviados.push(botones)
      if (opts.falla) {
        throw new Error('Telegram rechazó sendMessage: chat not found')
      }
      return { messageId: 'tg-1' }
    },
```

`armar` devuelve ahora `{ server, botonesEnviados }` en vez de `server` a secas: en los tests existentes, reemplazar `armar(...)` por `armar(...).server` donde se usa como servidor (todas las llamadas actuales a `postear(armar(...), ...)` y `const server = armar(...)`). Después, dentro de `describe('POST /v1/messages', ...)`:

```ts
  it('manda los botones a Telegram tal cual vinieron', async () => {
    const { server, botonesEnviados } = armar()
    const buttons = [[{ text: 'Tarea', data: 's1:abc:t:tarea' }]]

    const res = await postear(server, { ...VALIDO, buttons })

    expect(res.status).toBe(200)
    expect(botonesEnviados).toEqual([buttons])
  })

  it('rechaza con 400 un teclado inválido', async () => {
    const res = await postear(armar().server, {
      ...VALIDO,
      buttons: [[{ text: 'x', data: 'a'.repeat(61) + '🎓' }]],
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'invalid_request' })
  })
```

- [ ] **Step 7: Implementar en `src/routes/messages.ts`**

Importar `import { botonesSchema } from '../outbound/botones.js'`; sumar `buttons: botonesSchema.optional(),` al final de `cuerpoSchema`; y reemplazar el `buttons: null,` de la Task 5 por:

```ts
      buttons: parseado.data.buttons ?? null,
```

- [ ] **Step 8: Correr todo y commit**

```bash
bun run typecheck
bun run lint
DATABASE_URL='' bun run test
git add src/outbound/botones.ts src/outbound/botones.test.ts src/routes/messages.ts src/routes/messages.test.ts
git commit -m "feat(messages): /v1/messages acepta botones y los valida

callback_data en bytes y no en caracteres, exactamente uno de data o url, url
https y un tope propio de 100 botones: la Bot API no publica uno."
```

Esperado: limpio y verde.

---

### Task 9: `POST /v1/messages/edit`

**Files:**
- Create: `src/outbound/edit.ts`
- Create: `src/outbound/edit.test.ts`
- Modify: `src/routes/messages.ts`
- Modify: `src/routes/messages.test.ts`

- [ ] **Step 1: Escribir los tests que fallan de `editarSaliente`**

`src/outbound/edit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact } from '../db/ports.js'
import { telegramFalso } from '../test-support/fake-telegram.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { editarSaliente, type PedidoEdicion } from './edit.js'

const APP_ID = 'app-1'

function unaEdicion(over: Partial<PedidoEdicion> = {}): PedidoEdicion {
  return {
    userId: 'user-1',
    messageId: '77',
    text: '¿En qué proyecto?',
    buttons: null,
    ...over,
  }
}

function armar(
  opts: { contactos?: Contact[]; bots?: Bot[]; rechazo?: string } = {},
) {
  const ediciones: {
    token: string
    chatId: string
    messageId: string
    text: string
    botones: unknown
  }[] = []

  const telegram: TelegramClient = {
    ...telegramFalso(),
    async editMessageText(token, chatId, messageId, text, botones) {
      ediciones.push({ token, chatId, messageId, text, botones })
      if (opts.rechazo) {
        throw new Error(`Telegram rechazó editMessageText: ${opts.rechazo}`)
      }
    },
  }

  return {
    ediciones,
    deps: {
      bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
      contacts: createFakeContactsRepo(
        opts.contactos ?? [unContacto({ externalId: '12345' })],
      ),
      telegram,
      secrets: (nombre: string) => `valor-de-${nombre}`,
    },
  }
}

describe('editarSaliente', () => {
  it('edita en el chat del contacto con el token del bot de la app', async () => {
    const { deps, ediciones } = armar()
    const buttons = [[{ text: 'Redes', data: 's1:abc:p:0' }]]

    const r = await editarSaliente(deps, APP_ID, unaEdicion({ buttons }))

    expect(r).toEqual({ estado: 'edited' })
    expect(ediciones).toEqual([
      {
        token: 'valor-de-TELEGRAM_TOKEN_GYM',
        chatId: '12345',
        messageId: '77',
        text: '¿En qué proyecto?',
        botones: buttons,
      },
    ])
  })

  it('no edita nada si el usuario no está vinculado', async () => {
    const { deps, ediciones } = armar({ contactos: [] })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'not_linked',
    })
    expect(ediciones).toEqual([])
  })

  it('no edita nada si la app no tiene bot activo', async () => {
    const { deps } = armar({ bots: [unBot({ active: false })] })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'no_bot',
    })
  })

  it('editar sin cambios cuenta como éxito', async () => {
    // Lo produce un doble toque: el mensaje ya dice lo que se pidió.
    const { deps } = armar({
      rechazo:
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
    })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'edited',
    })
  })

  it('cualquier otro rechazo es edit_failed con el detalle', async () => {
    const { deps } = armar({ rechazo: 'Bad Request: message to edit not found' })

    expect(await editarSaliente(deps, APP_ID, unaEdicion())).toEqual({
      estado: 'edit_failed',
      error:
        'Telegram rechazó editMessageText: Bad Request: message to edit not found',
    })
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
DATABASE_URL='' bun run test src/outbound/edit.test.ts
```

Esperado: FAIL (`Cannot find module './edit.js'`).

- [ ] **Step 3: Implementar `src/outbound/edit.ts`**

```ts
import type { Button } from '../client/types.js'
import type { SendDeps } from './send.js'

export type EditDeps = Pick<SendDeps, 'bots' | 'contacts' | 'telegram' | 'secrets'>

export interface PedidoEdicion {
  userId: string
  /** El id DEL PROVEEDOR, el que devolvió el envío. */
  messageId: string
  text: string
  /** null saca el teclado que tenía el mensaje. */
  buttons: Button[][] | null
}

export type ResultadoEdicion =
  | { estado: 'edited' }
  | { estado: 'not_linked' }
  | { estado: 'no_bot' }
  | { estado: 'edit_failed'; error: string }

/**
 * ⚠️ La descripción exacta de este rechazo NO figura en la doc de la Bot API:
 * se confirmó con una llamada real el día del deploy (plan del 22/09/2026,
 * Task 12). Si Telegram la cambia, un doble toque empieza a dar 502.
 */
const NO_MODIFICADO = /message is not modified/i

/**
 * No hace falta comprobar de quién es el mensaje: cada app tiene su propio
 * bot, y Telegram sólo deja editar mensajes de ese bot en ese chat. Por la
 * misma razón una edición no crea fila en outbound_messages: no es un mensaje
 * nuevo.
 */
export async function editarSaliente(
  deps: EditDeps,
  appId: string,
  pedido: PedidoEdicion,
): Promise<ResultadoEdicion> {
  const contacto = await deps.contacts.findByAppUserId(
    appId,
    'telegram',
    pedido.userId,
  )
  if (!contacto) return { estado: 'not_linked' }

  const bot = await deps.bots.findByAppAndChannel(appId, 'telegram')
  if (!bot) return { estado: 'no_bot' }

  try {
    await deps.telegram.editMessageText(
      deps.secrets(bot.tokenEnv),
      contacto.externalId,
      pedido.messageId,
      pedido.text,
      pedido.buttons,
    )
    return { estado: 'edited' }
  } catch (error) {
    const detalle = (error as Error).message
    if (NO_MODIFICADO.test(detalle)) return { estado: 'edited' }
    return { estado: 'edit_failed', error: detalle }
  }
}
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
DATABASE_URL='' bun run test src/outbound/edit.test.ts
```

Esperado: PASS.

- [ ] **Step 5: Tests de la ruta que fallan**

En `src/routes/messages.test.ts`: `armar` suma `opts.edicionFalla?: string` y el doble de Telegram suma:

```ts
    async editMessageText() {
      if (opts.edicionFalla) {
        throw new Error(`Telegram rechazó editMessageText: ${opts.edicionFalla}`)
      }
    },
```

Y al final del archivo:

```ts
function editar(server: Hono<ConVariablesDeApp>, cuerpo: unknown) {
  return server.request('/v1/messages/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
}

const EDICION = { userId: 'user-1', messageId: '77', text: '✅ Guardado' }

describe('POST /v1/messages/edit', () => {
  it('edita y contesta 200', async () => {
    const res = await editar(armar().server, EDICION)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'edited' })
  })

  it('rechaza un messageId que no es un entero', async () => {
    const res = await editar(armar().server, { ...EDICION, messageId: 'abc' })
    expect(res.status).toBe(400)
  })

  it('rechaza un teclado inválido', async () => {
    const res = await editar(armar().server, {
      ...EDICION,
      buttons: [[{ text: 'x' }]],
    })
    expect(res.status).toBe(400)
  })

  it('devuelve 404 not_linked si el usuario no vinculó', async () => {
    const res = await editar(armar({ contactos: [] }).server, EDICION)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'not_linked' })
  })

  it('devuelve 502 si Telegram rechaza la edición', async () => {
    const res = await editar(
      armar({ edicionFalla: 'Bad Request: message to edit not found' }).server,
      EDICION,
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'edit_failed' })
  })

  it('devuelve 401 sin Authorization en la app completa', async () => {
    const app = createApp(createFakeDeps())
    const res = await app.request('/v1/messages/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EDICION),
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 6: La ruta en `src/routes/messages.ts`**

Importar `import { editarSaliente } from '../outbound/edit.js'`. Después de `cuerpoSchema`:

```ts
const edicionSchema = z.object({
  userId: z.string().min(1),
  // El id DEL PROVEEDOR. Telegram pide un entero, y validarlo acá convierte
  // un 502 del proveedor en un 400 con causa clara.
  messageId: z.string().regex(/^\d+$/),
  text: z.string().min(1).max(LARGO_MAXIMO_TEXTO),
  buttons: botonesSchema.optional(),
})
```

Y dentro de `messageRoutes`, antes de `return rutas`:

```ts
  rutas.post('/v1/messages/edit', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = edicionSchema.safeParse(crudo)
    if (!parseado.success) {
      return c.json({ code: 'invalid_request' }, 400)
    }

    const app = c.get('app')
    const resultado = await editarSaliente(deps, app.id, {
      userId: parseado.data.userId,
      messageId: parseado.data.messageId,
      text: parseado.data.text,
      buttons: parseado.data.buttons ?? null,
    })

    switch (resultado.estado) {
      case 'edited':
        return c.json({ status: 'edited' })
      case 'not_linked':
        return c.json({ code: 'not_linked' }, 404)
      case 'no_bot':
        return c.json({ code: 'no_bot' }, 500)
      case 'edit_failed':
        return c.json({ code: 'edit_failed', error: resultado.error }, 502)
    }
  })
```

`/v1/messages/edit` queda detrás de `apiKeyAuth` sin tocar `create-app.ts`: el middleware es `'/v1/*'`.

- [ ] **Step 7: Correr todo**

```bash
bun run typecheck
bun run lint
DATABASE_URL='' bun run test
```

Esperado: limpio y verde.

- [ ] **Step 8: Mutación: el «no modificado»**

En `editarSaliente`, borrar la línea `if (NO_MODIFICADO.test(detalle)) return { estado: 'edited' }` y correr `src/outbound/edit.test.ts`. Esperado: rojo en `'editar sin cambios cuenta como éxito'`. Deshacer a mano.

- [ ] **Step 9: Commit**

```bash
git add src/outbound/edit.ts src/outbound/edit.test.ts src/routes/messages.ts src/routes/messages.test.ts
git commit -m "feat(messages): POST /v1/messages/edit

Resuelve el chat por el contacto: la app nunca ve un chat_id. Editar sin
cambios cuenta como éxito porque lo produce un doble toque."
```

---

### Task 10: El cliente `v0.3.0`

**Files:**
- Modify: `src/client/index.ts`
- Modify: `src/client/index.test.ts`
- Modify (generado): `dist/client/index.js`, `dist/client/index.d.ts`

- [ ] **Step 1: Escribir los tests que fallan**

En `src/client/index.test.ts`, dentro de `describe('sendMessage', ...)`:

```ts
  it('manda los botones solo si vienen', async () => {
    const { fake, llamadas } = fetchQue(200, {
      messageId: 'u',
      providerMessageId: '1',
      status: 'sent',
    })
    const buttons = [[{ text: 'Tarea', data: 's1:abc:t:tarea' }]]

    await crear(fake).sendMessage({
      userId: 'user-1',
      text: '¿Lo guardo como…?',
      kind: 'reply',
      buttons,
    })
    await crear(fake).sendMessage({ userId: 'user-1', text: 'x', kind: 'reply' })

    expect(JSON.parse(String(llamadas[0]?.init?.body))).toMatchObject({
      buttons,
    })
    expect('buttons' in JSON.parse(String(llamadas[1]?.init?.body))).toBe(false)
  })
```

Un `describe` nuevo después de `describe('sendMessage', ...)`:

```ts
describe('editMessage', () => {
  it('postea a /v1/messages/edit con la API key', async () => {
    const { fake, llamadas } = fetchQue(200, { status: 'edited' })
    const buttons = [[{ text: 'Redes', data: 's1:abc:p:0' }]]

    await crear(fake).editMessage?.({
      userId: 'user-1',
      messageId: '77',
      text: '¿En qué proyecto?',
      buttons,
    })

    expect(llamadas[0]?.url).toBe('https://comm.test/v1/messages/edit')
    const headers = new Headers(llamadas[0]?.init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      userId: 'user-1',
      messageId: '77',
      text: '¿En qué proyecto?',
      buttons,
    })
  })

  it('tira con el código de comm-tool', async () => {
    const { fake } = fetchQue(404, { code: 'not_linked' })
    await expect(
      crear(fake).editMessage?.({ userId: 'user-9', messageId: '77', text: 'x' }),
    ).rejects.toThrow(/not_linked/)
  })

  it('nunca incluye la API key en el mensaje de error', async () => {
    const { fake } = fetchQue(502, { code: 'edit_failed' })
    await expect(
      crear(fake).editMessage?.({ userId: 'user-1', messageId: '77', text: 'x' }),
    ).rejects.toThrow(/^(?!.*clave-de-la-app).*$/s)
  })
})
```

Y dentro de `describe('parseIncoming', ...)`:

```ts
  it('devuelve el callback de un toque', async () => {
    const res = await crear(sinRed).parseIncoming(
      entregaFirmada({
        ...ENTREGA,
        text: '',
        callback: { data: 's1:abc:t:tarea', messageId: '77' },
      }),
    )

    expect(res?.text).toBe('')
    expect(res?.callback).toEqual({ data: 's1:abc:t:tarea', messageId: '77' })
  })

  it('un callback mal formado no se inventa: el entrante sale sin callback', async () => {
    const res = await crear(sinRed).parseIncoming(
      entregaFirmada({ ...ENTREGA, callback: { data: 5 } }),
    )

    expect(res).not.toBeNull()
    expect(res?.callback).toBeUndefined()
  })
```

- [ ] **Step 2: Correr y verificar que fallan**

```bash
DATABASE_URL='' bun run test src/client/index.test.ts
```

Esperado: FAIL (`buttons` no viaja, `editMessage` es undefined, `callback` undefined).

- [ ] **Step 3: Implementar en `src/client/index.ts`**

El import de tipos suma `EditMessage` y el re-export también:

```ts
import type {
  Channel,
  EditMessage,
  IncomingMessage,
  Messaging,
  OutgoingMessage,
} from './types.js'

export type {
  Button,
  Channel,
  EditMessage,
  IncomingMessage,
  Messaging,
  OutgoingMessage,
} from './types.js'
```

(reemplaza a `export type { Channel, IncomingMessage, Messaging, OutgoingMessage }`).

En el body de `sendMessage`, después del spread de `idempotencyKey`:

```ts
          ...(msg.buttons ? { buttons: msg.buttons } : {}),
```

Un método nuevo después de `sendMessage`:

```ts
    async editMessage(msg: EditMessage) {
      const res = await doFetch(`${config.baseUrl}/v1/messages/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          userId: msg.userId,
          messageId: msg.messageId,
          text: msg.text,
          ...(msg.buttons ? { buttons: msg.buttons } : {}),
        }),
      })

      if (!res.ok) {
        const cuerpo = (await res.json().catch(() => null)) as {
          code?: string
        } | null
        // Mismo criterio que sendMessage: solo el código, nunca la clave.
        throw new Error(
          `comm-tool rechazó la edición: ${cuerpo?.code ?? res.status}`,
        )
      }
    },
```

Y en `parseIncoming`, reemplazar el `return` final por:

```ts
      const replyTo = datos['replyToMessageId']
      const callback = datos['callback']
      const toque =
        esObjeto(callback) &&
        typeof callback['data'] === 'string' &&
        typeof callback['messageId'] === 'string'
          ? { data: callback['data'], messageId: callback['messageId'] }
          : undefined

      return {
        userId,
        text,
        channel: channel as Channel,
        messageId,
        ...(typeof replyTo === 'string' ? { replyToMessageId: replyTo } : {}),
        receivedAt,
        raw: datos['raw'],
        ...(toque ? { callback: toque } : {}),
      }
```

(la línea `const replyTo = datos['replyToMessageId']` ya existe: no duplicarla).

- [ ] **Step 4: Rebuildear, correr todo y verificar el paquete**

```bash
bun run build:client
bun run typecheck
bun run lint
DATABASE_URL='' bun run test
```

Esperado: limpio; verde, incluidos `src/client/paquete.test.ts` (el cliente no importa nada de afuera) y `src/client/conformance.test.ts`, que no cambian.

- [ ] **Step 5: Commit, con el `dist/` adentro**

```bash
git add src/client/index.ts src/client/index.test.ts dist/client
git commit -m "feat(client): v0.3.0 manda botones, edita y lee los toques

Un callback mal formado no se inventa: el entrante sale sin él."
```

---

### Task 11: `CLAUDE.md`, la verificación completa y el PR

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Estado del proyecto**

En `CLAUDE.md`, §Estado del proyecto, agregar arriba de `Fase 5 — Scheduler **completa**`:

```markdown
Transporte interactivo **en código** (2026-09-22): botones inline en los
salientes, los toques (`callback_query`) guardados y entregados como entrantes
de `kind = 'callback'`, y `POST /v1/messages/edit`. Cliente `v0.3.0`, con todo
**opcional**: GymTracker sigue en `v0.2.0`. Migración `0005`. Lo pidió Study
Master para procesar los mensajes en el chat; el spec vive en ese repo
(`docs/superpowers/specs/2026-09-22-bot-de-telegram-interactivo-design.md`) y
el plan acá (`docs/superpowers/plans/2026-09-22-transporte-interactivo.md`).

🚨 **Un bot sólo recibe toques si su webhook los pide**: `setWebhook` con
`allowed_updates` que incluya `callback_query`. Los tres bots se registraron con
`["message"]`, y así los botones no hacen nada **sin ningún error**. Sólo el de
Study se re-registró.
```

- [ ] **Step 2: Invariantes**

En §Invariantes, después del bullet del presupuesto (`**Toda respuesta que origina el webhook está presupuestada**`):

```markdown
- **Un toque se contesta siempre, y fuera del presupuesto.** `answerCallbackQuery`
  no le escribe nada al chat, y sin él el botón queda con la barrita de carga
  (la doc de la Bot API lo exige aunque no haya nada que avisar).
- **El `data` de un toque es opaco para comm-tool, y puede no ser de ningún
  botón.** La doc avisa que el mensaje *«can contain no callback buttons with
  this data»*. Se entrega tal cual y lo valida la app.
- **Los botones de un saliente viven en su fila**, igual que el texto: un
  reintento idempotente reenvía lo que dice la fila, no lo que dice el pedido.
```

- [ ] **Step 3: Operación**

En §Operación, después del bullet de `ver-circuito.ts`:

```markdown
- **Re-registrar un bot para que reciba toques**, en el VPS, sin imprimir los
  secretos. Ejemplo con el de Study:

  ```bash
  cd /opt/stacks/comm-tool
  T="$(grep '^TELEGRAM_TOKEN_STUDY=' comm-tool.env | cut -d= -f2- | tr -d '"')"
  S="$(grep '^TELEGRAM_WEBHOOK_SECRET_STUDY=' comm-tool.env | cut -d= -f2- | tr -d '"')"
  curl -s -X POST "https://api.telegram.org/bot$T/setWebhook" -H 'Content-Type: application/json' \
    -d "{\"url\":\"https://comm.jadd.com.ar/webhooks/telegram/study\",\"secret_token\":\"$S\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
  curl -s "https://api.telegram.org/bot$T/getWebhookInfo"
  unset T S
  ```

  Mismo `url` y mismo `secret_token` que antes: lo único que cambia es
  `allowed_updates`. `setWebhook` es exclusivo, así que el `url` tiene que ser
  exactamente el que ya estaba.
- **Un toque que «no hace nada»**: primero `getWebhookInfo` y mirar que
  `allowed_updates` incluya `callback_query`. Después, las filas:

  ```sql
  SELECT kind, callback_data, callback_message_id, delivery_status, last_error
  FROM inbound_messages WHERE kind = 'callback'
  ORDER BY received_at DESC LIMIT 20;
  ```
```

- [ ] **Step 4: La verificación completa**

```bash
bun run lint
bun run typecheck
DATABASE_URL='' bun run test
DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/postgres' bun run test
bun run build:client
git diff --exit-code dist
```

Esperado, uno por uno:

- lint y typecheck limpios;
- sin base: todo verde, con los 4 archivos de integración salteados;
- con el Postgres local: **0 salteados** (si alguno dice `skipped`, la variable no llegó);
- `git diff --exit-code dist` sin salida y con exit 0.

Anotar los dos conteos de tests (sin base y con base): van al PR y al `CLAUDE.md`.

- [ ] **Step 5: Tirar el Postgres descartable**

```bash
docker rm -f ct-pg
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: el transporte interactivo, sus invariantes y cómo re-registrar un bot"
```

- [ ] **Step 7: Pushear la rama**

La rama ya trackea `origin/claude/transporte-interactivo` (se pusheó con el plan). Igual, con el nombre explícito, que no depende de cómo haya quedado configurado el upstream:

```bash
git push -u origin claude/transporte-interactivo
```

Pushear la rama no es mergear y no compromete nada: es lo que hace que el trabajo exista fuera de esta máquina.

- [ ] **Step 8: Abrir el PR, con el ok de Juan**

Con su aprobación explícita. Título `Transporte interactivo: botones, toques y editar mensajes`, y en el cuerpo: qué hace, los conteos del Step 4, las mutaciones de las Tasks 3, 5, 7, 8 y 9 con dónde cayó cada una, y el orden de deploy de la Task 12.

---

### Task 12: Merge, tag, deploy, webhook y verificación en producción

🚨 **Todo lo de esta task sale al remoto o a producción: cada paso con el ok explícito de Juan.** Ningún test del repo puede probar lo que verifica esta task: que Telegram dibuja los botones, que manda los toques y que la edición funciona.

- [ ] **Step 1: Mergear el PR**

Con `--merge` o `--rebase`, **nunca `--squash`** (`CLAUDE.md`). Esperar el CI en verde antes.

- [ ] **Step 2: Taggear `v0.3.0` sobre `main`**

```bash
git fetch origin
git tag -a v0.3.0 origin/main -m "Paquete cliente: botones, toques y editar mensajes"
git push origin v0.3.0
```

Es el tag al que va a anclar Study Master (`github:juanandresdavila/communication-tool#v0.3.0`).

- [ ] **Step 3: Mirar qué arrastra el deploy**

El deploy es un `git pull` de `main`: sube todo lo mergeado desde el deploy anterior, no sólo este cambio.

```bash
ssh vps 'cd /opt/src/communication-tool && git fetch origin && git rev-list --count HEAD..origin/main && git log --oneline HEAD..origin/main'
ssh vps 'cd /opt/src/communication-tool && git diff --stat HEAD origin/main -- migrations/'
```

Esperado: los commits de este PR (y nombrarle a Juan cualquier otro que aparezca), y **una sola** migración nueva, `0005_interactivo.sql`. Si aparece otra, parar.

- [ ] **Step 4: Etiquetar la imagen viva, construir y migrar ANTES de levantar**

```bash
ssh vps
docker tag comm-tool-app:latest comm-tool-app:pre-20260922
cd /opt/src/communication-tool && git pull
cd /opt/stacks/comm-tool && docker compose build app
docker compose run --rm app bun run db:migrate
docker compose up -d app
```

Esperado del `db:migrate`: `Aplicando 0005_interactivo.sql...`, `OK 0005_interactivo.sql`, `Listo. 1 migración(es) aplicada(s).` Va antes del `up` porque el código nuevo inserta en columnas que el viejo no conoce; al revés, los primeros toques darían 500.

⚠️ **`docker compose run --rm app bun run db:migrate` no está verificado en este stack** (el VPS no respondió al `ssh` el día que se escribió el plan). Si falla por red o por variables, la alternativa es `docker compose up -d app` seguido de `docker compose exec app bun run db:migrate`, aceptando unos segundos en que un toque daría 500. No pasa nada grave: todavía no existe ningún botón que tocar, y Telegram reintenta.

**Rollback**, si algo sale mal: la `0005` es aditiva y el código viejo funciona con ella, así que alcanza con volver la imagen (`docker tag comm-tool-app:pre-20260922 comm-tool-app:latest` y `docker compose up -d --no-build app`).

- [ ] **Step 5: Verificar el deploy**

```bash
curl -s https://comm.jadd.com.ar/health?deep=1
ssh vps 'cd /opt/stacks/comm-tool && docker compose exec -T db psql -U commtool -d commtool -c "\d inbound_messages" -c "\d outbound_messages"'
```

Esperado: `{"status":"ok","db":"ok"}`, y las columnas `kind`, `callback_data`, `callback_message_id` y `buttons` en la salida. El usuario de la base es `commtool`, no `postgres`.

- [ ] **Step 6: Re-registrar el webhook del bot de Study**

Primero confirmar dónde apunta hoy, **antes** de tocar nada:

```bash
ssh vps
cd /opt/stacks/comm-tool
T="$(grep '^TELEGRAM_TOKEN_STUDY=' comm-tool.env | cut -d= -f2- | tr -d '"')"
curl -s "https://api.telegram.org/bot$T/getWebhookInfo"
```

Esperado: `"url":"https://comm.jadd.com.ar/webhooks/telegram/study"`. **Si dice otra cosa, parar**: `setWebhook` es exclusivo y re-registrarlo le sacaría los updates a quien los tenga. Si coincide, correr el bloque de §Operación del `CLAUDE.md` (Task 11, Step 3) y confirmar en el `getWebhookInfo` final: el mismo `url`, `"allowed_updates":["message","callback_query"]` y `"pending_update_count":0`.

- [ ] **Step 7: La prueba de punta a punta, sin tocar Study Master**

Study Master en producción todavía corre el cliente `v0.2.0`: a un toque lo recibe como un entrante con texto vacío, que su route acepta con 200 y no guarda. Eso alcanza para probar todo el transporte.

Desde el checkout principal de comm-tool, que es donde está la `STUDY_API_KEY`:

```bash
cd /Users/juanddavil/Projects/communication-tool
K="$(grep '^STUDY_API_KEY=' .env | cut -d= -f2- | tr -d '"')"
U="b30b5c79-b58f-4b9c-8c54-bdf39a9920cb"
curl -s "https://comm.jadd.com.ar/v1/contacts/$U" -H "Authorization: Bearer $K"
```

Esperado: `{"linked":true,...}`. `U` es el uuid de la cuenta de Juan en Study Master (`jadd47267701@gmail.com`); si da `linked: false`, el contacto está con otro id y hay que buscarlo en `contacts` antes de seguir. Después:

```bash
curl -s -X POST https://comm.jadd.com.ar/v1/messages -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$U\",\"kind\":\"notification\",\"text\":\"Prueba de comm-tool v0.3.0: tocá un botón.\",\"buttons\":[[{\"text\":\"Uno\",\"data\":\"prueba:1\"},{\"text\":\"Dos\",\"data\":\"prueba:2\"}],[{\"text\":\"Abrir Study Master\",\"url\":\"https://study.jadd.com.ar\"}]]}"
```

Anotar el `providerMessageId` de la respuesta. **Juan** confirma en el teléfono que ve los tres botones y toca «Uno»: el botón **no** tiene que quedar cargando. Después, en el VPS:

```sql
SELECT kind, callback_data, callback_message_id, delivery_status, last_error
FROM inbound_messages ORDER BY received_at DESC LIMIT 3;
```

Esperado: una fila `callback`, `prueba:1`, el `providerMessageId` anotado, `delivered` y sin error.

- [ ] **Step 8: La edición, y el texto del «no modificado»**

```bash
curl -s -X POST https://comm.jadd.com.ar/v1/messages/edit -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$U\",\"messageId\":\"<providerMessageId>\",\"text\":\"Editado: tocaste un botón.\"}"
```

Esperado: `{"status":"edited"}`, y en el teléfono el mensaje cambia de texto y **pierde los botones** (esto confirma lo del teclado vacío). Correr **el mismo comando otra vez**: tiene que volver `{"status":"edited"}` de nuevo. Si vuelve un 502, el `error` trae la descripción real de Telegram: corregir `NO_MODIFICADO` en `src/outbound/edit.ts` con ese texto, en un PR aparte, y anotarlo en el `CLAUDE.md`.

```bash
unset K U
```

- [ ] **Step 9: Memoria**

Actualizar la memoria del frente (`studymaster-bot-telegram-interactivo`) y el hub de comm-tool con: el commit mergeado, el tag, que el webhook de Study quedó con `callback_query`, lo que devolvió el paso del «no modificado» y los conteos de tests. Y desde acá se abre el plan de Study Master.
