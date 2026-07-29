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
