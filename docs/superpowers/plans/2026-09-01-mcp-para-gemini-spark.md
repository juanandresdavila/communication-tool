# Servidor MCP para Gemini Spark — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exponer `POST /mcp` en comm-tool con dos herramientas de salida, `enviar_mensaje` y `ver_contacto`, para que un cliente MCP (Gemini Spark como destinatario final) pueda mandarle mensajes de Telegram al usuario.

**Architecture:** tres archivos nuevos con una responsabilidad cada uno. `src/mcp/protocol.ts` es puro y no conoce Hono: parsea el sobre JSON-RPC, negocia la versión del protocolo y valida los headers. `src/mcp/tools.ts` tiene las definiciones de las tools y despacha a `enviarSaliente` y al repo de contactos, que ya existen y ya están probados. `src/routes/mcp.ts` es la ruta Hono y el mapeo a códigos HTTP. No hay migración, no hay tabla nueva, no hay lógica de envío nueva.

**Tech Stack:** Bun, Hono, Zod 4, Vitest. Ninguna dependencia nueva.

**Spec:** `docs/superpowers/specs/2026-09-01-mcp-para-gemini-spark-design.md`

---

## Antes de empezar: gotchas de este repo que rompen el trabajo si se ignoran

Están en el `CLAUDE.md`, pero estos cuatro se aplican a cada archivo de este plan:

1. **Los imports relativos llevan `.js` siempre**, aunque el archivo sea `.ts`. Sin eso, `bun run typecheck` falla (el tsconfig usa `"module": "nodenext"` justamente para convertir ese error de producción en un error local).
2. **Zod se importa como namespace**: `import * as z from 'zod'`. Con `import { z } from 'zod'`, `z` queda `undefined` bajo Vitest.
3. **No encadenar con pipes al verificar.** `bun run lint | tail` devuelve el exit code de `tail` y tapa el fallo. Comandos sueltos.
4. **`bun run test` no carga el `.env`.** Para este plan no hace falta base: todos los tests corren con fakes.

---

## Estructura de archivos

| Archivo | Responsabilidad | Depende de |
|---|---|---|
| `src/mcp/protocol.ts` (nuevo) | Constantes del protocolo, parseo del sobre JSON-RPC, negociación de versión, validación de headers, códigos de error. Puro: sin Hono, sin I/O. | nada |
| `src/mcp/protocol.test.ts` (nuevo) | Tests de lo anterior. | — |
| `src/mcp/tools.ts` (nuevo) | Las dos definiciones de tools y el despacho de `tools/call`. | `enviarSaliente`, `ContactsRepo` |
| `src/mcp/tools.test.ts` (nuevo) | Tests de lo anterior, con los fakes de `src/test-support/`. | — |
| `src/routes/mcp.ts` (nuevo) | Ruta Hono: `POST /mcp`, `GET`/`DELETE` → 405, y el middleware `sinOrigen`. | los dos de arriba |
| `src/routes/mcp.test.ts` (nuevo) | Tests de la ruta. | — |
| `src/create-app.ts` (modificar) | Montar el bloque `/mcp` con `sinOrigen` y `apiKeyAuth`. | — |
| `CLAUDE.md` (modificar) | Documentar el endpoint y su operación. | — |

---

## Task 1: constantes y sobre JSON-RPC

**Files:**
- Create: `src/mcp/protocol.ts`
- Test: `src/mcp/protocol.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/mcp/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { analizarPedido, CODIGO, VERSION_ACTUAL } from './protocol.js'

const SIN_HEADERS = { protocolVersion: null, method: null, name: null }

describe('analizarPedido: sobre JSON-RPC', () => {
  it('acepta un pedido legacy sin headers', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      SIN_HEADERS,
    )

    expect(r).toEqual({
      tipo: 'pedido',
      id: 1,
      method: 'tools/list',
      params: {},
      version: null,
      moderna: false,
    })
  })

  it('un cuerpo que no es objeto es un parse error', () => {
    const r = analizarPedido('no soy json-rpc', SIN_HEADERS)

    expect(r).toEqual({
      tipo: 'falla',
      estado: 400,
      id: null,
      code: CODIGO.parseError,
      message: expect.stringContaining('objeto JSON-RPC'),
    })
  })

  it('rechaza un sobre sin jsonrpc 2.0', () => {
    const r = analizarPedido({ id: 1, method: 'tools/list' }, SIN_HEADERS)

    expect(r).toMatchObject({ tipo: 'falla', code: CODIGO.invalidRequest })
  })

  it('rechaza un sobre sin método', () => {
    const r = analizarPedido({ jsonrpc: '2.0', id: 1 }, SIN_HEADERS)

    expect(r).toMatchObject({ tipo: 'falla', code: CODIGO.invalidRequest })
  })

  it('un sobre sin id es una notificación', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      SIN_HEADERS,
    )

    expect(r).toEqual({ tipo: 'notificacion' })
  })

  it('expone params y reconoce la era moderna por el header', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 'a',
        method: 'tools/list',
        params: {
          cursor: 'x',
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      { protocolVersion: VERSION_ACTUAL, method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({ tipo: 'pedido', moderna: true, version: VERSION_ACTUAL })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun run test src/mcp/protocol.test.ts`
Expected: FAIL, `Failed to resolve import "./protocol.js"`.

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/mcp/protocol.ts`:

```ts
/**
 * Revisión actual del protocolo MCP. Trae metadata por request y
 * `server/discover`; las anteriores usan el handshake `initialize`. Se
 * contestan las dos eras porque no se sabe cuál habla el cliente y no se lo
 * puede averiguar hasta tenerlo conectado.
 */
export const VERSION_ACTUAL = '2026-07-28'

export const VERSIONES_SOPORTADAS: readonly string[] = [
  VERSION_ACTUAL,
  '2025-11-25',
  '2025-06-18',
]

export const SERVER_INFO = {
  name: 'communication-tool',
  version: '0.1.0',
} as const

export const CODIGO = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const

export interface HeadersMcp {
  protocolVersion: string | null
  method: string | null
  name: string | null
}

export type Analisis =
  | { tipo: 'notificacion' }
  | {
      tipo: 'pedido'
      id: string | number
      method: string
      params: Record<string, unknown>
      version: string | null
      moderna: boolean
    }
  | {
      tipo: 'falla'
      estado: 400 | 404
      id: string | number | null
      code: number
      message: string
      data?: unknown
    }

function falla(
  estado: 400 | 404,
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Analisis {
  return data === undefined
    ? { tipo: 'falla', estado, id, code, message }
    : { tipo: 'falla', estado, id, code, message, data }
}

function objeto(valor: unknown): Record<string, unknown> | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return null
  }
  return valor as Record<string, unknown>
}

export function analizarPedido(crudo: unknown, headers: HeadersMcp): Analisis {
  const sobre = objeto(crudo)
  if (!sobre) {
    return falla(
      400,
      null,
      CODIGO.parseError,
      'El cuerpo no es un objeto JSON-RPC.',
    )
  }
  if (sobre.jsonrpc !== '2.0') {
    return falla(400, null, CODIGO.invalidRequest, 'Falta jsonrpc: "2.0".')
  }
  if (typeof sobre.method !== 'string') {
    return falla(400, null, CODIGO.invalidRequest, 'Falta el método.')
  }

  // Sin id es una notificación: se acepta y no se contesta nada.
  if (sobre.id === undefined || sobre.id === null) return { tipo: 'notificacion' }
  if (typeof sobre.id !== 'string' && typeof sobre.id !== 'number') {
    return falla(
      400,
      null,
      CODIGO.invalidRequest,
      'El id tiene que ser string o número.',
    )
  }
  const id = sobre.id
  const params = objeto(sobre.params) ?? {}

  return {
    tipo: 'pedido',
    id,
    method: sobre.method,
    params,
    version: headers.protocolVersion,
    moderna: headers.protocolVersion === VERSION_ACTUAL,
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `bun run test src/mcp/protocol.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/protocol.ts src/mcp/protocol.test.ts
git commit -m "feat(mcp): sobre JSON-RPC y constantes del protocolo"
```

---

## Task 2: negociación de versión

Hasta acá `analizarPedido` mira solo el header. Falta que el cuerpo también cuente, que las versiones desconocidas se rechacen, y que header y cuerpo tengan que coincidir.

**Files:**
- Modify: `src/mcp/protocol.ts`
- Test: `src/mcp/protocol.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `src/mcp/protocol.test.ts`, al final del archivo:

```ts
describe('analizarPedido: versión del protocolo', () => {
  it('toma la versión del cuerpo cuando no viene el header', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      SIN_HEADERS,
    )

    expect(r).toMatchObject({ tipo: 'pedido', version: VERSION_ACTUAL, moderna: true })
  })

  it('rechaza header y cuerpo que dicen versiones distintas', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
        },
      },
      { protocolVersion: VERSION_ACTUAL, method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({
      tipo: 'falla',
      estado: 400,
      id: 1,
      code: CODIGO.headerMismatch,
    })
  })

  it('rechaza una versión que no soportamos y lista las que sí', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { protocolVersion: '2030-01-01', method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({
      tipo: 'falla',
      estado: 400,
      code: CODIGO.unsupportedVersion,
      data: { supported: [VERSION_ACTUAL, '2025-11-25', '2025-06-18'] },
    })
  })

  it('acepta una versión legacy conocida sin exigirle nada moderno', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { protocolVersion: '2025-11-25', method: null, name: null },
    )

    expect(r).toMatchObject({ tipo: 'pedido', moderna: false })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `bun run test src/mcp/protocol.test.ts`
Expected: FAIL. Los tres primeros de este bloque fallan: la versión del cuerpo se ignora, no hay chequeo de coincidencia, y no hay lista de soportadas.

- [ ] **Step 3: Escribir la implementación**

En `src/mcp/protocol.ts`, agregar las dos constantes de clave arriba de `HeadersMcp`:

```ts
const CLAVE_VERSION = 'io.modelcontextprotocol/protocolVersion'
const CLAVE_CAPACIDADES = 'io.modelcontextprotocol/clientCapabilities'
```

Y reemplazar el bloque final de `analizarPedido` (desde `const params = objeto(sobre.params) ?? {}` hasta el `return`) por:

```ts
  const params = objeto(sobre.params) ?? {}
  const meta = objeto(params._meta) ?? {}
  const versionCuerpo =
    typeof meta[CLAVE_VERSION] === 'string' ? meta[CLAVE_VERSION] : null

  // El header y el cuerpo tienen que decir lo mismo. Si un intermediario
  // rutea por el header y el servidor ejecuta por el cuerpo, que discrepen es
  // un agujero, no una molestia.
  if (
    headers.protocolVersion !== null &&
    versionCuerpo !== null &&
    headers.protocolVersion !== versionCuerpo
  ) {
    return falla(
      400,
      id,
      CODIGO.headerMismatch,
      `MCP-Protocol-Version "${headers.protocolVersion}" no coincide con el cuerpo "${versionCuerpo}".`,
    )
  }

  const version = headers.protocolVersion ?? versionCuerpo
  if (version !== null && !VERSIONES_SOPORTADAS.includes(version)) {
    return falla(
      400,
      id,
      CODIGO.unsupportedVersion,
      `Versión de protocolo no soportada: ${version}.`,
      { supported: [...VERSIONES_SOPORTADAS] },
    )
  }

  return {
    tipo: 'pedido',
    id,
    method: sobre.method,
    params,
    version,
    moderna: version === VERSION_ACTUAL,
  }
```

Nota: `CLAVE_CAPACIDADES` queda declarada pero sin usar hasta la Task 3. ESLint la marca como no usada, así que **agregala recién en la Task 3**, no ahora.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `bun run test src/mcp/protocol.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/protocol.ts src/mcp/protocol.test.ts
git commit -m "feat(mcp): negociacion de version entre las dos eras del protocolo"
```

---

## Task 3: validación de headers en la era moderna

La revisión 2026-07-28 obliga a que `Mcp-Method` y `Mcp-Name` espejen el cuerpo, y a que cada request traiga `clientCapabilities`. Solo aplica cuando el cliente declaró esa versión: un cliente que dice hablar 2026-07-28 está declarando conformidad, así que exigírselo es seguro.

**Files:**
- Modify: `src/mcp/protocol.ts`
- Test: `src/mcp/protocol.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `src/mcp/protocol.test.ts`, al final:

```ts
const META_MODERNA = {
  'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
  'io.modelcontextprotocol/clientCapabilities': {},
}

function moderno(
  method: string,
  params: Record<string, unknown> = {},
  headers: Partial<{ method: string | null; name: string | null }> = {},
) {
  return analizarPedido(
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META_MODERNA } },
    {
      protocolVersion: VERSION_ACTUAL,
      method: headers.method === undefined ? method : headers.method,
      name: headers.name ?? null,
    },
  )
}

describe('analizarPedido: headers de la era moderna', () => {
  it('exige el header Mcp-Method', () => {
    expect(moderno('tools/list', {}, { method: null })).toMatchObject({
      tipo: 'falla',
      code: CODIGO.headerMismatch,
      message: expect.stringContaining('Mcp-Method'),
    })
  })

  it('rechaza un Mcp-Method que no coincide con el cuerpo', () => {
    expect(moderno('tools/list', {}, { method: 'tools/call' })).toMatchObject({
      tipo: 'falla',
      code: CODIGO.headerMismatch,
    })
  })

  it('exige el header Mcp-Name en tools/call', () => {
    expect(moderno('tools/call', { name: 'ver_contacto' })).toMatchObject({
      tipo: 'falla',
      code: CODIGO.headerMismatch,
      message: expect.stringContaining('Mcp-Name'),
    })
  })

  it('acepta un tools/call con los dos headers correctos', () => {
    expect(
      moderno('tools/call', { name: 'ver_contacto' }, { name: 'ver_contacto' }),
    ).toMatchObject({ tipo: 'pedido', moderna: true })
  })

  it('decodifica el sentinela base64 del Mcp-Name antes de comparar', () => {
    expect(
      moderno(
        'tools/call',
        { name: 'ver_contacto' },
        { name: '=?base64?dmVyX2NvbnRhY3Rv?=' },
      ),
    ).toMatchObject({ tipo: 'pedido' })
  })

  it('exige clientCapabilities en el _meta', () => {
    const r = analizarPedido(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL },
        },
      },
      { protocolVersion: VERSION_ACTUAL, method: 'tools/list', name: null },
    )

    expect(r).toMatchObject({ tipo: 'falla', code: CODIGO.invalidParams })
  })

  it('no le exige headers a un cliente legacy', () => {
    const r = analizarPedido(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
      { protocolVersion: '2025-11-25', method: null, name: null },
    )

    expect(r).toMatchObject({ tipo: 'pedido', moderna: false })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `bun run test src/mcp/protocol.test.ts`
Expected: FAIL. Los primeros seis de este bloque fallan porque no hay ninguna validación de headers todavía.

- [ ] **Step 3: Escribir la implementación**

En `src/mcp/protocol.ts`, agregar la constante que la Task 2 dejó pendiente, junto a `CLAVE_VERSION`:

```ts
const CLAVE_CAPACIDADES = 'io.modelcontextprotocol/clientCapabilities'
```

Agregar el decodificador y el validador arriba de `analizarPedido`:

```ts
const SENTINELA_BASE64 = /^=\?base64\?(.*)\?=$/

/**
 * Un valor de header que no entra en ASCII viaja envuelto en `=?base64?...?=`.
 * Hay que desenvolverlo ANTES de compararlo contra el cuerpo, o un nombre de
 * tool con acento nunca coincide.
 */
function decodificarHeader(valor: string): string {
  const match = SENTINELA_BASE64.exec(valor)
  if (!match) return valor
  return new TextDecoder().decode(
    Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0)),
  )
}

function validarHeadersModernos(
  id: string | number,
  method: string,
  params: Record<string, unknown>,
  meta: Record<string, unknown>,
  headers: HeadersMcp,
): Analisis | null {
  if (meta[CLAVE_CAPACIDADES] === undefined) {
    return falla(
      400,
      id,
      CODIGO.invalidParams,
      `Falta ${CLAVE_CAPACIDADES} en params._meta.`,
    )
  }
  if (headers.method === null) {
    return falla(400, id, CODIGO.headerMismatch, 'Falta el header Mcp-Method.')
  }
  if (headers.method !== method) {
    return falla(
      400,
      id,
      CODIGO.headerMismatch,
      `Mcp-Method "${headers.method}" no coincide con el cuerpo "${method}".`,
    )
  }
  if (method !== 'tools/call') return null

  const nombre = typeof params.name === 'string' ? params.name : null
  if (headers.name === null) {
    return falla(400, id, CODIGO.headerMismatch, 'Falta el header Mcp-Name.')
  }
  if (nombre !== null && decodificarHeader(headers.name) !== nombre) {
    return falla(
      400,
      id,
      CODIGO.headerMismatch,
      `Mcp-Name "${headers.name}" no coincide con el cuerpo "${nombre}".`,
    )
  }
  return null
}
```

Y en `analizarPedido`, justo antes del `return { tipo: 'pedido', ... }` final:

```ts
  if (version === VERSION_ACTUAL) {
    const problema = validarHeadersModernos(id, sobre.method, params, meta, headers)
    if (problema) return problema
  }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `bun run test src/mcp/protocol.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/protocol.ts src/mcp/protocol.test.ts
git commit -m "feat(mcp): validacion de headers de la revision 2026-07-28"
```

---

## Task 4: definiciones de las tools

**Files:**
- Create: `src/mcp/tools.ts`
- Test: `src/mcp/tools.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/mcp/tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TOOLS } from './tools.js'

describe('TOOLS', () => {
  it('expone las dos tools de salida, en orden determinista', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['enviar_mensaje', 'ver_contacto'])
  })

  it('no expone ninguna tool de programados', () => {
    // El scheduler dispara contra un schedule_callback_url HTTP que un cliente
    // MCP no tiene: un programado creado desde acá se marcaría failed sin
    // postear a nadie.
    const nombres = TOOLS.map((t) => t.name).join(' ')
    expect(nombres).not.toContain('programar')
  })

  it('declara el limite de Telegram en el schema, para que el modelo parta el texto', () => {
    const enviar = TOOLS.find((t) => t.name === 'enviar_mensaje')
    expect(enviar?.inputSchema.properties.text).toMatchObject({ maxLength: 4096 })
    expect(enviar?.inputSchema.required).toEqual(['userId', 'text'])
  })

  it('cada tool tiene descripcion y un inputSchema de tipo object', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun run test src/mcp/tools.test.ts`
Expected: FAIL, `Failed to resolve import "./tools.js"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/mcp/tools.ts`:

```ts
/** Telegram corta los mensajes de texto en 4096 caracteres. Va declarado en el
 *  inputSchema para que el modelo parta un digest largo en vez de comerse un
 *  rechazo. */
const LARGO_MAXIMO_TEXTO = 4096

export interface DefinicionTool {
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required: string[]
    additionalProperties: false
  }
}

/**
 * Solo tools de salida. `programar` y `cancelar_programado` quedan afuera a
 * propósito: el scheduler dispara posteando a un schedule_callback_url HTTP y
 * un cliente MCP no expone ninguno, así que un programado creado desde acá se
 * marcaría failed sin postear a nadie. Una tool que falla en silencio es peor
 * que una tool que no está.
 */
export const TOOLS: readonly DefinicionTool[] = [
  {
    name: 'enviar_mensaje',
    title: 'Enviar un mensaje de Telegram',
    description:
      'Manda un mensaje de Telegram al usuario. El texto viaja tal cual: este servicio transporta, no interpreta ni reescribe. Es de una sola mano, el usuario no puede contestar por este canal.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description:
            'Identificador del destinatario. Hoy el único vinculado es "juan".',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: LARGO_MAXIMO_TEXTO,
          description: `El texto del mensaje. Máximo ${LARGO_MAXIMO_TEXTO} caracteres, que es el límite de Telegram: si el contenido es más largo, mandá varios mensajes en vez de uno.`,
        },
        idempotencyKey: {
          type: 'string',
          maxLength: 200,
          description:
            'Opcional. Reintentar el mismo envío con la misma clave entrega el mensaje una sola vez. Conviene una clave estable por envío, por ejemplo "pendientes-2026-09-02".',
        },
      },
      required: ['userId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ver_contacto',
    title: 'Ver si un usuario está vinculado',
    description:
      'Dice si un usuario tiene un contacto de Telegram vinculado. Sirve para chequear antes de mandar. Nunca devuelve el chat id.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description:
            'Identificador del destinatario. Hoy el único vinculado es "juan".',
        },
      },
      required: ['userId'],
      additionalProperties: false,
    },
  },
]
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `bun run test src/mcp/tools.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/tools.test.ts
git commit -m "feat(mcp): definiciones de las dos tools de salida"
```

---

## Task 5: ejecución de las tools

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `src/mcp/tools.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `src/mcp/tools.test.ts`. Los imports de arriba del archivo pasan a ser:

```ts
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, Contact } from '../db/ports.js'
import type { SendDeps } from '../outbound/send.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { ejecutarTool, TOOLS } from './tools.js'
```

Y al final del archivo:

```ts
const APP_ID = 'app-1'

function armarDeps(
  opts: { contactos?: Contact[]; bots?: Bot[]; falla?: boolean } = {},
): SendDeps {
  const telegram: TelegramClient = {
    async sendMessage() {
      if (opts.falla) throw new Error('Telegram rechazó sendMessage: chat not found')
      return { messageId: 'tg-1' }
    },
  }

  return {
    bots: createFakeBotsRepo(opts.bots ?? [unBot()]),
    contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
    outbound: createFakeOutboundMessagesRepo([]),
    telegram,
    secrets: () => 'token',
  }
}

describe('ejecutarTool: enviar_mensaje', () => {
  it('manda y devuelve el id del proveedor', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'enviar_mensaje', {
      userId: 'user-1',
      text: 'pendientes de hoy',
    })

    expect(r).toEqual({ tipo: 'ok', texto: expect.stringContaining('tg-1') })
  })

  it('un usuario no vinculado es error de ejecucion, no de protocolo', async () => {
    const r = await ejecutarTool(armarDeps({ contactos: [] }), APP_ID, 'enviar_mensaje', {
      userId: 'fantasma',
      text: 'hola',
    })

    expect(r.tipo).toBe('error_de_ejecucion')
  })

  it('un rechazo de Telegram es error de ejecucion y dice la causa', async () => {
    const r = await ejecutarTool(armarDeps({ falla: true }), APP_ID, 'enviar_mensaje', {
      userId: 'user-1',
      text: 'hola',
    })

    expect(r).toEqual({
      tipo: 'error_de_ejecucion',
      texto: expect.stringContaining('chat not found'),
    })
  })

  it('rechaza un texto mas largo que el limite de Telegram', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'enviar_mensaje', {
      userId: 'user-1',
      text: 'x'.repeat(4097),
    })

    expect(r.tipo).toBe('argumentos_invalidos')
  })

  it('rechaza argumentos que no cumplen el schema', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'enviar_mensaje', { text: 'hola' })

    expect(r.tipo).toBe('argumentos_invalidos')
  })
})

describe('ejecutarTool: ver_contacto', () => {
  it('dice que esta vinculado sin filtrar el chat id', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'ver_contacto', {
      userId: 'user-1',
    })

    expect(r).toMatchObject({ tipo: 'ok' })
    // El externalId del contacto de prueba es '12345'. La app nunca ve el
    // chat id: es el invariante central del servicio.
    expect(r.tipo === 'ok' && r.texto).not.toContain('12345')
  })

  it('dice que no esta vinculado cuando no hay contacto', async () => {
    const r = await ejecutarTool(armarDeps({ contactos: [] }), APP_ID, 'ver_contacto', {
      userId: 'user-1',
    })

    expect(r).toMatchObject({ tipo: 'ok', texto: expect.stringContaining('no está') })
  })
})

describe('ejecutarTool: tool desconocida', () => {
  it('la reporta como tal', async () => {
    const r = await ejecutarTool(armarDeps(), APP_ID, 'borrar_todo', {})

    expect(r).toEqual({ tipo: 'tool_desconocida' })
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `bun run test src/mcp/tools.test.ts`
Expected: FAIL, `ejecutarTool` no existe.

- [ ] **Step 3: Escribir la implementación**

En `src/mcp/tools.ts`, agregar arriba de todo:

```ts
import * as z from 'zod'
import { enviarSaliente, type SendDeps } from '../outbound/send.js'
```

Y al final del archivo:

```ts
export type ResultadoTool =
  | { tipo: 'ok'; texto: string }
  | { tipo: 'error_de_ejecucion'; texto: string }
  | { tipo: 'argumentos_invalidos'; detalle: string }
  | { tipo: 'tool_desconocida' }

const enviarArgs = z.object({
  userId: z.string().min(1),
  text: z.string().min(1).max(LARGO_MAXIMO_TEXTO),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

const verArgs = z.object({ userId: z.string().min(1) })

/**
 * La distinción entre los cuatro resultados no es cosmética: el spec de MCP
 * separa el error de protocolo, que el modelo no puede arreglar, del error de
 * ejecución, que sí. Devolver un not_linked como error de protocolo hace que
 * el modelo abandone en vez de corregirse.
 */
export async function ejecutarTool(
  deps: SendDeps,
  appId: string,
  nombre: string,
  argumentos: unknown,
): Promise<ResultadoTool> {
  if (nombre === 'enviar_mensaje') return await enviar(deps, appId, argumentos)
  if (nombre === 'ver_contacto') return await ver(deps, appId, argumentos)
  return { tipo: 'tool_desconocida' }
}

async function enviar(
  deps: SendDeps,
  appId: string,
  argumentos: unknown,
): Promise<ResultadoTool> {
  const parseado = enviarArgs.safeParse(argumentos)
  if (!parseado.success) {
    return {
      tipo: 'argumentos_invalidos',
      detalle: `Argumentos inválidos para enviar_mensaje: ${parseado.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    }
  }

  // kind queda fijo: un cliente MCP nunca está contestando un entrante, así
  // que no tiene sentido exponerlo como argumento.
  const resultado = await enviarSaliente(deps, appId, {
    userId: parseado.data.userId,
    text: parseado.data.text,
    kind: 'notification',
    replyToMessageId: null,
    template: null,
    idempotencyKey: parseado.data.idempotencyKey ?? null,
  })

  switch (resultado.estado) {
    case 'sent':
    case 'duplicate':
      return {
        tipo: 'ok',
        texto: `Mensaje entregado por Telegram (id del proveedor: ${resultado.providerMessageId}).`,
      }
    case 'not_linked':
      return {
        tipo: 'error_de_ejecucion',
        texto: `No hay ningún contacto de Telegram vinculado para el userId "${parseado.data.userId}". Probá ver_contacto para confirmar cuál está vinculado.`,
      }
    case 'no_bot':
      return {
        tipo: 'error_de_ejecucion',
        texto: 'Esta app no tiene un bot de Telegram activo configurado.',
      }
    case 'in_progress':
      return {
        tipo: 'error_de_ejecucion',
        texto: 'Ya hay un envío en curso con esa idempotencyKey y no se sabe si salió. No reintentes con la misma clave.',
      }
    case 'send_failed':
      return {
        tipo: 'error_de_ejecucion',
        texto: `Telegram rechazó el envío: ${resultado.error}`,
      }
  }
}

async function ver(
  deps: SendDeps,
  appId: string,
  argumentos: unknown,
): Promise<ResultadoTool> {
  const parseado = verArgs.safeParse(argumentos)
  if (!parseado.success) {
    return {
      tipo: 'argumentos_invalidos',
      detalle: 'Argumentos inválidos para ver_contacto: falta userId.',
    }
  }

  const contacto = await deps.contacts.findByAppUserId(
    appId,
    'telegram',
    parseado.data.userId,
  )

  // Nunca se devuelve externalId: la app no conoce el chat id.
  return {
    tipo: 'ok',
    texto: contacto
      ? `El usuario "${parseado.data.userId}" está vinculado por telegram desde ${contacto.linkedAt}.`
      : `El usuario "${parseado.data.userId}" no está vinculado.`,
  }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `bun run test src/mcp/tools.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/tools.test.ts
git commit -m "feat(mcp): ejecucion de las tools sobre la logica de salientes existente"
```

---

## Task 6: la ruta

**Files:**
- Create: `src/routes/mcp.ts`
- Test: `src/routes/mcp.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/routes/mcp.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Contact } from '../db/ports.js'
import { VERSION_ACTUAL } from '../mcp/protocol.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeOutboundMessagesRepo,
  unApp,
  unBot,
  unContacto,
} from '../test-support/fake-repos.js'
import { mcpRoutes } from './mcp.js'

function armar(opts: { contactos?: Contact[] } = {}) {
  const telegram: TelegramClient = {
    async sendMessage() {
      return { messageId: 'tg-1' }
    },
  }

  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route(
    '/',
    mcpRoutes({
      bots: createFakeBotsRepo([unBot()]),
      contacts: createFakeContactsRepo(opts.contactos ?? [unContacto()]),
      outbound: createFakeOutboundMessagesRepo([]),
      telegram,
      secrets: () => 'token',
    }),
  )
  return server
}

function postear(
  server: Hono<ConVariablesDeApp>,
  cuerpo: unknown,
  headers: Record<string, string> = {},
) {
  return server.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(cuerpo),
  })
}

const META = {
  'io.modelcontextprotocol/protocolVersion': VERSION_ACTUAL,
  'io.modelcontextprotocol/clientCapabilities': {},
}

describe('POST /mcp: era legacy', () => {
  it('contesta initialize con sus capacidades', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'communication-tool' },
      },
    })
  })

  it('acepta notifications/initialized con 202 y sin cuerpo', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('lista las tools sin exigir headers', async () => {
    const res = await postear(armar(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const cuerpo = (await res.json()) as {
      result: { tools: { name: string }[] }
    }

    expect(res.status).toBe(200)
    expect(cuerpo.result.tools.map((t) => t.name)).toEqual([
      'enviar_mensaje',
      'ver_contacto',
    ])
  })
})

describe('POST /mcp: era moderna', () => {
  it('contesta server/discover con las versiones soportadas', async () => {
    const res = await postear(
      armar(),
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } },
      { 'MCP-Protocol-Version': VERSION_ACTUAL, 'Mcp-Method': 'server/discover' },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      result: {
        resultType: 'complete',
        supportedVersions: [VERSION_ACTUAL, '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
      },
    })
  })

  it('manda un mensaje por tools/call', async () => {
    const res = await postear(
      armar(),
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'enviar_mensaje',
          arguments: { userId: 'user-1', text: 'pendientes de hoy' },
          _meta: META,
        },
      },
      {
        'MCP-Protocol-Version': VERSION_ACTUAL,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'enviar_mensaje',
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      result: { resultType: 'complete', isError: false },
    })
  })

  it('un usuario no vinculado vuelve como isError, con 200', async () => {
    const res = await postear(
      armar({ contactos: [] }),
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'enviar_mensaje',
          arguments: { userId: 'fantasma', text: 'hola' },
          _meta: META,
        },
      },
      {
        'MCP-Protocol-Version': VERSION_ACTUAL,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'enviar_mensaje',
      },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { isError: true } })
  })

  it('un header que no coincide con el cuerpo es 400 con -32020', async () => {
    const res = await postear(
      armar(),
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: META } },
      { 'MCP-Protocol-Version': VERSION_ACTUAL, 'Mcp-Method': 'tools/call' },
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32020 } })
  })

  it('una version desconocida es 400 con -32022', async () => {
    const res = await postear(
      armar(),
      { jsonrpc: '2.0', id: 6, method: 'tools/list' },
      { 'MCP-Protocol-Version': '2030-01-01', 'Mcp-Method': 'tools/list' },
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32022 } })
  })
})

describe('POST /mcp: metodos y verbos', () => {
  it('un metodo desconocido es 404 con -32601', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: -32601 } })
  })

  it('una tool desconocida es 400 con -32602', async () => {
    const res = await postear(armar(), {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'borrar_todo', arguments: {} },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32602 } })
  })

  it('GET y DELETE devuelven 405: esta revision no tiene stream ni sesiones', async () => {
    expect((await armar().request('/mcp')).status).toBe(405)
    expect((await armar().request('/mcp', { method: 'DELETE' })).status).toBe(405)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `bun run test src/routes/mcp.test.ts`
Expected: FAIL, `Failed to resolve import "./mcp.js"`.

- [ ] **Step 3: Escribir la implementación**

Crear `src/routes/mcp.ts`:

```ts
import { Hono, type MiddlewareHandler } from 'hono'
import {
  analizarPedido,
  CODIGO,
  SERVER_INFO,
  VERSIONES_SOPORTADAS,
} from '../mcp/protocol.js'
import { ejecutarTool, TOOLS } from '../mcp/tools.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import type { SendDeps } from '../outbound/send.js'

/**
 * El spec de MCP obliga a validar Origin contra DNS rebinding. Acá ningún
 * cliente legítimo es un navegador y la API key es un bearer que no debe ser
 * alcanzable desde una página, así que la regla es la más estricta posible:
 * si viene Origin, no pasa. No necesita configuración.
 */
export function sinOrigen(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header('Origin') !== undefined) {
      return c.json({ code: 'forbidden' }, 403)
    }
    await next()
    return undefined
  }
}

function resultado(id: string | number, result: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, result }
}

function errorJsonRpc(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

/** El `initialize` de la era vieja espera que se le repita una versión que las
 *  dos partes hablen. */
function versionEco(params: Record<string, unknown>): string {
  const pedida = params.protocolVersion
  if (typeof pedida === 'string' && VERSIONES_SOPORTADAS.includes(pedida)) {
    return pedida
  }
  return '2025-11-25'
}

export function mcpRoutes(deps: SendDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  // La revisión 2026-07-28 sacó el stream GET y las sesiones, así que el
  // endpoint es un solo POST. Contestar 405 es lo que el spec pide para un
  // cliente viejo que intente abrir un stream.
  rutas.on(['GET', 'DELETE'], '/mcp', (c) => c.text('Method Not Allowed', 405))

  rutas.post('/mcp', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const analisis = analizarPedido(crudo, {
      protocolVersion: c.req.header('MCP-Protocol-Version') ?? null,
      method: c.req.header('Mcp-Method') ?? null,
      name: c.req.header('Mcp-Name') ?? null,
    })

    if (analisis.tipo === 'notificacion') return c.body(null, 202)

    if (analisis.tipo === 'falla') {
      return c.json(
        errorJsonRpc(analisis.id, analisis.code, analisis.message, analisis.data),
        analisis.estado,
      )
    }

    const { id, method, params } = analisis

    switch (method) {
      case 'server/discover':
        return c.json(
          resultado(id, {
            resultType: 'complete',
            supportedVersions: [...VERSIONES_SOPORTADAS],
            capabilities: { tools: {} },
            instructions:
              'Manda mensajes de Telegram al usuario de esta app. Solo transporta: no lee ni interpreta contenido, y no recibe respuestas.',
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          }),
        )

      case 'initialize':
        return c.json(
          resultado(id, {
            resultType: 'complete',
            protocolVersion: versionEco(params),
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }),
        )

      case 'tools/list':
        return c.json(
          resultado(id, { resultType: 'complete', tools: [...TOOLS] }),
        )

      case 'tools/call': {
        const nombre = typeof params.name === 'string' ? params.name : ''
        const argumentos =
          typeof params.arguments === 'object' && params.arguments !== null
            ? params.arguments
            : {}

        const r = await ejecutarTool(deps, c.get('app').id, nombre, argumentos)

        switch (r.tipo) {
          case 'ok':
          case 'error_de_ejecucion':
            return c.json(
              resultado(id, {
                resultType: 'complete',
                content: [{ type: 'text', text: r.texto }],
                isError: r.tipo === 'error_de_ejecucion',
              }),
            )
          case 'tool_desconocida':
            return c.json(
              errorJsonRpc(id, CODIGO.invalidParams, `Tool desconocida: ${nombre}`),
              400,
            )
          case 'argumentos_invalidos':
            return c.json(errorJsonRpc(id, CODIGO.invalidParams, r.detalle), 400)
        }
        break
      }

      default:
        return c.json(
          errorJsonRpc(id, CODIGO.methodNotFound, `Método desconocido: ${method}`),
          404,
        )
    }
  })

  return rutas
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `bun run test src/routes/mcp.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes/mcp.ts src/routes/mcp.test.ts
git commit -m "feat(mcp): ruta POST /mcp con las dos eras del protocolo"
```

---

## Task 7: montar la ruta en la app

**Files:**
- Modify: `src/create-app.ts`
- Test: `src/routes/mcp.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

Estos van contra la app entera, no contra la ruta aislada, porque lo que prueban es el montaje. Agregar al final de `src/routes/mcp.test.ts`, y sumar estos imports arriba:

```ts
import { createApp } from '../create-app.js'
import { hashApiKey } from '../identity/api-key.js'
import { createFakeDeps } from '../test-support/fake-deps.js'
import { createFakeAppsRepo } from '../test-support/fake-repos.js'
```

```ts
const CLAVE = 'ct_clave_de_spark'

function armarAppEntera() {
  return createApp({
    ...createFakeDeps(),
    apps: createFakeAppsRepo([{ hash: hashApiKey(CLAVE), app: unApp() }]),
    contacts: createFakeContactsRepo([unContacto()]),
    bots: createFakeBotsRepo([unBot()]),
  })
}

describe('/mcp montado en la app', () => {
  it('sin API key no pasa', async () => {
    const res = await armarAppEntera().request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(401)
  })

  it('con API key lista las tools', async () => {
    const res = await armarAppEntera().request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLAVE}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(200)
  })

  it('un request con header Origin no pasa, ni siquiera con API key', async () => {
    const res = await armarAppEntera().request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLAVE}`,
        Origin: 'https://sitio-cualquiera.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(403)
  })

  it('una URL inexistente sigue siendo 404, no 401', async () => {
    // El middleware va montado en '/mcp' y no en '*' justamente por esto.
    const res = await armarAppEntera().request('/no-existe')

    expect(res.status).toBe(404)
  })
})
```

Si `createFakeDeps` no acepta ese spread o no existe con esa forma, mirá su firma real en `src/test-support/fake-deps.ts` y adaptá **la construcción del test**, no la implementación. Otros tests de rutas ya lo usan.

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `bun run test src/routes/mcp.test.ts`
Expected: FAIL. Los cuatro dan 404: `/mcp` todavía no está montado.

- [ ] **Step 3: Escribir la implementación**

En `src/create-app.ts`, agregar el import junto a los otros de rutas:

```ts
import { mcpRoutes, sinOrigen } from './routes/mcp.js'
```

Y agregar este bloque justo después del bloque de `/v1`, antes del `return app`:

```ts
  // El servidor MCP. Misma autenticación que /v1: la API key de la app. El
  // chequeo de Origin va ANTES de la auth, porque es una defensa contra que un
  // navegador llegue acá, y eso no debería depender de tener la clave.
  const mcp = new Hono<ConVariablesDeApp>()
  mcp.use('/mcp', sinOrigen())
  mcp.use('/mcp', apiKeyAuth(deps.apps))
  mcp.route('/', mcpRoutes(deps))
  app.route('/', mcp)
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `bun run test src/routes/mcp.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/create-app.ts src/routes/mcp.test.ts
git commit -m "feat(mcp): montar /mcp detras de la API key y del chequeo de Origin"
```

---

## Task 8: la suite entera y CI

**Files:** ninguno, salvo que algo se rompa.

- [ ] **Step 1: Correr la suite completa**

Run: `bun run test`
Expected: PASS. Los 225 tests que ya había más los 42 nuevos. Los 3 archivos `*.integration.test.ts` se saltean solos sin `DATABASE_URL`.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: sin salida y exit 0. **Sin pipes**: `bun run lint | tail` devolvería el exit code de `tail` y taparía el fallo.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: sin salida y exit 0. Si tira `ERR_MODULE_NOT_FOUND` o se queja de una extensión, es un import relativo al que le falta el `.js`.

- [ ] **Step 4: Simular CI, sin base**

Run: `DATABASE_URL='' bun run test`
Expected: PASS, con 3 archivos salteados.

- [ ] **Step 5: Commit si hubo arreglos**

```bash
git add -A
git commit -m "fix(mcp): arreglos de lint y tipos"
```

Si no hubo nada que arreglar, no hay commit y se sigue.

---

## Task 9: documentación

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Agregar la sección del servidor MCP**

En `CLAUDE.md`, agregar al final de la sección **Operación**:

```markdown
- **El servidor MCP vive en `POST /mcp`** y expone dos tools de salida,
  `enviar_mensaje` y `ver_contacto`. Se autentica con la misma API key que
  `/v1`. Habla las dos eras del protocolo: la revisión 2026-07-28, con
  `server/discover` y metadata por request, y la vieja con `initialize`.

  Tres respuestas que parecen bugs y no lo son:
  - **403 sin más explicación**: el request trajo header `Origin`. Es
    deliberado, ningún cliente MCP legítimo es un navegador.
  - **400 con `-32020`**: los headers `MCP-Protocol-Version`, `Mcp-Method` o
    `Mcp-Name` no coinciden con el cuerpo. Solo se exige cuando el cliente
    declaró la revisión 2026-07-28.
  - **404 con `-32601`**: método desconocido. El 404 es lo que el spec pide
    para distinguir un servidor moderno de uno legacy, no una ruta mal escrita.

  **No hay tools de programados a propósito.** El scheduler dispara posteando
  a un `schedule_callback_url` HTTP y un cliente MCP no expone ninguno: un
  programado creado desde ahí se marcaría `failed` sin postear a nadie.
```

- [ ] **Step 2: Actualizar el estado del proyecto**

En `CLAUDE.md`, en la sección **Estado del proyecto**, agregar arriba de la línea que empieza con `**Próxima fase:**`:

```markdown
Servidor MCP **completo** (2026-09-01). `POST /mcp` con `enviar_mensaje` y
`ver_contacto`, para que un agente externo pueda mandar mensajes por los bots.
Motivado por Gemini Spark, que hoy **no se puede conectar desde Argentina**:
sus custom MCP exigen residencia en Estados Unidos. El endpoint sirve a
cualquier cliente MCP y se verificó con uno real. Spec:
`docs/superpowers/specs/2026-09-01-mcp-para-gemini-spark-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: el servidor MCP, sus tres respuestas confusas y por que no hay tools de programados"
```

---

## Task 10: alta de la app y verificación real

> **Esta tarea tiene pasos que los hace Juan**, porque necesitan BotFather y su
> chat de Telegram. Están marcados.

El criterio de éxito no es que los tests pasen: es **un mensaje llegando al
Telegram de Juan, disparado por un cliente MCP que no seamos nosotros**.

- [ ] **Step 1 (Juan): crear el bot**

En Telegram, `/newbot` con `@BotFather`. Guardar el token. **No correr
`setWebhook`**: este bot es solo de salida, y sin webhook registrado no puede
robarle los updates a ninguno de los tres bots que ya andan.

- [ ] **Step 2 (Juan): cargar las variables en el VPS**

```bash
ssh vps
```

Agregar a `/opt/stacks/comm-tool/comm-tool.env`:

```
TELEGRAM_TOKEN_SPARK=<el token de BotFather>
DELIVERY_SECRET_SPARK=<openssl rand -hex 32, nunca se lee pero la columna es NOT NULL>
```

- [ ] **Step 3: deployar**

```bash
ssh vps 'cd /opt/src/communication-tool && git pull && cd /opt/stacks/comm-tool && docker compose build app && docker compose up -d app'
```

Expected: el container levanta. `curl -s https://comm.jadd.com.ar/health` devuelve ok.

- [ ] **Step 4 (Juan): dar de alta la app y el bot**

Generar la API key y correr el script **en el VPS**, que es donde está la base viva:

```bash
ssh vps 'cd /opt/src/communication-tool && KEY="$(openssl rand -hex 24)" && echo "GUARDA ESTA CLAVE: $KEY" && bun run scripts/registrar-app.ts --slug spark --name "Gemini Spark" --api-key "$KEY" --delivery-url https://spark.invalid/no-recibe-entrantes --delivery-secret-env DELIVERY_SECRET_SPARK --bot-slug spark --token-env TELEGRAM_TOKEN_SPARK --webhook-secret-env TELEGRAM_WEBHOOK_SECRET_SPARK'
```

Expected: imprime la clave y da de alta la app y el bot. **Copiar la clave**: solo se guarda su hash.

`.invalid` es TLD reservado y no resuelve: si algo intentara entregar un entrante a esta app, falla ruidoso en vez de postear a un lado equivocado.

- [ ] **Step 5 (Juan): insertar el contacto**

El chat id propio lo dice `@userinfobot` con un `/start`. Sin webhook no hay
`/vincular`, así que el contacto va a mano, que es el patrón que el `CLAUDE.md`
ya documenta para probar salientes:

```bash
ssh vps 'cd /opt/stacks/comm-tool && docker compose exec -T db psql -U commtool -d commtool -c "INSERT INTO contacts (app_id, channel, external_id, app_user_id) SELECT id, '"'"'telegram'"'"', '"'"'<CHAT_ID>'"'"', '"'"'juan'"'"' FROM apps WHERE slug = '"'"'spark'"'"';"'
```

Expected: `INSERT 0 1`. Ojo con el usuario de la base: es `commtool`, no `postgres`.

- [ ] **Step 6: verificar el circuito con un cliente MCP real**

Agregar el servidor a Claude Code, desde una terminal interactiva:

```bash
claude mcp add --transport http comm-tool https://comm.jadd.com.ar/mcp --header "Authorization: Bearer <LA API KEY DE SPARK>"
```

Después, en esa sesión de Claude Code, pedirle que llame a `ver_contacto` con
`userId: "juan"` y después a `enviar_mensaje`.

Expected, en este orden:
1. `ver_contacto` dice que `juan` está vinculado, **y no menciona ningún chat id**.
2. `enviar_mensaje` devuelve el id del proveedor.
3. **Llega el mensaje al Telegram de Juan.** Esto es lo único que cuenta como verificado.

- [ ] **Step 7: dejar registro de qué era habló el cliente**

```bash
ssh vps 'cd /opt/stacks/comm-tool && docker compose logs app --since 10m | grep -i mcp'
```

Anotar en el PR qué revisión negoció el cliente. Es el dato que va a faltar el
día que Spark no conecte y haya que decidir si el problema es la versión o la
autenticación.

- [ ] **Step 8: verificar que no se rompió nada de lo que ya andaba**

```bash
ssh vps 'cd /opt/src/communication-tool && bun run scripts/ver-circuito.ts'
```

Expected: las tres colas sanas, sin `pending` viejos ni `failed` nuevos. El
programado `checkin-nocturno` de GymTracker sigue con su `next_run_at` futuro.

---

## Lo que este plan NO hace

- No implementa OAuth. Si Spark exige Dynamic Client Registration, esto no
  conecta y hace falta un authorization server, que es un proyecto aparte.
- No abre el camino de vuelta: el usuario no puede contestarle al agente por
  este canal.
- No expone tools de programados.
- No toca `/v1`, ni el webhook, ni el scheduler, ni ningún consumidor.
- No construye el servidor MCP de Study Master.
