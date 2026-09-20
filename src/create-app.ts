import { Hono } from 'hono'
import type { TelegramClient } from './channels/telegram/client.js'
import type { Db } from './db/client.js'
import type {
  AppsRepo,
  BotsRepo,
  ContactsRepo,
  InboundMessagesRepo,
  LinkCodesRepo,
  OutboundMessagesRepo,
  SchedulesRepo,
} from './db/ports.js'
import type { DeliveryClient } from './delivery/client.js'
import { apiKeyAuth, type ConVariablesDeApp } from './middleware/api-key-auth.js'
import { internalAuth } from './middleware/internal-auth.js'
import { contactRoutes } from './routes/contacts.js'
import { healthRoutes } from './routes/health.js'
import { internalRoutes } from './routes/internal.js'
import { linkCodeRoutes } from './routes/link-codes.js'
import { mcpRoutes, sinOrigen } from './routes/mcp.js'
import { messageRoutes } from './routes/messages.js'
import { scheduleRoutes } from './routes/schedules.js'
import { telegramWebhookRoutes } from './routes/telegram-webhook.js'
import type { PresupuestoDeRespuestas } from './presupuesto.js'
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
  inbound: InboundMessagesRepo
  outbound: OutboundMessagesRepo
  schedules: SchedulesRepo
  delivery: DeliveryClient
  internalSecret: string
  presupuesto: PresupuestoDeRespuestas
  waitUntil: (promesa: Promise<unknown>) => void
  sleep: (ms: number) => Promise<void>
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

  // Rutas internas: las llama el ticker, no una app. Auth por secreto propio.
  const interno = new Hono()
  interno.use('/internal/*', internalAuth(deps.internalSecret))
  interno.route('/', internalRoutes(deps))
  app.route('/', interno)

  // Todo /v1 exige API key. El patrón es '/v1/*' y NO '*': con '*' el
  // middleware corre sobre cualquier ruta no matcheada y una URL inexistente
  // devuelve 401 en vez de 404.
  const v1 = new Hono<ConVariablesDeApp>()
  v1.use('/v1/*', apiKeyAuth(deps.apps))
  v1.route('/', linkCodeRoutes(deps))
  v1.route('/', contactRoutes(deps))
  v1.route('/', messageRoutes(deps))
  v1.route('/', scheduleRoutes(deps))
  app.route('/', v1)

  // El servidor MCP. Misma autenticación que /v1: la API key de la app. El
  // chequeo de Origin va ANTES de la auth, porque es una defensa contra que un
  // navegador llegue acá, y eso no debería depender de tener la clave.
  const mcp = new Hono<ConVariablesDeApp>()
  mcp.use('/mcp', sinOrigen())
  mcp.use('/mcp', apiKeyAuth(deps.apps))
  mcp.route('/', mcpRoutes(deps))
  app.route('/', mcp)

  return app
}
