import type { Sql } from '../client.js'
import type {
  Channel,
  OutboundKind,
  OutboundMessage,
  OutboundMessagesRepo,
  OutboundStatus,
  OutboundTemplate,
} from '../ports.js'

interface Fila {
  id: string
  app_id: string
  contact_id: string | null
  app_user_id: string
  channel: string
  kind: string
  text: string
  template: unknown
  reply_to_message_id: string | null
  provider_message_id: string | null
  status: string
  error: string | null
  idempotency_key: string | null
  created_at: string
}

function aSaliente(f: Fila): OutboundMessage {
  return {
    id: f.id,
    appId: f.app_id,
    contactId: f.contact_id,
    appUserId: f.app_user_id,
    channel: f.channel as Channel,
    kind: f.kind as OutboundKind,
    text: f.text,
    template: (f.template ?? null) as OutboundTemplate | null,
    replyToMessageId: f.reply_to_message_id,
    providerMessageId: f.provider_message_id,
    status: f.status as OutboundStatus,
    error: f.error,
    idempotencyKey: f.idempotency_key,
    createdAt: new Date(f.created_at).toISOString(),
  }
}

export function createOutboundMessagesRepo(sql: Sql): OutboundMessagesRepo {
  return {
    async claim(input) {
      // Todo en UN statement: con el driver HTTP no hay transacciones, así que
      // la atomicidad tiene que estar en el SQL.
      //
      // El WHERE del DO UPDATE es el que decide. Solo se vuelve a tomar una
      // fila `failed`; si está `sending` o `sent` el UPDATE no afecta ninguna
      // fila, el RETURNING viene vacío, y quien llama se entera de que el
      // envío no es suyo. Y como el DO UPDATE no toca `text` ni `kind`, un
      // reintento reenvía el mensaje original aunque el cuerpo haya cambiado.
      const filas = (await sql`
        INSERT INTO outbound_messages (
          app_id, contact_id, app_user_id, channel, kind, text, template,
          reply_to_message_id, idempotency_key, status
        ) VALUES (
          ${input.appId}, ${input.contactId}, ${input.appUserId},
          ${input.channel}, ${input.kind}, ${input.text},
          ${input.template === null ? null : JSON.stringify(input.template)}::jsonb,
          ${input.replyToMessageId}, ${input.idempotencyKey}, 'sending'
        )
        ON CONFLICT (app_id, idempotency_key) DO UPDATE
        SET status = 'sending',
            error = NULL,
            provider_message_id = NULL
        WHERE outbound_messages.status = 'failed'
        RETURNING *
      `) as Fila[]
      const fila = filas[0]
      return fila ? aSaliente(fila) : null
    },

    async findByIdempotencyKey(appId, idempotencyKey) {
      const filas = (await sql`
        SELECT * FROM outbound_messages
        WHERE app_id = ${appId} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `) as Fila[]
      const fila = filas[0]
      return fila ? aSaliente(fila) : null
    },

    async marcarEnviado(id, providerMessageId) {
      await sql`
        UPDATE outbound_messages
        SET status = 'sent',
            provider_message_id = ${providerMessageId},
            error = NULL
        WHERE id = ${id}
      `
    },

    async marcarFallido(id, error) {
      await sql`
        UPDATE outbound_messages
        SET status = 'failed', error = ${error}
        WHERE id = ${id}
      `
    },
  }
}
