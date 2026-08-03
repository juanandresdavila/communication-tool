CREATE TABLE schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  app_user_id  text        NOT NULL,
  name         text        NOT NULL,
  cron         text        NOT NULL,
  timezone     text        NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  -- Nullable a propósito: un programado desactivado no tiene próxima
  -- ejecución, y dejarlo en NULL lo saca del índice parcial sin borrarlo.
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_status  text        CHECK (last_status IN ('fired', 'failed', 'missed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, app_user_id, name)
);

-- Índice parcial, igual que el de entrantes: el ticker solo pregunta por
-- activos vencidos, y en un historial largo la mayoría no lo está.
CREATE INDEX schedules_vencidos_idx
  ON schedules (next_run_at)
  WHERE active;
