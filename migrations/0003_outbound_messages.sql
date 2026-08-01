CREATE TABLE outbound_messages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  contact_id          uuid        REFERENCES contacts (id) ON DELETE SET NULL,
  app_user_id         text        NOT NULL,
  channel             text        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  kind                text        NOT NULL CHECK (kind IN ('reply', 'notification')),
  text                text        NOT NULL,
  template            jsonb,
  reply_to_message_id text,
  provider_message_id text,
  status              text        NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'failed')),
  error               text,
  idempotency_key     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Postgres trata los NULL como distintos entre sí, así que las llamadas sin
  -- clave nunca chocan y no hace falta un índice parcial ni un centinela.
  UNIQUE (app_id, idempotency_key)
);

-- Para inspeccionar el log de una app por SQL, que es la única UI que hay.
CREATE INDEX outbound_messages_app_created_idx
  ON outbound_messages (app_id, created_at DESC);

-- Un bot por app y canal (spec, §Decisiones cerradas). Sin esto "el bot de
-- esta app" es ambiguo y un saliente podría salir por un bot distinto en cada
-- request. Parcial sobre `active` para poder desactivar un bot y dar de alta
-- su reemplazo sin que choquen.
CREATE UNIQUE INDEX bots_app_channel_unico
  ON bots (app_id, channel)
  WHERE active;
