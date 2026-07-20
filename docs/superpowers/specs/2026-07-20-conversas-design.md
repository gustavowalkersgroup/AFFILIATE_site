# Tela de Conversas (opt-in/opt-out) — Design

## Contexto

Hoje o sistema roda `aiReply` (`src/control.js`) para responder DMs recebidos na
instância de disparo (`config.broadcast.instance`) via OpenAI. Essa lógica:

- Não persiste nada: nem a mensagem do cliente nem a resposta da IA (só
  `console.log`).
- Não tem memória multi-turn: cada resposta usa só a última mensagem recebida.
- Opt-in/opt-out já é rastreado em `contacts.status` (`optout` vs demais),
  gravado via `markOptOut(jid)` quando o texto bate em `isOptOut()`.

Com várias instâncias de WhatsApp rodando, não dá pra acompanhar essas
conversas abrindo celular por celular. Objetivo: uma aba no painel
(`public/painel.html`) só para **visualizar** (read-only) as conversas que a
IA assume — não os disparos em massa (que já têm sua própria aba/estatística
em `broadcastStats()`).

## Escopo

- Somente leitura. Sem responder manualmente, sem opt-out manual pela tela
  (fora de escopo desta versão).
- Cobre apenas mensagens tratadas por `aiReply`, ou seja, DMs na instância de
  disparo — não inclui o mesh do aquecedor (`warmer.js`) nem grupos.
- Atualização por polling (~15s), reaproveitando o padrão já usado nas outras
  abas do painel. Sem WebSocket/SSE.
- Retenção de 30 dias: purga automática diária do conteúdo de mensagens mais
  antigas (requisito de LGPD — o próprio código já tem comentários sobre isso
  em `control.js`).

## 1. Dado novo: tabela `messages`

Não existe hoje nenhuma persistência de mensagens (nem em `contacts`, nem em
tabela dedicada). Nova migration em `sql/schema.sql`:

```sql
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
```

Pontos de gravação em `src/control.js`:

- **`in`**: dentro de `handleWebhook`, quando `isBroadcast && !isBotMessage(text)`
  (mesmo ponto que hoje dispara `aiReply`), antes de chamar `aiReply`.
- **`out`**: dentro de `aiReply`, logo após o `evoFetch` de envio ter sucesso
  (mesmo ponto onde hoje só há `console.log`).

Ambos gravam `instance = config.broadcast.instance`.

**Purga (LGPD, 30 dias)**: job diário via `node-cron` (reaproveitando o padrão
já usado em `src/scheduler.js`), executando:

```sql
DELETE FROM messages WHERE created_at < now() - interval '30 days';
```

## 2. API (`src/panel.js`)

- `GET /api/conversations` — lista de contatos com pelo menos 1 mensagem,
  uma linha por jid: nome/telefone, texto da última mensagem, timestamp da
  última mensagem, status atual (`contacts.status`), contagem total de
  mensagens. Ordenado por última mensagem desc. Filtro opcional
  `?status=optout|optin` (`optin` = qualquer status diferente de `optout`).
- `GET /api/conversations/:jid` — thread completa: todas as mensagens
  (`in`/`out`, texto, timestamp) ordenadas por `created_at` asc, mais o status
  atual do contato.

Ambas as rotas usam `requireAdmin` (mesmo middleware das demais rotas do
painel) e reaproveitam `phoneVariants()` (já existe em `control.js`, precisa
virar export) para casar variantes de número com/sem o 9º dígito — mesmo
tratamento que `broadcast.js` já faz para opt-out.

## 3. UI (`public/painel.html`)

Nova aba "Conversas", seguindo o mesmo padrão estrutural da aba Aquecedor:
tab button (`data-tab="conversas"`), `<section id="tab-conversas">`, função
`loadConversas()` chamada no polling da aba ativa.

Layout de 2 colunas dentro da seção:

- **Esquerda** — lista de conversas: telefone/nome, preview da última
  mensagem (truncada), badge de status (verde "opt-in" / vermelho
  "opt-out"), horário relativo da última mensagem. Filtro no topo: Todos /
  Opt-in / Opt-out.
- **Direita** — thread da conversa selecionada: bolhas de chat, mensagens do
  cliente à esquerda, respostas da IA à direita, com timestamp.

Sem ações de escrita nesta tela (somente visualização).

## Fora de escopo (mencionar, não implementar agora)

- Responder manualmente pela tela.
- Opt-out/opt-in manual pela tela.
- Cobertura do mesh do aquecedor (instâncias fora da de disparo).
- Tempo real (WebSocket/SSE).
