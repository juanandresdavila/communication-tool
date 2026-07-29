# communication-tool — Fase 1: Identidad

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un chat de Telegram pueda vincularse a un usuario de una app mediante un código de un solo uso, y que un chat desconocido reciba instrucciones en vez de silencio.

**Architecture:** Cuatro tablas (`apps`, `bots`, `contacts`, `link_codes`) detrás de puertos angostos por concepto, no de una interfaz `Db` gigante. La lógica que puede fallar en silencio — generación de códigos, normalización, hasheo de API keys, parseo de updates de Telegram — vive en módulos puros con TDD. Las rutas reciben todo inyectado, incluidos `now()` y la fuente de aleatoriedad, así que la suite completa corre sin red, sin base y sin relojes.

**Tech Stack:** Hono, Bun, TypeScript, Zod, `@neondatabase/serverless`, Vitest, Neon, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-07-28-communication-tool-design.md`

---

## Alcance de esta fase

Del spec, §Fases: «Identidad — `apps`, `bots`, `contacts`, `link_codes`, webhook de Telegram, `/vincular`, respuesta a no vinculados».

**Entra:** el esquema de identidad, la API REST de vinculación (`POST /v1/link-codes`, `GET`/`DELETE /v1/contacts/:userId`), la autenticación de apps por API key, el webhook de Telegram con verificación de secreto, el comando `/vincular` y la respuesta a chats no vinculados.

**No entra, y es deliberado:**

- **`inbound_messages` y la entrega a la app.** Son la fase 2. El spec dice que un chat no vinculado «queda registrado en `inbound_messages` con estado `skipped`»; esa tabla todavía no existe, así que en esta fase el webhook **responde pero no persiste**. La fase 2 agrega el log. Está anotado en el código con un comentario para que no se pierda.
- **Un mensaje de un chat *vinculado* que no sea un comando.** El webhook lo reconoce y devuelve 200 sin hacer nada. Entregarlo es la fase 2.
- **`POST /v1/messages`.** Es la fase 3. Esta fase manda mensajes por Telegram (confirmaciones de vinculación, instrucciones), pero mediante un cliente interno, no por la API pública.
- **Reintentos, idempotencia por `update_id`, HMAC de salida.** Fase 2.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `migrations/0001_identity.sql` | Las cuatro tablas |
| `src/identity/link-code.ts` | Alfabeto, generación y normalización de códigos. **Puro** |
| `src/identity/api-key.ts` | Generación y hasheo de API keys. **Puro** |
| `src/db/ports.ts` | Tipos de dominio y las interfaces de repositorio |
| `src/db/repositories/apps.ts` | `AppsRepo` sobre Neon |
| `src/db/repositories/bots.ts` | `BotsRepo` sobre Neon |
| `src/db/repositories/contacts.ts` | `ContactsRepo` sobre Neon |
| `src/db/repositories/link-codes.ts` | `LinkCodesRepo` sobre Neon |
| `src/secrets.ts` | Lee un secreto por *nombre* de variable de entorno |
| `src/middleware/api-key-auth.ts` | Bearer con API key, con soporte de rotación |
| `src/routes/link-codes.ts` | `POST /v1/link-codes` |
| `src/routes/contacts.ts` | `GET` y `DELETE /v1/contacts/:userId` |
| `src/channels/telegram/types.ts` | Tipos del `Update` de Telegram |
| `src/channels/telegram/parse-update.ts` | Update crudo → forma normalizada. **Puro** |
| `src/channels/telegram/client.ts` | `sendMessage` contra la Bot API |
| `src/routes/telegram-webhook.ts` | Webhook: secreto, `/vincular`, no vinculados |
| `src/create-app.ts` | **Modificar**: `Deps` crece, se montan las rutas |
| `src/index.ts` | **Modificar**: arma las dependencias reales |
| `src/test-support/fake-deps.ts` | Un `Deps` completo de mentira, con overrides |

El corte que sostiene todo: **las rutas no conocen SQL y los repositorios no conocen HTTP.** Los puertos de `ports.ts` son la costura, y `fake-deps.ts` la hace barata de testear.

---

## Task 1: Migración del esquema de identidad

**Files:**
- Create: `migrations/0001_identity.sql`

- [ ] **Step 1: Escribir la migración**

`migrations/0001_identity.sql`:

```sql
CREATE TABLE apps (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text        NOT NULL UNIQUE,
  name                  text        NOT NULL,
  api_key_hash          text        NOT NULL,
  api_key_hash_next     text,
  delivery_url          text        NOT NULL,
  schedule_callback_url text,
  delivery_secret_env   text        NOT NULL,
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX apps_api_key_hash_idx ON apps (api_key_hash);
CREATE INDEX apps_api_key_hash_next_idx ON apps (api_key_hash_next)
  WHERE api_key_hash_next IS NOT NULL;

CREATE TABLE bots (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  channel            text        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  slug               text        NOT NULL UNIQUE,
  username           text,
  token_env          text        NOT NULL,
  webhook_secret_env text        NOT NULL,
  unlinked_message   text        NOT NULL,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bots_app_id_idx ON bots (app_id);

CREATE TABLE contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  channel     text        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  external_id text        NOT NULL,
  app_user_id text        NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  blocked     boolean     NOT NULL DEFAULT false,
  UNIQUE (app_id, channel, external_id),
  UNIQUE (app_id, channel, app_user_id)
);

CREATE TABLE link_codes (
  code        text        PRIMARY KEY,
  app_id      uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  app_user_id text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX link_codes_expires_at_idx ON link_codes (expires_at);
```

Los dos únicos de `contacts` son el corazón del modelo: uno impide que un mismo chat quede vinculado dos veces en la misma app, el otro que un mismo usuario tenga dos chats. `gen_random_uuid()` es nativo desde Postgres 13, no hace falta extensión.

- [ ] **Step 2: Aplicarla**

```bash
bun run db:migrate
```

Esperado:
```
Aplicando 0001_identity.sql...
  OK 0001_identity.sql
Listo. 1 migración(es) aplicada(s).
```

- [ ] **Step 3: Verificar que es idempotente**

```bash
bun run db:migrate
```

Esperado: `Sin migraciones pendientes (1 aplicadas).`

- [ ] **Step 4: Verificar las tablas y los únicos**

```bash
bun -e "import {Client} from '@neondatabase/serverless'; const c=new Client(process.env.DATABASE_URL); await c.connect(); const t=await c.query(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1\"); console.log(t.rows.map(r=>r.table_name).join(', ')); const u=await c.query(\"SELECT conname FROM pg_constraint WHERE conrelid='contacts'::regclass AND contype='u' ORDER BY 1\"); console.log('únicos de contacts:', u.rows.length); await c.end()"
```

Esperado: `apps, bots, contacts, link_codes, schema_migrations` y `únicos de contacts: 2`.

- [ ] **Step 5: Commit**

```bash
git add migrations/
git commit -m "feat: esquema de identidad (apps, bots, contacts, link_codes)"
```

---

## Task 2: Códigos de vinculación

Módulo puro. Acá está el bug que nadie ve: el alfabeto tiene 31 caracteres y un byte va de 0 a 255, así que `byte % 31` favorece a los primeros 8 caracteres. Se resuelve descartando los bytes ≥ 248 (el múltiplo de 31 más grande que entra en un byte), y eso **es testeable de forma determinista**.

**Files:**
- Create: `src/identity/link-code.ts`
- Test: `src/identity/link-code.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/identity/link-code.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ALFABETO,
  generateLinkCode,
  normalizeLinkCode,
} from './link-code.js'

describe('ALFABETO', () => {
  it('tiene 31 caracteres sin ambigüedades', () => {
    expect(ALFABETO).toHaveLength(31)
    for (const prohibido of ['0', 'O', '1', 'I', 'L']) {
      expect(ALFABETO).not.toContain(prohibido)
    }
  })
})

describe('generateLinkCode', () => {
  it('produce un código de 6 caracteres del alfabeto', () => {
    const code = generateLinkCode(new Uint8Array([0, 1, 2, 3, 4, 5]))
    expect(code).toBe('ABCDEF')
  })

  it('mapea cada byte por índice en el alfabeto', () => {
    const code = generateLinkCode(new Uint8Array([30, 29, 0, 0, 0, 0]))
    expect(code).toBe(`${ALFABETO[30]}${ALFABETO[29]}AAAA`)
  })

  it('descarta los bytes que introducirían sesgo de módulo', () => {
    // 248 y 255 son ≥ 248 y deben saltearse por completo.
    const code = generateLinkCode(
      new Uint8Array([248, 0, 255, 1, 2, 3, 4, 5]),
    )
    expect(code).toBe('ABCDEF')
  })

  it('acepta bytes iguales a 247, que sí son válidos', () => {
    // 247 % 31 = 30 → el último carácter del alfabeto.
    const code = generateLinkCode(new Uint8Array([247, 0, 0, 0, 0, 0]))
    expect(code).toBe(`${ALFABETO[30]}AAAAA`)
  })

  it('falla si no hay bytes utilizables suficientes', () => {
    expect(() => generateLinkCode(new Uint8Array([0, 1, 2]))).toThrow(
      /bytes/i,
    )
  })
})

describe('normalizeLinkCode', () => {
  it('pasa a mayúsculas', () => {
    expect(normalizeLinkCode('abcdef')).toBe('ABCDEF')
  })

  it('saca espacios y guiones', () => {
    expect(normalizeLinkCode(' ABC-DEF ')).toBe('ABCDEF')
  })

  it('devuelve null si queda algo fuera del alfabeto', () => {
    expect(normalizeLinkCode('ABC$EF')).toBeNull()
  })

  it('rechaza los caracteres ambiguos en vez de adivinar', () => {
    // 0, O, 1, I y L no están en el alfabeto justamente para que un código
    // generado nunca los contenga. Si el usuario tipeó uno, se equivocó: no
    // se corrige por su cuenta, porque adivinar produciría un código válido
    // pero distinto del que se emitió.
    for (const ambiguo of ['O', '0', 'I', 'L', '1']) {
      expect(normalizeLinkCode(`ABCDE${ambiguo}`)).toBeNull()
    }
  })

  it('devuelve null si no mide 6 caracteres', () => {
    expect(normalizeLinkCode('ABCDE')).toBeNull()
    expect(normalizeLinkCode('ABCDEFG')).toBeNull()
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/identity/link-code.test.ts
```

Esperado: FAIL — `Cannot find module './link-code.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/identity/link-code.ts`:

```ts
/**
 * 31 caracteres: los 36 alfanuméricos menos 0, O, 1, I y L, que se confunden
 * al leer un código en voz alta o al transcribirlo desde una pantalla.
 */
export const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export const LARGO_CODIGO = 6

/**
 * Mayor múltiplo de 31 que entra en un byte. Los bytes por encima se
 * descartan: sin esto, `byte % 31` haría más probables a los primeros ocho
 * caracteres del alfabeto.
 */
const CORTE_SIN_SESGO = 248

export function generateLinkCode(bytes: Uint8Array): string {
  let code = ''
  for (const byte of bytes) {
    if (byte >= CORTE_SIN_SESGO) continue
    code += ALFABETO[byte % ALFABETO.length]
    if (code.length === LARGO_CODIGO) return code
  }
  throw new Error(
    `Bytes insuficientes para generar un código de ${LARGO_CODIGO} caracteres`,
  )
}

/**
 * Solo normaliza forma: mayúsculas y separadores. NO corrige caracteres
 * ambiguos. La mitigación de la ambigüedad es que el alfabeto no los contiene;
 * mapear una O tipeada a otra letra generaría un código válido pero distinto
 * del emitido, que es peor que rechazarlo.
 */
export function normalizeLinkCode(entrada: string): string | null {
  const limpio = entrada.trim().toUpperCase().replace(/[\s-]/g, '')

  if (limpio.length !== LARGO_CODIGO) return null
  if (![...limpio].every((c) => ALFABETO.includes(c))) return null
  return limpio
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/identity/link-code.test.ts
```

Esperado: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/identity/
git commit -m "feat: generación y normalización de códigos de vinculación"
```

---

## Task 3: API keys

**Files:**
- Create: `src/identity/api-key.ts`
- Test: `src/identity/api-key.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/identity/api-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatApiKey, hashApiKey } from './api-key.js'

describe('hashApiKey', () => {
  it('devuelve un sha256 en hexadecimal de 64 caracteres', () => {
    const hash = hashApiKey('ct_abc123')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('es determinista', () => {
    expect(hashApiKey('ct_abc123')).toBe(hashApiKey('ct_abc123'))
  })

  it('cambia por completo ante un cambio mínimo', () => {
    expect(hashApiKey('ct_abc123')).not.toBe(hashApiKey('ct_abc124'))
  })

  it('coincide con el sha256 conocido de una cadena de referencia', () => {
    // echo -n "abc" | shasum -a 256
    expect(hashApiKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('formatApiKey', () => {
  it('antepone el prefijo ct_ al material aleatorio en hexadecimal', () => {
    expect(formatApiKey(new Uint8Array([0, 255, 16]))).toBe('ct_00ff10')
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/identity/api-key.test.ts
```

Esperado: FAIL — `Cannot find module './api-key.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/identity/api-key.ts`:

```ts
import { createHash } from 'node:crypto'

/**
 * La base guarda el hash, no la clave. Un hash no es un secreto: si se filtra
 * la base, no se puede reconstruir la clave con la que autenticar.
 *
 * SHA-256 sin salt es correcto acá y no lo sería para contraseñas: la clave la
 * genera el sistema con 32 bytes de entropía, no un humano, así que no hay
 * diccionario que atacar y no hace falta un KDF lento.
 */
export function hashApiKey(clave: string): string {
  return createHash('sha256').update(clave, 'utf8').digest('hex')
}

export function formatApiKey(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `ct_${hex}`
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/identity/api-key.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/identity/api-key.ts src/identity/api-key.test.ts
git commit -m "feat: hasheo y formato de API keys"
```

---

## Task 4: Puertos de datos y dobles de test

Ninguna ruta va a conocer SQL. Esta tarea define la costura y la hace barata de testear.

**Files:**
- Create: `src/db/ports.ts`, `src/test-support/fake-repos.ts`
- Test: `src/test-support/fake-repos.test.ts`

- [ ] **Step 1: Escribir los puertos**

`src/db/ports.ts`:

```ts
export type Channel = 'telegram' | 'whatsapp'

export interface App {
  id: string
  slug: string
  name: string
  deliveryUrl: string
  scheduleCallbackUrl: string | null
  deliverySecretEnv: string
  active: boolean
}

export interface Bot {
  id: string
  appId: string
  channel: Channel
  slug: string
  username: string | null
  tokenEnv: string
  webhookSecretEnv: string
  unlinkedMessage: string
  active: boolean
}

export interface Contact {
  id: string
  appId: string
  channel: Channel
  externalId: string
  appUserId: string
  linkedAt: string
  blocked: boolean
}

export interface LinkCode {
  code: string
  appId: string
  appUserId: string
  expiresAt: string
  usedAt: string | null
}

export interface AppsRepo {
  findByApiKeyHash(hash: string): Promise<App | null>
}

export interface BotsRepo {
  findBySlug(slug: string): Promise<Bot | null>
}

export interface ContactsRepo {
  findByExternalId(
    appId: string,
    channel: Channel,
    externalId: string,
  ): Promise<Contact | null>
  findByAppUserId(
    appId: string,
    channel: Channel,
    appUserId: string,
  ): Promise<Contact | null>
  create(input: {
    appId: string
    channel: Channel
    externalId: string
    appUserId: string
  }): Promise<Contact>
  deleteByAppUserId(
    appId: string,
    channel: Channel,
    appUserId: string,
  ): Promise<boolean>
}

export interface LinkCodesRepo {
  create(input: {
    code: string
    appId: string
    appUserId: string
    expiresAt: Date
  }): Promise<void>
  /** Lectura sin efectos, para dar un mensaje de error preciso. */
  find(code: string): Promise<LinkCode | null>
  /**
   * Consume el código de forma atómica. Devuelve null si ya estaba usado,
   * venció, o no existe: la condición vive en el WHERE, no en el código.
   */
  redeem(code: string, ahora: Date): Promise<LinkCode | null>
}
```

- [ ] **Step 2: Escribir el test de los dobles**

`src/test-support/fake-repos.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  createFakeAppsRepo,
  createFakeContactsRepo,
  createFakeLinkCodesRepo,
  unApp,
  unContacto,
  unLinkCode,
} from './fake-repos.js'

describe('createFakeAppsRepo', () => {
  it('encuentra por hash de API key', async () => {
    const app = unApp({ id: 'app-1' })
    const repo = createFakeAppsRepo([{ hash: 'h1', app }])
    expect(await repo.findByApiKeyHash('h1')).toEqual(app)
    expect(await repo.findByApiKeyHash('otro')).toBeNull()
  })
})

describe('createFakeContactsRepo', () => {
  it('encuentra por external_id y por app_user_id', async () => {
    const contacto = unContacto({ externalId: '123', appUserId: 'u-1' })
    const repo = createFakeContactsRepo([contacto])

    expect(
      await repo.findByExternalId(contacto.appId, 'telegram', '123'),
    ).toEqual(contacto)
    expect(
      await repo.findByAppUserId(contacto.appId, 'telegram', 'u-1'),
    ).toEqual(contacto)
    expect(
      await repo.findByExternalId(contacto.appId, 'telegram', '999'),
    ).toBeNull()
  })

  it('crea y después encuentra', async () => {
    const repo = createFakeContactsRepo([])
    const creado = await repo.create({
      appId: 'app-1',
      channel: 'telegram',
      externalId: '55',
      appUserId: 'u-9',
    })
    expect(await repo.findByExternalId('app-1', 'telegram', '55')).toEqual(
      creado,
    )
  })

  it('borra y avisa si había algo', async () => {
    const contacto = unContacto({ appUserId: 'u-1' })
    const repo = createFakeContactsRepo([contacto])
    expect(
      await repo.deleteByAppUserId(contacto.appId, 'telegram', 'u-1'),
    ).toBe(true)
    expect(
      await repo.deleteByAppUserId(contacto.appId, 'telegram', 'u-1'),
    ).toBe(false)
  })
})

describe('createFakeLinkCodesRepo', () => {
  it('canjea una sola vez', async () => {
    const code = unLinkCode({ code: 'ABCDEF' })
    const repo = createFakeLinkCodesRepo([code])
    const ahora = new Date('2026-07-28T12:00:00Z')

    expect(await repo.redeem('ABCDEF', ahora)).not.toBeNull()
    expect(await repo.redeem('ABCDEF', ahora)).toBeNull()
  })

  it('no canjea uno vencido', async () => {
    const code = unLinkCode({
      code: 'ABCDEF',
      expiresAt: '2026-07-28T11:00:00Z',
    })
    const repo = createFakeLinkCodesRepo([code])
    expect(
      await repo.redeem('ABCDEF', new Date('2026-07-28T12:00:00Z')),
    ).toBeNull()
  })
})
```

- [ ] **Step 3: Correr el test para verificar que falla**

```bash
bun run test src/test-support/fake-repos.test.ts
```

Esperado: FAIL — `Cannot find module './fake-repos.js'`.

- [ ] **Step 4: Escribir los dobles**

`src/test-support/fake-repos.ts`:

```ts
import type {
  App,
  AppsRepo,
  Bot,
  BotsRepo,
  Channel,
  Contact,
  ContactsRepo,
  LinkCode,
  LinkCodesRepo,
} from '../db/ports.js'

export function unApp(over: Partial<App> = {}): App {
  return {
    id: 'app-1',
    slug: 'gym-tracker',
    name: 'GymTracker',
    deliveryUrl: 'https://gym.example/api/messaging/inbound',
    scheduleCallbackUrl: null,
    deliverySecretEnv: 'DELIVERY_SECRET_GYM',
    active: true,
    ...over,
  }
}

export function unBot(over: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    appId: 'app-1',
    channel: 'telegram',
    slug: 'gym',
    username: 'GymTrackerBot',
    tokenEnv: 'TELEGRAM_TOKEN_GYM',
    webhookSecretEnv: 'TELEGRAM_WEBHOOK_SECRET_GYM',
    unlinkedMessage: 'Vinculá tu cuenta con /vincular <código>.',
    active: true,
    ...over,
  }
}

export function unContacto(over: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    appId: 'app-1',
    channel: 'telegram',
    externalId: '12345',
    appUserId: 'user-1',
    linkedAt: '2026-07-28T10:00:00.000Z',
    blocked: false,
    ...over,
  }
}

export function unLinkCode(over: Partial<LinkCode> = {}): LinkCode {
  return {
    code: 'ABCDEF',
    appId: 'app-1',
    appUserId: 'user-1',
    expiresAt: '2026-07-28T23:00:00.000Z',
    usedAt: null,
    ...over,
  }
}

export function createFakeAppsRepo(
  entradas: { hash: string; app: App }[],
): AppsRepo {
  return {
    async findByApiKeyHash(hash) {
      return entradas.find((e) => e.hash === hash)?.app ?? null
    },
  }
}

export function createFakeBotsRepo(bots: Bot[]): BotsRepo {
  return {
    async findBySlug(slug) {
      return bots.find((b) => b.slug === slug) ?? null
    },
  }
}

export function createFakeContactsRepo(inicial: Contact[]): ContactsRepo {
  const contactos = [...inicial]
  let siguienteId = inicial.length + 1

  return {
    async findByExternalId(appId, channel, externalId) {
      return (
        contactos.find(
          (c) =>
            c.appId === appId &&
            c.channel === channel &&
            c.externalId === externalId,
        ) ?? null
      )
    },
    async findByAppUserId(appId, channel, appUserId) {
      return (
        contactos.find(
          (c) =>
            c.appId === appId &&
            c.channel === channel &&
            c.appUserId === appUserId,
        ) ?? null
      )
    },
    async create(input) {
      const creado: Contact = {
        id: `contact-${siguienteId++}`,
        linkedAt: '2026-07-28T10:00:00.000Z',
        blocked: false,
        ...input,
      }
      contactos.push(creado)
      return creado
    },
    async deleteByAppUserId(appId, channel, appUserId) {
      const i = contactos.findIndex(
        (c) =>
          c.appId === appId &&
          c.channel === channel &&
          c.appUserId === appUserId,
      )
      if (i === -1) return false
      contactos.splice(i, 1)
      return true
    },
  }
}

export function createFakeLinkCodesRepo(inicial: LinkCode[]): LinkCodesRepo {
  const codigos = [...inicial]

  return {
    async create(input) {
      codigos.push({
        code: input.code,
        appId: input.appId,
        appUserId: input.appUserId,
        expiresAt: input.expiresAt.toISOString(),
        usedAt: null,
      })
    },
    async find(code) {
      return codigos.find((c) => c.code === code) ?? null
    },
    async redeem(code, ahora) {
      const encontrado = codigos.find((c) => c.code === code)
      if (!encontrado) return null
      if (encontrado.usedAt !== null) return null
      if (new Date(encontrado.expiresAt) <= ahora) return null
      encontrado.usedAt = ahora.toISOString()
      return { ...encontrado }
    },
  }
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

```bash
bun run test src/test-support/fake-repos.test.ts
```

Esperado: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db/ports.ts src/test-support/fake-repos.ts src/test-support/fake-repos.test.ts
git commit -m "feat: puertos de datos de identidad y dobles de test"
```

---

## Task 5: Repositorios sobre Neon

**Files:**
- Create: `src/db/repositories/apps.ts`, `src/db/repositories/bots.ts`, `src/db/repositories/contacts.ts`, `src/db/repositories/link-codes.ts`
- Modify: `src/db/client.ts`
- Test: `src/db/repositories/repositories.integration.test.ts`

- [ ] **Step 1: Exponer el `sql` de Neon desde el cliente**

Reemplazá `src/db/client.ts` entero:

```ts
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

export type Sql = NeonQueryFunction<false, false>

/**
 * Único punto de acceso a la base desde el runtime del servicio.
 * Ningún otro módulo importa @neondatabase/serverless: los repositorios
 * reciben el `Sql` ya construido.
 */
export interface Db {
  ping(): Promise<void>
}

export function createSql(databaseUrl: string): Sql {
  return neon(databaseUrl)
}

export function createDb(sql: Sql): Db {
  return {
    async ping() {
      await sql`SELECT 1`
    },
  }
}
```

- [ ] **Step 2: Ajustar `src/index.ts` para que el repo no quede en rojo**

`createDb` cambió de firma: antes recibía la URL, ahora el `Sql`. Actualizá las dos líneas correspondientes en `src/index.ts` **en esta misma tarea** — si esperás a la Task 11, el typecheck queda roto durante seis tareas y deja de servir como red de contención:

```ts
import { createDb, createSql } from './db/client.js'
...
const sql = createSql(env.DATABASE_URL)
const app: Hono = createApp({ db: createDb(sql) })
```

La Task 11 lo vuelve a tocar para sumar el resto de las dependencias.

- [ ] **Step 3: Escribir los repositorios**

`src/db/repositories/apps.ts`:

```ts
import type { Sql } from '../client.js'
import type { App, AppsRepo } from '../ports.js'

interface FilaApp {
  id: string
  slug: string
  name: string
  delivery_url: string
  schedule_callback_url: string | null
  delivery_secret_env: string
  active: boolean
}

function aApp(f: FilaApp): App {
  return {
    id: f.id,
    slug: f.slug,
    name: f.name,
    deliveryUrl: f.delivery_url,
    scheduleCallbackUrl: f.schedule_callback_url,
    deliverySecretEnv: f.delivery_secret_env,
    active: f.active,
  }
}

export function createAppsRepo(sql: Sql): AppsRepo {
  return {
    async findByApiKeyHash(hash) {
      const filas = (await sql`
        SELECT id, slug, name, delivery_url, schedule_callback_url,
               delivery_secret_env, active
        FROM apps
        WHERE active = true
          AND (api_key_hash = ${hash} OR api_key_hash_next = ${hash})
        LIMIT 1
      `) as FilaApp[]
      const fila = filas[0]
      return fila ? aApp(fila) : null
    },
  }
}
```

`src/db/repositories/bots.ts`:

```ts
import type { Sql } from '../client.js'
import type { Bot, BotsRepo, Channel } from '../ports.js'

interface FilaBot {
  id: string
  app_id: string
  channel: string
  slug: string
  username: string | null
  token_env: string
  webhook_secret_env: string
  unlinked_message: string
  active: boolean
}

function aBot(f: FilaBot): Bot {
  return {
    id: f.id,
    appId: f.app_id,
    channel: f.channel as Channel,
    slug: f.slug,
    username: f.username,
    tokenEnv: f.token_env,
    webhookSecretEnv: f.webhook_secret_env,
    unlinkedMessage: f.unlinked_message,
    active: f.active,
  }
}

export function createBotsRepo(sql: Sql): BotsRepo {
  return {
    async findBySlug(slug) {
      const filas = (await sql`
        SELECT id, app_id, channel, slug, username, token_env,
               webhook_secret_env, unlinked_message, active
        FROM bots
        WHERE slug = ${slug}
        LIMIT 1
      `) as FilaBot[]
      const fila = filas[0]
      return fila ? aBot(fila) : null
    },
  }
}
```

`src/db/repositories/contacts.ts`:

```ts
import type { Sql } from '../client.js'
import type { Channel, Contact, ContactsRepo } from '../ports.js'

interface FilaContacto {
  id: string
  app_id: string
  channel: string
  external_id: string
  app_user_id: string
  linked_at: string
  blocked: boolean
}

function aContacto(f: FilaContacto): Contact {
  return {
    id: f.id,
    appId: f.app_id,
    channel: f.channel as Channel,
    externalId: f.external_id,
    appUserId: f.app_user_id,
    linkedAt: new Date(f.linked_at).toISOString(),
    blocked: f.blocked,
  }
}

// La lista de columnas va escrita entera en cada query, no interpolada con
// sql.unsafe(): la interpolación de identificadores dentro de un tagged
// template es justo el mecanismo que no conviene ejercitar sin necesidad.
export function createContactsRepo(sql: Sql): ContactsRepo {
  return {
    async findByExternalId(appId, channel, externalId) {
      const filas = (await sql`
        SELECT id, app_id, channel, external_id, app_user_id, linked_at, blocked
        FROM contacts
        WHERE app_id = ${appId} AND channel = ${channel}
          AND external_id = ${externalId}
        LIMIT 1
      `) as FilaContacto[]
      const fila = filas[0]
      return fila ? aContacto(fila) : null
    },

    async findByAppUserId(appId, channel, appUserId) {
      const filas = (await sql`
        SELECT id, app_id, channel, external_id, app_user_id, linked_at, blocked
        FROM contacts
        WHERE app_id = ${appId} AND channel = ${channel}
          AND app_user_id = ${appUserId}
        LIMIT 1
      `) as FilaContacto[]
      const fila = filas[0]
      return fila ? aContacto(fila) : null
    },

    async create(input) {
      const filas = (await sql`
        INSERT INTO contacts (app_id, channel, external_id, app_user_id)
        VALUES (${input.appId}, ${input.channel}, ${input.externalId},
                ${input.appUserId})
        RETURNING id, app_id, channel, external_id, app_user_id, linked_at, blocked
      `) as FilaContacto[]
      const fila = filas[0]
      if (!fila) throw new Error('El INSERT de contacts no devolvió la fila')
      return aContacto(fila)
    },

    async deleteByAppUserId(appId, channel, appUserId) {
      const filas = (await sql`
        DELETE FROM contacts
        WHERE app_id = ${appId} AND channel = ${channel}
          AND app_user_id = ${appUserId}
        RETURNING id
      `) as { id: string }[]
      return filas.length > 0
    },
  }
}
```

`src/db/repositories/link-codes.ts`:

```ts
import type { Sql } from '../client.js'
import type { LinkCode, LinkCodesRepo } from '../ports.js'

interface FilaCodigo {
  code: string
  app_id: string
  app_user_id: string
  expires_at: string
  used_at: string | null
}

function aCodigo(f: FilaCodigo): LinkCode {
  return {
    code: f.code,
    appId: f.app_id,
    appUserId: f.app_user_id,
    expiresAt: new Date(f.expires_at).toISOString(),
    usedAt: f.used_at ? new Date(f.used_at).toISOString() : null,
  }
}

export function createLinkCodesRepo(sql: Sql): LinkCodesRepo {
  return {
    async create(input) {
      await sql`
        INSERT INTO link_codes (code, app_id, app_user_id, expires_at)
        VALUES (${input.code}, ${input.appId}, ${input.appUserId},
                ${input.expiresAt.toISOString()})
      `
    },

    async find(code) {
      const filas = (await sql`
        SELECT code, app_id, app_user_id, expires_at, used_at
        FROM link_codes WHERE code = ${code} LIMIT 1
      `) as FilaCodigo[]
      const fila = filas[0]
      return fila ? aCodigo(fila) : null
    },

    async redeem(code, ahora) {
      // La condición de un solo uso vive en el WHERE: dos requests simultáneos
      // no pueden canjear el mismo código, porque el UPDATE toma el lock de la
      // fila y el segundo ya no matchea used_at IS NULL.
      const filas = (await sql`
        UPDATE link_codes
        SET used_at = ${ahora.toISOString()}
        WHERE code = ${code}
          AND used_at IS NULL
          AND expires_at > ${ahora.toISOString()}
        RETURNING code, app_id, app_user_id, expires_at, used_at
      `) as FilaCodigo[]
      const fila = filas[0]
      return fila ? aCodigo(fila) : null
    },
  }
}
```

- [ ] **Step 4: Escribir el test de integración**

`src/db/repositories/repositories.integration.test.ts`:

```ts
import { Client } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql } from '../client.js'
import { createAppsRepo } from './apps.js'
import { createBotsRepo } from './bots.js'
import { createContactsRepo } from './contacts.js'
import { createLinkCodesRepo } from './link-codes.js'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const correr = DATABASE_URL ? describe : describe.skip

const SLUG_APP = '_test_app'
const SLUG_BOT = '_test_bot'

correr('repositorios contra una base real', () => {
  const sql = createSql(DATABASE_URL)
  const apps = createAppsRepo(sql)
  const bots = createBotsRepo(sql)
  const contacts = createContactsRepo(sql)
  const linkCodes = createLinkCodesRepo(sql)
  let appId = ''

  async function limpiar() {
    const c = new Client(DATABASE_URL)
    await c.connect()
    await c.query('DELETE FROM apps WHERE slug = $1', [SLUG_APP])
    await c.end()
  }

  beforeAll(async () => {
    await limpiar()
    const c = new Client(DATABASE_URL)
    await c.connect()
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO apps (slug, name, api_key_hash, api_key_hash_next,
                         delivery_url, delivery_secret_env)
       VALUES ($1, 'Test', 'hash-actual', 'hash-nueva',
               'https://ejemplo.test/inbound', 'SECRET_TEST')
       RETURNING id`,
      [SLUG_APP],
    )
    // Sin `!`: typescript-eslint rechaza el non-null assertion y CI falla.
    const fila = rows[0]
    if (!fila) throw new Error('No se pudo crear la app de prueba')
    appId = fila.id
    await c.query(
      `INSERT INTO bots (app_id, channel, slug, token_env,
                         webhook_secret_env, unlinked_message)
       VALUES ($1, 'telegram', $2, 'TOKEN_TEST', 'SECRET_TEST', 'vinculate')`,
      [appId, SLUG_BOT],
    )
    await c.end()
  }, 30_000)

  afterAll(limpiar, 30_000)

  it('encuentra la app por la clave actual y por la de rotación', async () => {
    expect((await apps.findByApiKeyHash('hash-actual'))?.slug).toBe(SLUG_APP)
    expect((await apps.findByApiKeyHash('hash-nueva'))?.slug).toBe(SLUG_APP)
    expect(await apps.findByApiKeyHash('no-existe')).toBeNull()
  }, 30_000)

  it('encuentra el bot por slug y mapea los nombres de las env vars', async () => {
    const bot = await bots.findBySlug(SLUG_BOT)
    expect(bot?.tokenEnv).toBe('TOKEN_TEST')
    expect(bot?.webhookSecretEnv).toBe('SECRET_TEST')
    expect(bot?.appId).toBe(appId)
  }, 30_000)

  it('crea, encuentra y borra un contacto', async () => {
    const creado = await contacts.create({
      appId,
      channel: 'telegram',
      externalId: '999',
      appUserId: 'u-999',
    })
    expect(creado.externalId).toBe('999')

    expect(
      (await contacts.findByExternalId(appId, 'telegram', '999'))?.appUserId,
    ).toBe('u-999')
    expect(
      (await contacts.findByAppUserId(appId, 'telegram', 'u-999'))?.externalId,
    ).toBe('999')

    expect(await contacts.deleteByAppUserId(appId, 'telegram', 'u-999')).toBe(
      true,
    )
    expect(await contacts.deleteByAppUserId(appId, 'telegram', 'u-999')).toBe(
      false,
    )
  }, 30_000)

  it('canjea un código una sola vez, aun con dos intentos simultáneos', async () => {
    const ahora = new Date()
    const vence = new Date(ahora.getTime() + 15 * 60_000)
    await linkCodes.create({
      code: 'AAAAAA',
      appId,
      appUserId: 'u-1',
      expiresAt: vence,
    })

    const [a, b] = await Promise.all([
      linkCodes.redeem('AAAAAA', ahora),
      linkCodes.redeem('AAAAAA', ahora),
    ])
    expect([a, b].filter((r) => r !== null)).toHaveLength(1)
  }, 30_000)

  it('no canjea un código vencido', async () => {
    const ahora = new Date()
    await linkCodes.create({
      code: 'BBBBBB',
      appId,
      appUserId: 'u-2',
      expiresAt: new Date(ahora.getTime() - 60_000),
    })
    expect(await linkCodes.redeem('BBBBBB', ahora)).toBeNull()
    expect((await linkCodes.find('BBBBBB'))?.usedAt).toBeNull()
  }, 30_000)
})
```

El test de los dos canjes simultáneos es el que importa: verifica contra Postgres de verdad que el único uso lo garantiza el `WHERE`, no una carrera que ganamos por suerte.

- [ ] **Step 5: Correr los tests**

```bash
bun run test src/db/repositories/
```

Esperado con `DATABASE_URL`: PASS, 5 tests. Sin ella: `skipped`.

- [ ] **Step 6: Commit**

```bash
git add src/db/
git commit -m "feat: repositorios de identidad sobre neon"
```

---

## Task 6: Lector de secretos

La base guarda el *nombre* de la variable, nunca el valor. Este módulo hace esa indirección y falla con un mensaje que se entiende.

**Files:**
- Create: `src/secrets.ts`
- Test: `src/secrets.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSecretReader } from './secrets.js'

describe('createSecretReader', () => {
  it('devuelve el valor de la variable pedida', () => {
    const leer = createSecretReader({ TOKEN_GYM: 'abc123' })
    expect(leer('TOKEN_GYM')).toBe('abc123')
  })

  it('falla nombrando la variable que falta', () => {
    const leer = createSecretReader({})
    expect(() => leer('TOKEN_GYM')).toThrow(/TOKEN_GYM/)
  })

  it('trata una variable vacía como faltante', () => {
    const leer = createSecretReader({ TOKEN_GYM: '' })
    expect(() => leer('TOKEN_GYM')).toThrow(/TOKEN_GYM/)
  })

  it('no filtra el valor en el mensaje de error', () => {
    const leer = createSecretReader({ OTRA: 'secretisimo' })
    expect(() => leer('TOKEN_GYM')).not.toThrow(/secretisimo/)
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/secrets.test.ts
```

Esperado: FAIL — `Cannot find module './secrets.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/secrets.ts`:

```ts
export type SecretReader = (nombreVariable: string) => string

/**
 * La base guarda el NOMBRE de la variable de entorno, nunca su valor. Así no
 * hace falta cifrado en reposo y mudar el servicio de host es copiar un .env.
 */
export function createSecretReader(
  entorno: Record<string, string | undefined>,
): SecretReader {
  return (nombreVariable) => {
    const valor = entorno[nombreVariable]
    if (valor === undefined || valor === '') {
      throw new Error(
        `Falta la variable de entorno ${nombreVariable}, referenciada desde la base`,
      )
    }
    return valor
  }
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/secrets.test.ts
```

Esperado: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/secrets.ts src/secrets.test.ts
git commit -m "feat: lector de secretos por nombre de variable de entorno"
```

---

## Task 7: Middleware de autenticación por API key

**Files:**
- Create: `src/middleware/api-key-auth.ts`
- Test: `src/middleware/api-key-auth.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/middleware/api-key-auth.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { App } from '../db/ports.js'
import { hashApiKey } from '../identity/api-key.js'
import { createFakeAppsRepo, unApp } from '../test-support/fake-repos.js'
import { apiKeyAuth, type ConVariablesDeApp } from './api-key-auth.js'

const CLAVE = 'ct_clave_de_prueba'

function armarApp(app: App = unApp()) {
  const repo = createFakeAppsRepo([{ hash: hashApiKey(CLAVE), app }])
  const server = new Hono<ConVariablesDeApp>()
  server.use('/protegido', apiKeyAuth(repo))
  server.get('/protegido', (c) => c.json({ appSlug: c.get('app').slug }))
  return server
}

describe('apiKeyAuth', () => {
  it('deja pasar con la clave correcta y expone la app', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: `Bearer ${CLAVE}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ appSlug: 'gym-tracker' })
  })

  it('rechaza sin header Authorization', async () => {
    const res = await armarApp().request('/protegido')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'unauthorized' })
  })

  it('rechaza un header que no es Bearer', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: `Basic ${CLAVE}` },
    })
    expect(res.status).toBe(401)
  })

  it('rechaza una clave que no corresponde', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: 'Bearer ct_otra_clave' },
    })
    expect(res.status).toBe(401)
  })

  it('nunca devuelve el hash ni la clave en el error', async () => {
    const res = await armarApp().request('/protegido', {
      headers: { Authorization: 'Bearer ct_otra_clave' },
    })
    const cuerpo = await res.text()
    expect(cuerpo).not.toContain('ct_otra_clave')
    expect(cuerpo).not.toContain(hashApiKey(CLAVE))
  })
})
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
bun run test src/middleware/api-key-auth.test.ts
```

Esperado: FAIL — `Cannot find module './api-key-auth.js'`.

- [ ] **Step 3: Escribir la implementación**

`src/middleware/api-key-auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono'
import type { App, AppsRepo } from '../db/ports.js'
import { hashApiKey } from '../identity/api-key.js'

export interface ConVariablesDeApp {
  Variables: { app: App }
}

/**
 * La búsqueda es por hash, no por comparación: el índice de la base hace el
 * trabajo y no queda una comparación de secretos en el proceso. Un hash que no
 * está en la tabla simplemente no matchea.
 */
export function apiKeyAuth(
  apps: AppsRepo,
): MiddlewareHandler<ConVariablesDeApp> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const [esquema, clave] = header.split(' ')

    if (esquema !== 'Bearer' || !clave) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    const app = await apps.findByApiKeyHash(hashApiKey(clave))
    if (!app) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    c.set('app', app)
    await next()
    return undefined
  }
}
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

```bash
bun run test src/middleware/api-key-auth.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/
git commit -m "feat: autenticación de apps por api key con soporte de rotación"
```

---

## Task 8: Rutas REST de vinculación

**Files:**
- Create: `src/routes/link-codes.ts`, `src/routes/contacts.ts`
- Test: `src/routes/link-codes.test.ts`, `src/routes/contacts.test.ts`

- [ ] **Step 1: Escribir el test de `POST /v1/link-codes`**

`src/routes/link-codes.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { LinkCodesRepo } from '../db/ports.js'
import { ALFABETO } from '../identity/link-code.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import { createFakeLinkCodesRepo, unApp } from '../test-support/fake-repos.js'
import { linkCodeRoutes } from './link-codes.js'

const AHORA = new Date('2026-07-28T12:00:00.000Z')

function armar(linkCodes: LinkCodesRepo = createFakeLinkCodesRepo([])) {
  // Hono<ConVariablesDeApp> y no Hono a secas: c.set('app', ...) está tipado.
  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route(
    '/',
    linkCodeRoutes({
      linkCodes,
      now: () => AHORA,
      randomBytes: (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i)),
    }),
  )
  return server
}

async function postear(server: Hono, body: unknown) {
  return server.request('/v1/link-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /v1/link-codes', () => {
  it('emite un código con vencimiento por defecto de 15 minutos', async () => {
    const res = await postear(armar(), { userId: 'user-1' })
    expect(res.status).toBe(201)

    const cuerpo = (await res.json()) as { code: string; expiresAt: string }
    expect(cuerpo.code).toHaveLength(6)
    expect([...cuerpo.code].every((ch) => ALFABETO.includes(ch))).toBe(true)
    expect(cuerpo.expiresAt).toBe('2026-07-28T12:15:00.000Z')
  })

  it('respeta un ttlSeconds explícito', async () => {
    const res = await postear(armar(), { userId: 'user-1', ttlSeconds: 60 })
    const cuerpo = (await res.json()) as { expiresAt: string }
    expect(cuerpo.expiresAt).toBe('2026-07-28T12:01:00.000Z')
  })

  it('guarda el código contra la app autenticada', async () => {
    const repo = createFakeLinkCodesRepo([])
    const res = await postear(armar(repo), { userId: 'user-7' })
    const { code } = (await res.json()) as { code: string }

    const guardado = await repo.find(code)
    expect(guardado?.appId).toBe('app-1')
    expect(guardado?.appUserId).toBe('user-7')
  })

  it('rechaza sin userId', async () => {
    const res = await postear(armar(), {})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_request' })
  })

  it('rechaza un ttlSeconds fuera de rango', async () => {
    expect((await postear(armar(), { userId: 'u', ttlSeconds: 0 })).status).toBe(
      400,
    )
    expect(
      (await postear(armar(), { userId: 'u', ttlSeconds: 99_999 })).status,
    ).toBe(400)
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
bun run test src/routes/link-codes.test.ts
```

Esperado: FAIL — `Cannot find module './link-codes.js'`.

- [ ] **Step 3: Escribir la ruta de códigos**

`src/routes/link-codes.ts`:

```ts
import { Hono } from 'hono'
import * as z from 'zod'
import type { LinkCodesRepo } from '../db/ports.js'
import { generateLinkCode, LARGO_CODIGO } from '../identity/link-code.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'

const TTL_POR_DEFECTO = 15 * 60
const TTL_MAXIMO = 24 * 60 * 60

/**
 * Se piden más bytes que caracteres porque el generador descarta los que
 * introducirían sesgo de módulo. Con 16 bytes la probabilidad de quedarse
 * corto es despreciable.
 */
const BYTES_A_PEDIR = 16

const cuerpoSchema = z.object({
  userId: z.string().min(1),
  ttlSeconds: z.number().int().min(1).max(TTL_MAXIMO).optional(),
})

export interface LinkCodeDeps {
  linkCodes: LinkCodesRepo
  now: () => Date
  randomBytes: (n: number) => Uint8Array
}

export function linkCodeRoutes(deps: LinkCodeDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.post('/v1/link-codes', async (c) => {
    const crudo: unknown = await c.req.json().catch(() => null)
    const parseado = cuerpoSchema.safeParse(crudo)
    if (!parseado.success) {
      return c.json({ code: 'invalid_request' }, 400)
    }

    const app = c.get('app')
    const ttl = parseado.data.ttlSeconds ?? TTL_POR_DEFECTO
    const expiresAt = new Date(deps.now().getTime() + ttl * 1000)
    const code = generateLinkCode(deps.randomBytes(BYTES_A_PEDIR))

    await deps.linkCodes.create({
      code,
      appId: app.id,
      appUserId: parseado.data.userId,
      expiresAt,
    })

    return c.json(
      { code, expiresAt: expiresAt.toISOString(), length: LARGO_CODIGO },
      201,
    )
  })

  return rutas
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
bun run test src/routes/link-codes.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 5: Escribir el test de las rutas de contactos**

`src/routes/contacts.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { ContactsRepo } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'
import {
  createFakeContactsRepo,
  unApp,
  unContacto,
} from '../test-support/fake-repos.js'
import { contactRoutes } from './contacts.js'

function armar(contacts: ContactsRepo) {
  const server = new Hono<ConVariablesDeApp>()
  server.use('*', async (c, next) => {
    c.set('app', unApp())
    await next()
  })
  server.route('/', contactRoutes({ contacts }))
  return server
}

describe('GET /v1/contacts/:userId', () => {
  it('informa que está vinculado', async () => {
    const server = armar(
      createFakeContactsRepo([unContacto({ appUserId: 'user-1' })]),
    )
    const res = await server.request('/v1/contacts/user-1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      linked: true,
      channel: 'telegram',
      linkedAt: '2026-07-28T10:00:00.000Z',
    })
  })

  it('informa que no está vinculado, sin 404', async () => {
    const server = armar(createFakeContactsRepo([]))
    const res = await server.request('/v1/contacts/user-9')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ linked: false })
  })

  it('nunca expone el external_id del chat', async () => {
    const server = armar(
      createFakeContactsRepo([
        unContacto({ appUserId: 'user-1', externalId: '987654' }),
      ]),
    )
    const cuerpo = await (await server.request('/v1/contacts/user-1')).text()
    expect(cuerpo).not.toContain('987654')
  })
})

describe('DELETE /v1/contacts/:userId', () => {
  it('desvincula y avisa', async () => {
    const repo = createFakeContactsRepo([unContacto({ appUserId: 'user-1' })])
    const res = await armar(repo).request('/v1/contacts/user-1', {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unlinked: true })
    expect(await repo.findByAppUserId('app-1', 'telegram', 'user-1')).toBeNull()
  })

  it('es idempotente si no había vínculo', async () => {
    const res = await armar(createFakeContactsRepo([])).request(
      '/v1/contacts/user-9',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unlinked: false })
  })
})
```

El test del `external_id` es deliberado: es el invariante central del spec —la app nunca ve el `chat_id`— convertido en una aserción que rompe si alguien lo agrega al JSON por comodidad.

- [ ] **Step 6: Correr el test para verificar que falla**

```bash
bun run test src/routes/contacts.test.ts
```

Esperado: FAIL — `Cannot find module './contacts.js'`.

- [ ] **Step 7: Escribir las rutas de contactos**

`src/routes/contacts.ts`:

```ts
import { Hono } from 'hono'
import type { ContactsRepo } from '../db/ports.js'
import type { ConVariablesDeApp } from '../middleware/api-key-auth.js'

export interface ContactDeps {
  contacts: ContactsRepo
}

export function contactRoutes(deps: ContactDeps): Hono<ConVariablesDeApp> {
  const rutas = new Hono<ConVariablesDeApp>()

  rutas.get('/v1/contacts/:userId', async (c) => {
    const app = c.get('app')
    const contacto = await deps.contacts.findByAppUserId(
      app.id,
      'telegram',
      c.req.param('userId'),
    )

    if (!contacto) return c.json({ linked: false })

    // Nunca se devuelve externalId: la app no conoce el chat_id.
    return c.json({
      linked: true,
      channel: contacto.channel,
      linkedAt: contacto.linkedAt,
    })
  })

  rutas.delete('/v1/contacts/:userId', async (c) => {
    const app = c.get('app')
    const borrado = await deps.contacts.deleteByAppUserId(
      app.id,
      'telegram',
      c.req.param('userId'),
    )
    return c.json({ unlinked: borrado })
  })

  return rutas
}
```

- [ ] **Step 8: Correr el test para verificar que pasa**

```bash
bun run test src/routes/contacts.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 9: Commit**

```bash
git add src/routes/link-codes.ts src/routes/link-codes.test.ts src/routes/contacts.ts src/routes/contacts.test.ts
git commit -m "feat: rutas REST de emisión de códigos y consulta de vínculos"
```

---

## Task 9: Telegram — parseo de updates y cliente

**Files:**
- Create: `src/channels/telegram/types.ts`, `src/channels/telegram/parse-update.ts`, `src/channels/telegram/client.ts`
- Test: `src/channels/telegram/parse-update.test.ts`, `src/channels/telegram/client.test.ts`

- [ ] **Step 1: Escribir el test de parseo**

`src/channels/telegram/parse-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseCommand, parseTelegramUpdate } from './parse-update.js'

const MENSAJE_DE_TEXTO = {
  update_id: 900_001,
  message: {
    message_id: 42,
    from: { id: 12345, is_bot: false, first_name: 'Juan' },
    chat: { id: 12345, type: 'private' },
    date: 1_785_264_000,
    text: 'banca 4x10 60',
  },
}

describe('parseTelegramUpdate', () => {
  it('extrae chat, texto e ids de un mensaje de texto', () => {
    expect(parseTelegramUpdate(MENSAJE_DE_TEXTO)).toEqual({
      updateId: '900001',
      chatId: '12345',
      messageId: '42',
      text: 'banca 4x10 60',
      replyToMessageId: undefined,
    })
  })

  it('extrae el mensaje al que se responde', () => {
    const conRespuesta = {
      ...MENSAJE_DE_TEXTO,
      message: {
        ...MENSAJE_DE_TEXTO.message,
        reply_to_message: { message_id: 7 },
      },
    }
    expect(parseTelegramUpdate(conRespuesta)?.replyToMessageId).toBe('7')
  })

  it('devuelve texto vacío para un mensaje sin texto, no null', () => {
    const foto = {
      update_id: 900_002,
      message: {
        message_id: 43,
        chat: { id: 12345, type: 'private' },
        date: 1_785_264_000,
        photo: [{ file_id: 'abc' }],
      },
    }
    expect(parseTelegramUpdate(foto)).toMatchObject({ text: '' })
  })

  it('ignora updates sin mensaje', () => {
    expect(
      parseTelegramUpdate({ update_id: 900_003, callback_query: { id: 'x' } }),
    ).toBeNull()
  })

  it('ignora cuerpos que no tienen forma de update', () => {
    expect(parseTelegramUpdate(null)).toBeNull()
    expect(parseTelegramUpdate({})).toBeNull()
    expect(parseTelegramUpdate('hola')).toBeNull()
  })
})

describe('parseCommand', () => {
  it('reconoce un comando con argumentos', () => {
    expect(parseCommand('/vincular ABC123')).toEqual({
      nombre: 'vincular',
      args: 'ABC123',
    })
  })

  it('reconoce un comando sin argumentos', () => {
    expect(parseCommand('/vincular')).toEqual({ nombre: 'vincular', args: '' })
  })

  it('saca el sufijo @NombreDelBot que agrega Telegram en grupos', () => {
    expect(parseCommand('/vincular@GymTrackerBot ABC123')).toEqual({
      nombre: 'vincular',
      args: 'ABC123',
    })
  })

  it('normaliza el nombre a minúsculas', () => {
    expect(parseCommand('/VINCULAR abc')?.nombre).toBe('vincular')
  })

  it('devuelve null si no es un comando', () => {
    expect(parseCommand('banca 4x10 60')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
bun run test src/channels/telegram/parse-update.test.ts
```

Esperado: FAIL — `Cannot find module './parse-update.js'`.

- [ ] **Step 3: Escribir los tipos**

`src/channels/telegram/types.ts`:

```ts
/** Forma normalizada de un update, independiente del proveedor. */
export interface UpdateNormalizado {
  updateId: string
  chatId: string
  messageId: string
  text: string
  replyToMessageId: string | undefined
}

export interface Comando {
  nombre: string
  args: string
}
```

- [ ] **Step 4: Escribir el parser**

`src/channels/telegram/parse-update.ts`:

```ts
import type { Comando, UpdateNormalizado } from './types.js'

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseTelegramUpdate(crudo: unknown): UpdateNormalizado | null {
  if (!esObjeto(crudo)) return null

  const updateId = crudo['update_id']
  const message = crudo['message']
  if (typeof updateId !== 'number' || !esObjeto(message)) return null

  const chat = message['chat']
  const messageId = message['message_id']
  if (!esObjeto(chat) || typeof messageId !== 'number') return null

  const chatId = chat['id']
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return null

  const replyTo = message['reply_to_message']
  const replyToId = esObjeto(replyTo) ? replyTo['message_id'] : undefined

  return {
    updateId: String(updateId),
    chatId: String(chatId),
    messageId: String(messageId),
    // Un mensaje sin texto (foto, audio) llega con text vacío y no se
    // descarta: el spec dice que la app decide qué hacer con él.
    text: typeof message['text'] === 'string' ? message['text'] : '',
    replyToMessageId:
      typeof replyToId === 'number' ? String(replyToId) : undefined,
  }
}

export function parseCommand(texto: string): Comando | null {
  if (!texto.startsWith('/')) return null

  const espacio = texto.indexOf(' ')
  const cabeza = espacio === -1 ? texto : texto.slice(0, espacio)
  const args = espacio === -1 ? '' : texto.slice(espacio + 1).trim()

  // En grupos, Telegram manda /comando@NombreDelBot.
  const nombre = cabeza.slice(1).split('@')[0]?.toLowerCase() ?? ''
  if (nombre === '') return null

  return { nombre, args }
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

```bash
bun run test src/channels/telegram/parse-update.test.ts
```

Esperado: PASS, 10 tests.

- [ ] **Step 6: Escribir el test del cliente**

`src/channels/telegram/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTelegramClient } from './client.js'

function fetchQueDevuelve(estado: number, cuerpo: unknown) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init })
    return new Response(JSON.stringify(cuerpo), { status: estado })
  }
  return { fake, llamadas }
}

describe('createTelegramClient', () => {
  it('postea a sendMessage y devuelve el id del mensaje', async () => {
    const { fake, llamadas } = fetchQueDevuelve(200, {
      ok: true,
      result: { message_id: 77 },
    })
    const cliente = createTelegramClient(fake)

    const resultado = await cliente.sendMessage('TOKEN', '12345', 'hola')

    expect(resultado).toEqual({ messageId: '77' })
    expect(llamadas[0]?.url).toBe(
      'https://api.telegram.org/botTOKEN/sendMessage',
    )
    expect(JSON.parse(String(llamadas[0]?.init?.body))).toEqual({
      chat_id: '12345',
      text: 'hola',
    })
  })

  it('falla si Telegram responde con error', async () => {
    const { fake } = fetchQueDevuelve(400, {
      ok: false,
      description: 'chat not found',
    })
    const cliente = createTelegramClient(fake)

    await expect(cliente.sendMessage('TOKEN', '1', 'hola')).rejects.toThrow(
      /chat not found/,
    )
  })

  it('no incluye el token en el mensaje de error', async () => {
    const { fake } = fetchQueDevuelve(401, { ok: false, description: 'nope' })
    const cliente = createTelegramClient(fake)

    await expect(
      cliente.sendMessage('TOKEN_SECRETO', '1', 'hola'),
    ).rejects.toThrow(/^(?!.*TOKEN_SECRETO).*$/s)
  })
})
```

- [ ] **Step 7: Correr el test para verificar que falla**

```bash
bun run test src/channels/telegram/client.test.ts
```

Esperado: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 8: Escribir el cliente**

`src/channels/telegram/client.ts`:

```ts
export interface TelegramClient {
  sendMessage(
    token: string,
    chatId: string,
    text: string,
  ): Promise<{ messageId: string }>
}

export type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export function createTelegramClient(fetchImpl: Fetch = fetch): TelegramClient {
  return {
    async sendMessage(token, chatId, text) {
      const res = await fetchImpl(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      )

      const cuerpo = (await res.json().catch(() => null)) as {
        ok?: boolean
        result?: { message_id?: number }
        description?: string
      } | null

      if (!res.ok || cuerpo?.ok !== true) {
        // El token va en la URL: nunca se incluye el detalle de la request en
        // el error, solo la descripción que devuelve Telegram.
        throw new Error(
          `Telegram rechazó sendMessage: ${cuerpo?.description ?? res.status}`,
        )
      }

      return { messageId: String(cuerpo.result?.message_id ?? '') }
    },
  }
}
```

- [ ] **Step 9: Correr el test para verificar que pasa**

```bash
bun run test src/channels/telegram/client.test.ts
```

Esperado: PASS, 3 tests.

- [ ] **Step 10: Commit**

```bash
git add src/channels/
git commit -m "feat: parseo de updates y cliente de la bot api de telegram"
```

---

## Task 10: Webhook de Telegram

La ruta más delicada de la fase. Tres decisiones que están en los tests:

- **El secreto se compara con `timingSafeEqual`.** Es el único lugar donde se comparan dos secretos en el proceso.
- **Se valida el código antes de consumirlo.** Si se canjeara primero y después se descubriera que el chat ya está vinculado a otra cuenta, el código quedaría quemado sin haber servido.
- **Un código de otra app se reporta como inexistente**, no como "de otra app": no se filtra entre apps.

**Files:**
- Create: `src/routes/telegram-webhook.ts`
- Test: `src/routes/telegram-webhook.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/routes/telegram-webhook.test.ts`:

```ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Contact, LinkCode } from '../db/ports.js'
import {
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeLinkCodesRepo,
  unBot,
  unContacto,
  unLinkCode,
} from '../test-support/fake-repos.js'
import { telegramWebhookRoutes } from './telegram-webhook.js'

const SECRETO = 'secreto-del-webhook'
const AHORA = new Date('2026-07-28T12:00:00.000Z')

function armar(opts: { contactos?: Contact[]; codigos?: LinkCode[] } = {}) {
  const enviados: { chatId: string; text: string }[] = []
  const contacts = createFakeContactsRepo(opts.contactos ?? [])
  const linkCodes = createFakeLinkCodesRepo(opts.codigos ?? [])

  const server = new Hono()
  server.route(
    '/',
    telegramWebhookRoutes({
      bots: createFakeBotsRepo([unBot()]),
      contacts,
      linkCodes,
      secrets: () => SECRETO,
      now: () => AHORA,
      telegram: {
        async sendMessage(_token, chatId, text) {
          enviados.push({ chatId, text })
          return { messageId: '1' }
        },
      },
    }),
  )

  return { server, enviados, contacts, linkCodes }
}

function update(text: string, chatId = '12345') {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: Number(chatId), type: 'private' },
      date: 1_785_264_000,
      text,
    },
  }
}

async function postear(
  server: Hono,
  cuerpo: unknown,
  secreto: string | null = SECRETO,
  slug = 'gym',
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secreto !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secreto

  return server.request(`/webhooks/telegram/${slug}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(cuerpo),
  })
}

describe('seguridad y ruteo', () => {
  it('rechaza sin el header de secreto', async () => {
    const { server } = armar()
    expect((await postear(server, update('hola'), null)).status).toBe(401)
  })

  it('rechaza con un secreto incorrecto', async () => {
    const { server } = armar()
    expect((await postear(server, update('hola'), 'otro')).status).toBe(401)
  })

  it('devuelve 404 para un bot que no existe', async () => {
    const { server } = armar()
    expect(
      (await postear(server, update('hola'), SECRETO, 'no-existe')).status,
    ).toBe(404)
  })

  it('acepta un update que no puede parsear y responde 200', async () => {
    const { server, enviados } = armar()
    const res = await postear(server, { update_id: 1, callback_query: {} })
    expect(res.status).toBe(200)
    expect(enviados).toHaveLength(0)
  })
})

describe('chat no vinculado', () => {
  it('responde con el unlinked_message del bot', async () => {
    const { server, enviados } = armar()
    const res = await postear(server, update('banca 4x10 60'))

    expect(res.status).toBe(200)
    expect(enviados).toEqual([
      { chatId: '12345', text: 'Vinculá tu cuenta con /vincular <código>.' },
    ])
  })
})

describe('/vincular', () => {
  it('vincula con un código válido', async () => {
    const { server, enviados, contacts } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })
    const res = await postear(server, update('/vincular ABCDEF'))

    expect(res.status).toBe(200)
    expect(enviados[0]?.text).toMatch(/vinculada/i)
    expect(
      (await contacts.findByExternalId('app-1', 'telegram', '12345'))
        ?.appUserId,
    ).toBe('user-1')
  })

  it('acepta el alias /link y el código en minúsculas y con guiones', async () => {
    const { server, contacts } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF' })],
    })
    await postear(server, update('/link abc-def'))
    expect(
      await contacts.findByExternalId('app-1', 'telegram', '12345'),
    ).not.toBeNull()
  })

  it('pide el código si el comando viene sin argumentos', async () => {
    const { server, enviados } = armar()
    await postear(server, update('/vincular'))
    expect(enviados[0]?.text).toMatch(/código/i)
  })

  it('avisa cuando el código está vencido, sin consumirlo', async () => {
    const { server, enviados, linkCodes } = armar({
      codigos: [
        unLinkCode({ code: 'ABCDEF', expiresAt: '2026-07-28T11:00:00.000Z' }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/vencido/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('avisa cuando el código ya fue usado', async () => {
    const { server, enviados } = armar({
      codigos: [
        unLinkCode({ code: 'ABCDEF', usedAt: '2026-07-28T11:00:00.000Z' }),
      ],
    })
    await postear(server, update('/vincular ABCDEF'))
    expect(enviados[0]?.text).toMatch(/ya se us/i)
  })

  it('trata un código de otra app como inexistente', async () => {
    const { server, enviados, linkCodes } = armar({
      codigos: [unLinkCode({ code: 'ABCDEF', appId: 'otra-app' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/no existe/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('es idempotente si el chat ya está vinculado a ese mismo usuario', async () => {
    const { server, enviados, linkCodes } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-1' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/ya estab/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })

  it('rechaza vincular un chat que ya pertenece a otra cuenta, sin quemar el código', async () => {
    const { server, enviados, linkCodes } = armar({
      contactos: [unContacto({ externalId: '12345', appUserId: 'user-1' })],
      codigos: [unLinkCode({ code: 'ABCDEF', appUserId: 'user-2' })],
    })
    await postear(server, update('/vincular ABCDEF'))

    expect(enviados[0]?.text).toMatch(/otra cuenta/i)
    expect((await linkCodes.find('ABCDEF'))?.usedAt).toBeNull()
  })
})
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
bun run test src/routes/telegram-webhook.test.ts
```

Esperado: FAIL — `Cannot find module './telegram-webhook.js'`.

- [ ] **Step 3: Escribir el webhook**

`src/routes/telegram-webhook.ts`:

```ts
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { parseCommand, parseTelegramUpdate } from '../channels/telegram/parse-update.js'
import type { TelegramClient } from '../channels/telegram/client.js'
import type { Bot, BotsRepo, ContactsRepo, LinkCodesRepo } from '../db/ports.js'
import { normalizeLinkCode } from '../identity/link-code.js'
import type { SecretReader } from '../secrets.js'

export interface TelegramWebhookDeps {
  bots: BotsRepo
  contacts: ContactsRepo
  linkCodes: LinkCodesRepo
  telegram: TelegramClient
  secrets: SecretReader
  now: () => Date
}

const COMANDOS_DE_VINCULACION = new Set(['vincular', 'link'])

function secretosIguales(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function telegramWebhookRoutes(deps: TelegramWebhookDeps): Hono {
  const rutas = new Hono()

  rutas.post('/webhooks/telegram/:botSlug', async (c) => {
    const bot = await deps.bots.findBySlug(c.req.param('botSlug'))
    if (!bot || !bot.active) return c.json({ code: 'not_found' }, 404)

    const recibido = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? ''
    if (!secretosIguales(recibido, deps.secrets(bot.webhookSecretEnv))) {
      return c.json({ code: 'unauthorized' }, 401)
    }

    const crudo: unknown = await c.req.json().catch(() => null)
    const update = parseTelegramUpdate(crudo)
    // Un update que no sabemos leer (callback_query, edición, encuesta) se
    // acepta y se descarta: devolverle un error a Telegram provocaría
    // reintentos eternos de algo que nunca vamos a poder procesar.
    if (!update) return c.json({ ok: true })

    const token = deps.secrets(bot.tokenEnv)
    const responder = (texto: string) =>
      deps.telegram.sendMessage(token, update.chatId, texto)

    const comando = parseCommand(update.text)
    if (comando && COMANDOS_DE_VINCULACION.has(comando.nombre)) {
      await responder(await vincular(deps, bot, update.chatId, comando.args))
      return c.json({ ok: true })
    }

    const contacto = await deps.contacts.findByExternalId(
      bot.appId,
      'telegram',
      update.chatId,
    )
    if (!contacto) {
      await responder(bot.unlinkedMessage)
      return c.json({ ok: true })
    }

    // FASE 2: acá va el registro en inbound_messages y la entrega a la app
    // con HMAC y reintentos. Por ahora el mensaje de un chat vinculado se
    // reconoce y se descarta.
    return c.json({ ok: true })
  })

  return rutas
}

async function vincular(
  deps: TelegramWebhookDeps,
  bot: Bot,
  chatId: string,
  args: string,
): Promise<string> {
  const code = normalizeLinkCode(args)
  if (!code) {
    return 'Mandame el código junto al comando, por ejemplo: /vincular ABC123'
  }

  // Se valida ANTES de consumir: si canjeáramos primero y después
  // descubriéramos que el chat ya está tomado, el código quedaría quemado.
  const candidato = await deps.linkCodes.find(code)

  // Un código de otra app se reporta como inexistente: no se filtra
  // información entre apps.
  if (!candidato || candidato.appId !== bot.appId) {
    return 'Ese código no existe. Generá uno nuevo desde la app.'
  }
  if (candidato.usedAt !== null) {
    return 'Ese código ya se usó. Generá uno nuevo desde la app.'
  }
  if (new Date(candidato.expiresAt) <= deps.now()) {
    return 'Ese código está vencido. Generá uno nuevo desde la app.'
  }

  const existente = await deps.contacts.findByExternalId(
    bot.appId,
    'telegram',
    chatId,
  )
  if (existente?.appUserId === candidato.appUserId) {
    return 'Ya estabas vinculado. No hace falta hacer nada.'
  }
  if (existente) {
    return 'Este chat ya está vinculado a otra cuenta. Desvinculala primero desde la app.'
  }

  const canjeado = await deps.linkCodes.redeem(code, deps.now())
  if (!canjeado) {
    return 'No se pudo canjear el código. Generá uno nuevo desde la app.'
  }

  await deps.contacts.create({
    appId: bot.appId,
    channel: 'telegram',
    externalId: chatId,
    appUserId: canjeado.appUserId,
  })

  return 'Listo, tu cuenta quedó vinculada.'
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

```bash
bun run test src/routes/telegram-webhook.test.ts
```

Esperado: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes/telegram-webhook.ts src/routes/telegram-webhook.test.ts
git commit -m "feat: webhook de telegram con /vincular y respuesta a no vinculados"
```

---

## Task 11: Cableado

**Files:**
- Modify: `src/create-app.ts`, `src/index.ts`, `src/routes/health.test.ts`
- Create: `src/test-support/fake-deps.ts`

- [ ] **Step 1: Escribir el armador de dependencias falsas**

`src/test-support/fake-deps.ts`:

```ts
import type { Deps } from '../create-app.js'
import { createFakeDb } from './fake-db.js'
import {
  createFakeAppsRepo,
  createFakeBotsRepo,
  createFakeContactsRepo,
  createFakeLinkCodesRepo,
} from './fake-repos.js'

export function createFakeDeps(over: Partial<Deps> = {}): Deps {
  return {
    db: createFakeDb(),
    apps: createFakeAppsRepo([]),
    bots: createFakeBotsRepo([]),
    contacts: createFakeContactsRepo([]),
    linkCodes: createFakeLinkCodesRepo([]),
    telegram: {
      async sendMessage() {
        return { messageId: '1' }
      },
    },
    secrets: () => 'secreto',
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    randomBytes: (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i)),
    ...over,
  }
}
```

- [ ] **Step 2: Reescribir `create-app.ts`**

```ts
import { Hono } from 'hono'
import type { TelegramClient } from './channels/telegram/client.js'
import type { Db } from './db/client.js'
import type {
  AppsRepo,
  BotsRepo,
  ContactsRepo,
  LinkCodesRepo,
} from './db/ports.js'
import {
  apiKeyAuth,
  type ConVariablesDeApp,
} from './middleware/api-key-auth.js'
import { contactRoutes } from './routes/contacts.js'
import { healthRoutes } from './routes/health.js'
import { linkCodeRoutes } from './routes/link-codes.js'
import { telegramWebhookRoutes } from './routes/telegram-webhook.js'
import type { SecretReader } from './secrets.js'

export interface Deps {
  db: Db
  apps: AppsRepo
  bots: BotsRepo
  contacts: ContactsRepo
  linkCodes: LinkCodesRepo
  telegram: TelegramClient
  secrets: SecretReader
  now: () => Date
  randomBytes: (n: number) => Uint8Array
}

/**
 * Construye la app con sus dependencias inyectadas.
 * No lee process.env: eso es responsabilidad de src/index.ts.
 */
export function createApp(deps: Deps): Hono {
  const app = new Hono()

  app.route('/', healthRoutes(deps.db))

  // El webhook se autentica con el secreto de Telegram, no con API key:
  // va montado antes y fuera del middleware de apps.
  app.route('/', telegramWebhookRoutes(deps))

  // Todo /v1 exige API key.
  const v1 = new Hono<ConVariablesDeApp>()
  v1.use('*', apiKeyAuth(deps.apps))
  v1.route('/', linkCodeRoutes(deps))
  v1.route('/', contactRoutes(deps))
  app.route('/', v1)

  return app
}
```

- [ ] **Step 3: Actualizar el test de health para usar las dependencias falsas**

En `src/routes/health.test.ts`, reemplazá el import y las cuatro construcciones:

```ts
import { describe, expect, it } from 'vitest'
import { createApp } from '../create-app.js'
import { createFakeDb } from '../test-support/fake-db.js'
import { createFakeDeps } from '../test-support/fake-deps.js'
```

y cambiá cada `createApp({ db })` por `createApp(createFakeDeps({ db }))`.

- [ ] **Step 4: Reescribir `src/index.ts`**

```ts
import type { Hono } from 'hono'
import { createTelegramClient } from './channels/telegram/client.js'
import { createApp } from './create-app.js'
import { createDb, createSql } from './db/client.js'
import { createAppsRepo } from './db/repositories/apps.js'
import { createBotsRepo } from './db/repositories/bots.js'
import { createContactsRepo } from './db/repositories/contacts.js'
import { createLinkCodesRepo } from './db/repositories/link-codes.js'
import { parseEnv } from './env.js'
import { createSecretReader } from './secrets.js'

// Único lugar del servicio que lee process.env.
const env = parseEnv(process.env)
const sql = createSql(env.DATABASE_URL)

const app: Hono = createApp({
  db: createDb(sql),
  apps: createAppsRepo(sql),
  bots: createBotsRepo(sql),
  contacts: createContactsRepo(sql),
  linkCodes: createLinkCodesRepo(sql),
  telegram: createTelegramClient(),
  secrets: createSecretReader(process.env),
  now: () => new Date(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
})

// El default export es lo que consumen tanto Vercel como Bun.
export default app
```

**No borres el `import type { Hono }`.** El preset de Hono de Vercel rechaza cualquier entrypoint que no importe `hono` — ver `CLAUDE.md`, §Gotchas del tooling.

- [ ] **Step 5: Verificar todo junto**

```bash
bun run typecheck
bun run lint
bun run test
```

Esperado: los tres en verde, sin tests salteados si `DATABASE_URL` está cargada.

- [ ] **Step 6: Verificar el entrypoint del build de Vercel**

```bash
bun --bun x vercel build --yes >/dev/null 2>&1 && grep handler .vercel/output/functions/index.func/.vc-config.json
```

Esperado: `"handler": "src/index.js"`. Si dijera otra cosa, el deploy va a romper en runtime aunque todo lo demás esté verde.

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "feat: cableado de las rutas de identidad"
```

---

## Task 12: Alta del primer bot y verificación end-to-end

Esta tarea necesita al usuario: hay que crear el bot en Telegram.

**Files:**
- Create: `scripts/registrar-app.ts`

- [ ] **Step 1: Crear el bot en Telegram**

En Telegram, hablale a **@BotFather**: `/newbot`, nombre `GymTracker`, username terminado en `bot`. Guardá el token que devuelve.

- [ ] **Step 2: Generar el secreto del webhook y la API key**

```bash
bun -e "const b=(n)=>Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('hex'); console.log('TELEGRAM_WEBHOOK_SECRET_GYM=' + b(32)); console.log('DELIVERY_SECRET_GYM=' + b(32)); console.log('API KEY (guardala, no se puede recuperar): ct_' + b(32))"
```

- [ ] **Step 3: Cargar las variables**

En `.env` local y en Vercel (entorno Production):

```
TELEGRAM_TOKEN_GYM=<el token de BotFather>
TELEGRAM_WEBHOOK_SECRET_GYM=<el primero del paso 2>
DELIVERY_SECRET_GYM=<el segundo del paso 2>
```

- [ ] **Step 4: Sumar `scripts` al tsconfig**

En `tsconfig.json`, extendé `include` para que el script se typechequee y no quede como código muerto sin verificar:

```json
  "include": ["src", "scripts", "*.ts", "*.mjs"]
```

- [ ] **Step 5: Escribir el script de alta**

`scripts/registrar-app.ts`:

```ts
import { Client } from '@neondatabase/serverless'
import { hashApiKey } from '../src/identity/api-key.js'

const [apiKey] = process.argv.slice(2)
if (!apiKey) {
  console.error('Uso: bun run scripts/registrar-app.ts <api-key>')
  process.exit(1)
}

const client = new Client(process.env.DATABASE_URL)
await client.connect()

const { rows } = await client.query<{ id: string }>(
  `INSERT INTO apps (slug, name, api_key_hash, delivery_url, delivery_secret_env)
   VALUES ('gym-tracker', 'GymTracker',
           $1, 'https://gym-tracker.vercel.app/api/messaging/inbound',
           'DELIVERY_SECRET_GYM')
   ON CONFLICT (slug) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash
   RETURNING id`,
  [hashApiKey(apiKey)],
)
const fila = rows[0]
if (!fila) throw new Error('El INSERT de apps no devolvió el id')
const appId = fila.id

await client.query(
  `INSERT INTO bots (app_id, channel, slug, username, token_env,
                     webhook_secret_env, unlinked_message)
   VALUES ($1, 'telegram', 'gym', 'GymTrackerBot', 'TELEGRAM_TOKEN_GYM',
           'TELEGRAM_WEBHOOK_SECRET_GYM',
           'Hola. Para usar este bot vinculá tu cuenta: entrá a GymTracker, generá un código y mandámelo con /vincular <código>.')
   ON CONFLICT (slug) DO NOTHING`,
  [appId],
)

console.log(`app gym-tracker: ${appId}`)
await client.end()
```

La `delivery_url` apunta a donde GymTracker va a exponer su endpoint. Todavía no existe —es la fase 2 de este proyecto y la fase 3 de GymTracker— y no molesta: en esta fase nadie la usa.

- [ ] **Step 6: Correr el alta**

```bash
bun run scripts/registrar-app.ts <la-api-key-del-paso-2>
```

Esperado: `app gym-tracker: <uuid>`.

- [ ] **Step 7: Registrar el webhook en Telegram**

```bash
bun -e "const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN_GYM + '/setWebhook', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({url: 'https://communication-tool-beta.vercel.app/webhooks/telegram/gym', secret_token: process.env.TELEGRAM_WEBHOOK_SECRET_GYM, allowed_updates: ['message']})}); console.log(await r.json())"
```

Esperado: `{ ok: true, result: true, description: 'Webhook was set' }`.

- [ ] **Step 8: Verificar la emisión de códigos contra producción**

```bash
curl -s -X POST https://communication-tool-beta.vercel.app/v1/link-codes \
  -H "Authorization: Bearer <la-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"userId":"prueba-1"}'
```

Esperado: `{"code":"XXXXXX","expiresAt":"...","length":6}`.

Y que sin la clave rebote:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://communication-tool-beta.vercel.app/v1/link-codes \
  -H "Content-Type: application/json" -d '{"userId":"x"}'
```

Esperado: `401`.

- [ ] **Step 9: Verificar el flujo completo por Telegram**

En Telegram, abrí tu bot y:

1. Mandá `hola` → tiene que responder el mensaje de no vinculado.
2. Mandá `/vincular` sin código → tiene que pedirte el código.
3. Mandá `/vincular <el código del paso 7>` → `Listo, tu cuenta quedó vinculada.`
4. Repetí el mismo `/vincular` → `Ya estabas vinculado.`
5. Mandá `hola` de nuevo → **no** tiene que responder nada (chat vinculado, y la entrega es la fase 2).

- [ ] **Step 10: Verificar el estado por API y desvincular**

```bash
curl -s https://communication-tool-beta.vercel.app/v1/contacts/prueba-1 \
  -H "Authorization: Bearer <la-api-key>"
```

Esperado: `{"linked":true,"channel":"telegram","linkedAt":"..."}` — y **sin `externalId`**, que es el invariante del spec.

```bash
curl -s -X DELETE https://communication-tool-beta.vercel.app/v1/contacts/prueba-1 \
  -H "Authorization: Bearer <la-api-key>"
```

Esperado: `{"unlinked":true}`. Repetir devuelve `{"unlinked":false}`.

- [ ] **Step 11: Commit**

```bash
git add scripts/ tsconfig.json
git commit -m "chore: script de alta de apps y bots"
```

---

## Verificación de la fase

- [ ] `bun run lint && bun run typecheck && bun run test` en verde.
- [ ] CI en verde en GitHub.
- [ ] `bun run db:migrate` reporta `Sin migraciones pendientes (1 aplicadas).`
- [ ] Los tests de integración de repositorios pasan con `DATABASE_URL` y se saltean sin ella.
- [ ] `POST /v1/link-codes` en producción devuelve 201 con clave, 401 sin ella.
- [ ] `GET /v1/contacts/:userId` **no** incluye `externalId` en la respuesta.
- [ ] El flujo completo por Telegram funciona: no vinculado → `/vincular` → vinculado → repetición idempotente.
- [ ] El webhook rechaza con 401 un POST sin el header de secreto:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://communication-tool-beta.vercel.app/webhooks/telegram/gym \
  -H 'Content-Type: application/json' -d '{}'
```

Esperado: `401`. Este es el que importa: si diera 200, cualquiera en internet podría inyectar mensajes falsos en el sistema.
