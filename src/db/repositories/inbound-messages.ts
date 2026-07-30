import type { Sql } from '../client.js'
import type {
  Channel,
  DeliveryStatus,
  InboundMessage,
  InboundMessagesRepo,
} from '../ports.js'

interface Fila {
  id: string
  bot_id: string
  app_id: string
  channel: string
  provider_update_id: string
  external_id: string
  app_user_id: string | null
  text: string
  reply_to_message_id: string | null
  raw: unknown
  received_at: string
  delivery_status: string
  delivery_attempts: number
  next_attempt_at: string | null
  delivered_at: string | null
  last_error: string | null
}

function aMensaje(f: Fila): InboundMessage {
  return {
    id: f.id,
    botId: f.bot_id,
    appId: f.app_id,
    channel: f.channel as Channel,
    providerUpdateId: f.provider_update_id,
    externalId: f.external_id,
    appUserId: f.app_user_id,
    text: f.text,
    replyToMessageId: f.reply_to_message_id,
    raw: f.raw,
    receivedAt: new Date(f.received_at).toISOString(),
    deliveryStatus: f.delivery_status as DeliveryStatus,
    deliveryAttempts: f.delivery_attempts,
    nextAttemptAt: f.next_attempt_at
      ? new Date(f.next_attempt_at).toISOString()
      : null,
    deliveredAt: f.delivered_at ? new Date(f.delivered_at).toISOString() : null,
    lastError: f.last_error,
  }
}

/** Cuánto se reserva un mensaje mientras un tick lo procesa. */
const LEASE_MS = 5 * 60_000

export function createInboundMessagesRepo(sql: Sql): InboundMessagesRepo {
  return {
    async insertIfNew(input) {
      const filas = (await sql`
        INSERT INTO inbound_messages (
          bot_id, app_id, channel, provider_update_id, external_id,
          app_user_id, text, reply_to_message_id, raw, delivery_status,
          next_attempt_at
        ) VALUES (
          ${input.botId}, ${input.appId}, ${input.channel},
          ${input.providerUpdateId}, ${input.externalId}, ${input.appUserId},
          ${input.text}, ${input.replyToMessageId},
          ${JSON.stringify(input.raw)}::jsonb, ${input.deliveryStatus},
          ${input.nextAttemptAt?.toISOString() ?? null}
        )
        ON CONFLICT (bot_id, provider_update_id) DO NOTHING
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      return fila ? aMensaje(fila) : null
    },

    async findById(id) {
      const filas = (await sql`
        SELECT * FROM inbound_messages WHERE id = ${id} LIMIT 1
      `) as Fila[]
      const fila = filas[0]
      return fila ? aMensaje(fila) : null
    },

    async claimPendientes(ahora, limite) {
      // El claim va en UN statement. Con el driver HTTP no hay transacciones,
      // así que la atomicidad tiene que estar en el SQL: SKIP LOCKED hace que
      // dos ticks simultáneos tomen filas distintas.
      //
      // Corre next_attempt_at hacia adelante como lease. Si este tick muere a
      // la mitad, el mensaje vuelve a estar disponible al vencer el lease en
      // vez de quedar trabado para siempre.
      const lease = new Date(ahora.getTime() + LEASE_MS)
      const filas = (await sql`
        UPDATE inbound_messages
        SET next_attempt_at = ${lease.toISOString()}
        WHERE id IN (
          SELECT id FROM inbound_messages
          WHERE delivery_status = 'pending'
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ${ahora.toISOString()}
          ORDER BY next_attempt_at
          LIMIT ${limite}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `) as Fila[]
      return filas.map(aMensaje)
    },

    async marcarEntregado(id, ahora) {
      await sql`
        UPDATE inbound_messages
        SET delivery_status = 'delivered',
            delivered_at = ${ahora.toISOString()},
            next_attempt_at = NULL,
            last_error = NULL
        WHERE id = ${id}
      `
    },

    async marcarReintento(id, proximoIntento, error) {
      await sql`
        UPDATE inbound_messages
        SET delivery_status = 'pending',
            delivery_attempts = delivery_attempts + 1,
            next_attempt_at = ${proximoIntento.toISOString()},
            last_error = ${error}
        WHERE id = ${id}
      `
    },

    async marcarFallido(id, error) {
      await sql`
        UPDATE inbound_messages
        SET delivery_status = 'failed',
            delivery_attempts = delivery_attempts + 1,
            next_attempt_at = NULL,
            last_error = ${error}
        WHERE id = ${id}
      `
    },

    async reencolar(id, ahora) {
      const filas = (await sql`
        UPDATE inbound_messages
        SET delivery_status = 'pending',
            delivery_attempts = 0,
            next_attempt_at = ${ahora.toISOString()},
            last_error = NULL
        WHERE id = ${id} AND delivery_status = 'failed'
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      return fila ? aMensaje(fila) : null
    },
  }
}
