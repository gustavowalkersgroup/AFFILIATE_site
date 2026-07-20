-- Schema do sistema AFFILIATE (idempotente: pode rodar várias vezes)

CREATE TABLE IF NOT EXISTS offers (
  id              BIGSERIAL PRIMARY KEY,
  marketplace     TEXT NOT NULL CHECK (marketplace IN ('shopee', 'meli', 'amazon', 'aliexpress')),
  external_id     TEXT,                      -- itemId (Shopee) / MLB (ML) / ASIN (Amazon) / productId (AliExpress)
  title           TEXT NOT NULL,
  price_from      NUMERIC(12,2),             -- preço "de" (ancoragem)
  price           NUMERIC(12,2) NOT NULL,    -- preço atual "por"
  discount_pct    INTEGER DEFAULT 0,
  commission_rate NUMERIC(6,4) DEFAULT 0,    -- fração decimal, ex.: 0.0850 = 8,5%
  sales           INTEGER DEFAULT 0,
  rating          NUMERIC(3,2),
  image_url       TEXT,
  product_url     TEXT,
  affiliate_url   TEXT,                      -- link final com a nossa tag (shope.ee / mercadolivre.com/sec)
  source          TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'telegram', 'manual')),
  source_copy     TEXT,                      -- copy original capturada (quando source=telegram)
  category        TEXT,                      -- suplementos|roupas|calcados|equipamentos|geral
  score           NUMERIC(8,2) DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posting', 'posted', 'skipped', 'expired', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ,
  UNIQUE (marketplace, external_id)
);
CREATE INDEX IF NOT EXISTS idx_offers_status_score ON offers (status, score DESC);
CREATE INDEX IF NOT EXISTS idx_offers_created ON offers (created_at);

-- Migração idempotente: bancos criados antes do status 'posting' (reivindicação
-- atômica da oferta durante o envio) precisam do CHECK atualizado.
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE offers ADD CONSTRAINT offers_status_check
  CHECK (status IN ('pending', 'posting', 'posted', 'skipped', 'expired', 'rejected'));

-- Migração idempotente: bancos criados antes do suporte a Amazon/AliExpress
-- precisam do CHECK de marketplace ampliado (auto-link Amazon, API AliExpress).
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_marketplace_check;
ALTER TABLE offers ADD CONSTRAINT offers_marketplace_check
  CHECK (marketplace IN ('shopee', 'meli', 'amazon', 'aliexpress'));

-- Rastreamento do auto-post no INSTAGRAM (canal independente do WhatsApp): NÃO
-- reusa a coluna `status` (compartilhada com o fluxo de grupos) — assim uma
-- oferta pode ir pro Whats E pro Insta sem uma postagem tirar a outra da fila.
-- ig_status: NULL=nunca tentado, 'posting'=reivindicada (lock), 'posted'=ok,
-- 'error'=falhou (não re-tenta; volume novo entra a cada sourcing). Dedup do IG
-- = ig_posted_at IS NULL. Tudo idempotente (IF NOT EXISTS).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS ig_status    TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS ig_posted_at TIMESTAMPTZ;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS ig_media_id  TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS ig_error     TEXT;
-- nº de tentativas de publicação no IG: 'error' é re-tentável até um teto
-- (falhas transitórias — timeout, rate-limit, blip de rede). Acima do teto a
-- oferta é abandonada (não fica presa, mas não martela um erro permanente).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS ig_attempts  INTEGER NOT NULL DEFAULT 0;
-- índice parcial p/ o pickNext do IG (só ofertas ainda não enviadas ao Insta)
CREATE INDEX IF NOT EXISTS idx_offers_ig_pending ON offers (score DESC)
  WHERE ig_status IS NULL;

CREATE TABLE IF NOT EXISTS posts (
  id          BIGSERIAL PRIMARY KEY,
  offer_id    BIGINT NOT NULL REFERENCES offers(id),
  group_jid   TEXT NOT NULL,
  ok          BOOLEAN NOT NULL DEFAULT false,
  error       TEXT,
  posted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_offer ON posts (offer_id);

CREATE TABLE IF NOT EXISTS groups (
  jid       TEXT PRIMARY KEY,            -- ex.: 120363426622032802@g.us
  name      TEXT,
  enabled   BOOLEAN NOT NULL DEFAULT true,
  position  INTEGER NOT NULL DEFAULT 0   -- ordem de envio
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_channels (
  id       BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,         -- sem @, ex.: 'achadinhosbr'
  enabled  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS keywords (
  id       BIGSERIAL PRIMARY KEY,
  term     TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL DEFAULT 'geral',
  enabled  BOOLEAN NOT NULL DEFAULT true
);

-- Plano diário de postagem: horários sorteados para o dia
CREATE TABLE IF NOT EXISTS slots (
  id           BIGSERIAL PRIMARY KEY,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  offer_id     BIGINT REFERENCES offers(id)
);
CREATE INDEX IF NOT EXISTS idx_slots_sched ON slots (status, scheduled_at);

-- Disparos (convite pro grupo): lista de contatos com status de envio.
-- ⚠️ Envio 1-a-1 não-oficial via Evolution — risco de ban do número. Usa
-- instância SEPARADA (config.broadcast.instance), anti-ban pesado e opt-out.
CREATE TABLE IF NOT EXISTS contacts (
  id         BIGSERIAL PRIMARY KEY,
  jid        TEXT UNIQUE NOT NULL,          -- 5519...@s.whatsapp.net
  phone      TEXT NOT NULL,                 -- só dígitos (DDI+DDD+número)
  name       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','sending','sent','failed','optout','invalid')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  source     TEXT DEFAULT 'manual',
  sent_at    TIMESTAMPTZ,
  optout_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts (status);

-- Seeds (só inserem se não existir)
INSERT INTO settings (key, value) VALUES
  ('paused', 'false'),
  ('started_at', ''),          -- preenchido na primeira ativação; âncora do ramp-up
  ('broadcast_paused', 'true'),  -- disparos começam PAUSADOS (kill-switch de segurança)
  ('broadcast_started_at', '')   -- âncora do ramp-up dos disparos
ON CONFLICT (key) DO NOTHING;

INSERT INTO keywords (term, category) VALUES
  ('whey protein',          'suplementos'),
  ('creatina',              'suplementos'),
  ('pre treino suplemento', 'suplementos'),
  ('legging fitness',       'roupas'),
  ('top fitness',           'roupas'),
  ('conjunto fitness feminino', 'roupas'),
  ('camiseta dry fit',      'roupas'),
  ('shorts treino',         'roupas'),
  ('regata academia',       'roupas'),
  ('tenis academia',        'calcados'),
  ('tenis corrida',         'calcados'),
  ('meia esportiva',        'calcados'),
  ('halteres',              'equipamentos'),
  ('elastico exercicio',    'equipamentos'),
  ('corda de pular',        'equipamentos'),
  ('tapete yoga',           'equipamentos'),
  ('luva academia',         'equipamentos'),
  ('garrafa termica academia', 'equipamentos'),
  ('strap academia',        'equipamentos'),
  ('cinto musculacao',      'equipamentos')
ON CONFLICT (term) DO NOTHING;

-- Aquecedor de chips: log de mensagens trocadas entre instâncias (contagem/auditoria).
CREATE TABLE IF NOT EXISTS warmer_log (
  id        BIGSERIAL PRIMARY KEY,
  from_inst TEXT NOT NULL,
  to_jid    TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warmer_log_sent_at_idx ON warmer_log (sent_at);

-- SubId de rastreio de conversão (Shopee): cada post por grupo leva um short link
-- com sub_id = o<offerId>_<bucket>_g<jid>, pra cruzar com o relatório de Sub ID da
-- Shopee e saber QUAL oferta/grupo converte. Idempotente (ADD COLUMN IF NOT EXISTS).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS sub_id TEXT;

-- Feedback de saída de grupo (retenção). Quando um contato SAI de um grupo nosso,
-- mandamos DM perguntando o motivo (só p/ quem está em contacts = já opt-in do
-- disparo) e gravamos a resposta aqui pra análise. LGPD-safe: nunca contatamos
-- quem não está na base nem quem deu opt-out.
CREATE TABLE IF NOT EXISTS group_exit_feedback (
  id            BIGSERIAL PRIMARY KEY,
  contact_jid   TEXT NOT NULL,                 -- jid pessoal (…@s.whatsapp.net)
  phone         TEXT,                          -- só dígitos (conveniência p/ join)
  name          TEXT,                          -- nome do contato (copiado de contacts)
  group_jid     TEXT NOT NULL,                 -- grupo de onde saiu (…@g.us)
  left_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  question_sent BOOLEAN NOT NULL DEFAULT false,-- a DM de pergunta saiu?
  question_at   TIMESTAMPTZ,                   -- quando perguntamos (janela de 48h p/ casar a resposta)
  reason_text   TEXT,                          -- resposta do contato (o motivo)
  answered_at   TIMESTAMPTZ,                   -- quando respondeu (NULL = ainda não)
  instance      TEXT                           -- instância de disparo usada
);
-- índice parcial p/ casar a resposta rápido (só perguntas ainda não respondidas)
CREATE INDEX IF NOT EXISTS idx_gef_pending ON group_exit_feedback (contact_jid)
  WHERE answered_at IS NULL;

-- Colunas de apoio em contacts (idempotentes):
--  welcomed_at   → dedup das boas-vindas (só saúda 1x por contato)
--  sent_instance → qual instância de disparo abriu a conversa (p/ DM sair por ela)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS welcomed_at   TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sent_instance TEXT;

-- Conversas da IA (aba Conversas do painel): log de DMs recebidos e respondidos
-- por aiReply (src/control.js). Retenção de 30 dias (purga automática, LGPD).
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  jid        TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  text       TEXT NOT NULL,
  instance   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages (jid, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);