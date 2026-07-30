CREATE TABLE inbound_messages (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id             uuid        NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  app_id             uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  channel            text        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  provider_update_id text        NOT NULL,
  external_id        text        NOT NULL,
  app_user_id        text,
  text               text        NOT NULL DEFAULT '',
  reply_to_message_id text,
  raw                jsonb       NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  delivery_status    text        NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'skipped')),
  delivery_attempts  int         NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  delivered_at       timestamptz,
  last_error         text,
  UNIQUE (bot_id, provider_update_id)
);

-- Índice parcial: el ticker solo pregunta por pendientes vencidos, y en un
-- historial largo los entregados son el 99%.
CREATE INDEX inbound_messages_pendientes_idx
  ON inbound_messages (next_attempt_at)
  WHERE delivery_status = 'pending';
