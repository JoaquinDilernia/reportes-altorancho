-- El agente de pauta pasa a ser por plataforma ('meta' | 'google'): lo que ya existe queda como 'meta'.

ALTER TABLE ad_runs ADD COLUMN platform text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google'));
ALTER TABLE ad_decisions ADD COLUMN platform text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google'));
ALTER TABLE ad_creatives ADD COLUMN platform text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google'));
ALTER TABLE ad_creative_requests ADD COLUMN platform text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google'));
ALTER TABLE ad_learnings ADD COLUMN platform text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google'));
ALTER TABLE ad_questions ADD COLUMN platform text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google'));

CREATE INDEX ad_runs_platform_recent ON ad_runs (platform, started_at DESC);
CREATE INDEX ad_decisions_platform_recent ON ad_decisions (platform, created_at DESC);
CREATE INDEX ad_questions_platform_open ON ad_questions (platform, created_at DESC) WHERE status = 'open';

-- Una fila de ajustes por plataforma (id 1 = meta, id 2 = google).
-- autonomous es el interruptor de la pausa automática.
ALTER TABLE ad_settings DROP CONSTRAINT ad_settings_id_check;
ALTER TABLE ad_settings ADD COLUMN platform text NOT NULL DEFAULT 'meta' UNIQUE CHECK (platform IN ('meta','google'));
ALTER TABLE ad_settings ADD COLUMN auto_pause_min_spend_ars integer NOT NULL DEFAULT 0 CHECK (auto_pause_min_spend_ars >= 0);
ALTER TABLE ad_settings ADD COLUMN auto_pause_days smallint NOT NULL DEFAULT 7 CHECK (auto_pause_days BETWEEN 1 AND 30);
-- Resource name de la acción de conversión de Google (null en Meta)
ALTER TABLE ad_settings ADD COLUMN purchase_action text;
INSERT INTO ad_settings (id, platform, agent_enabled) VALUES (2, 'google', false);

-- En Google, meta_ad_id / meta_adset_id guardan el recurso creado y el grupo de anuncios destino.
ALTER TABLE ad_creatives ADD COLUMN headlines jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ad_creatives ADD COLUMN long_headline text NOT NULL DEFAULT '';
ALTER TABLE ad_creatives ADD COLUMN descriptions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ad_creatives ADD COLUMN youtube_url text;

ALTER TABLE ad_creative_media DROP CONSTRAINT ad_creative_media_slot_check;
ALTER TABLE ad_creative_media ADD CONSTRAINT ad_creative_media_slot_check CHECK (slot IN ('feed','story','landscape','square','portrait'));
-- Resource name del asset en Google
ALTER TABLE ad_creative_media ADD COLUMN asset_name text;

-- Cada cambio de ajustes, con valor anterior y nuevo
CREATE TABLE ad_settings_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('meta','google')),
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_settings_log_recent ON ad_settings_log (platform, changed_at DESC);

-- Foto de resultados al activar el agente o al desplegar, para comparar después
CREATE TABLE ad_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('meta','google')),
  reason text NOT NULL CHECK (reason IN ('activated','deploy')),
  data jsonb NOT NULL DEFAULT '{}',
  taken_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_baselines_recent ON ad_baselines (platform, taken_at DESC);
