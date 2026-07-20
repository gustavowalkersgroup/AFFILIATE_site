# Tela de Conversas (opt-in/opt-out) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Conversas" tab to the admin panel showing the DM threads the AI auto-reply (`aiReply` in `src/control.js`) handles, with opt-in/opt-out status per contact — without touching broadcast/disparo logic.

**Architecture:** New `messages` table logs every inbound DM that reaches `aiReply` and every AI reply sent back. Two new read-only functions in `src/control.js` (`listConversations`, `getConversationThread`) query that table joined with `contacts` (for opt-in/opt-out status). Two new `GET` routes in `src/panel.js` expose them. A new tab in `public/painel.html` renders a list + thread view. A daily cron job purges rows older than 30 days (LGPD).

**Tech Stack:** Node.js (ESM), Express, `pg` (raw SQL, no ORM), `node-cron`, `node:test` for unit tests, vanilla JS/HTML for the panel front-end (no framework/bundler).

## Global Constraints

- Read-only feature: no new write actions from the UI (no manual reply, no manual opt-out toggle from this screen).
- Only covers DMs on the broadcast instance (`config.broadcast.instance`) handled by `aiReply` — not the aquecedor mesh, not groups.
- Message content retention: 30 days, purged daily via cron (LGPD).
- Follow existing code style exactly: Portuguese comments only where the WHY is non-obvious (matches the rest of the file), `console.log('[module] ...')` logging convention, `asyncRoute`/`requireAdmin` wrapper for all new panel routes, no new dependencies.
- Reference spec: `docs/superpowers/specs/2026-07-20-conversas-design.md`.

---

### Task 1: `messages` table + daily purge job

**Files:**
- Modify: `sql/schema.sql` (append after the `group_exit_feedback` block, end of file)
- Modify: `src/db.js` (add `purgeOldMessages` export)
- Modify: `src/scheduler.js` (register daily cron)

**Interfaces:**
- Produces: `purgeOldMessages(days = 30): Promise<number>` (exported from `src/db.js`) — deletes `messages` rows older than `days` and returns the deleted row count. Later tasks (none) don't depend on this directly, but Task 3 depends on the `messages` table existing with columns `(id, jid, direction, text, instance, created_at)`.

- [ ] **Step 1: Add the `messages` table to the schema**

Read the end of `sql/schema.sql` first to confirm the exact insertion point (after the `group_exit_feedback` table/index block, which is the last thing in the file). Append:

```sql

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
```

- [ ] **Step 2: Apply the migration locally and verify**

Run: `npm run migrate`
Expected output: `Schema aplicado com sucesso.`

Then verify the table exists (uses the same `DATABASE_URL` as `.env`):

Run: `node -e "import('./src/db.js').then(async ({ pool }) => { const r = await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'messages' ORDER BY ordinal_position\"); console.log(r.rows); await pool.end(); })"`

Expected: prints 5 rows — `id, jid, direction, text, instance, created_at` (plus you'll see `created_at` last).

- [ ] **Step 3: Add `purgeOldMessages` to `src/db.js`**

Add this right after the existing `isPaused` function (after line 47, before the `isEntrypoint` block):

```javascript
// Purga LGPD: conteúdo de conversas da IA (aba Conversas) não fica indefinido.
export async function purgeOldMessages(days = 30) {
  const { rowCount } = await pool.query(
    `DELETE FROM messages WHERE created_at < now() - make_interval(days => $1::int)`,
    [days]
  );
  return rowCount;
}
```

- [ ] **Step 4: Verify `purgeOldMessages` manually**

Run: `node -e "import('./src/db.js').then(async ({ pool, purgeOldMessages }) => { await pool.query(\"INSERT INTO messages (jid, direction, text, instance, created_at) VALUES ('555199999999@s.whatsapp.net','in','teste antigo','chip-teste', now() - interval '40 days')\"); const n = await purgeOldMessages(30); console.log('purgados:', n); await pool.end(); })"`

Expected: `purgados: 1` (or more, if other old rows exist — must be ≥ 1).

- [ ] **Step 5: Register the daily purge cron in `src/scheduler.js`**

Add `purgeOldMessages` to the `db.js` import (line 8):

```javascript
import { query, getSetting, setSetting, isPaused, purgeOldMessages } from './db.js';
```

Add a new cron registration in `startScheduler()`, right after the `checkTelegramHealth` cron (after line 559, before the `// boot:` comment):

```javascript
  // 7. purga diária de mensagens da IA (aba Conversas) com mais de 30 dias — LGPD.
  cron.schedule('15 3 * * *', () => {
    purgeOldMessages(30)
      .then((n) => { if (n > 0) console.log(`[scheduler] purga de mensagens: ${n} registro(s) com mais de 30 dias removido(s)`); })
      .catch((err) => console.log(`[scheduler] erro na purga de mensagens: ${err.message}`));
  }, opts);
```

- [ ] **Step 6: Commit**

```bash
git add sql/schema.sql src/db.js src/scheduler.js
git commit -m "Add messages table + daily 30-day purge cron"
```

---

### Task 2: Pure status-filter helper (TDD)

**Files:**
- Modify: `src/control.js` (add and export `conversationStatusClause`)
- Test: `test/control.test.js` (new file)

**Interfaces:**
- Produces: `conversationStatusClause(filter: 'optin' | 'optout' | undefined): string` — a raw SQL boolean expression referencing a bare `status` column, e.g. `"status = 'optout'"`. Task 4 uses this inside `listConversations`'s SQL.

- [ ] **Step 1: Write the failing tests**

Create `test/control.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationStatusClause } from '../src/control.js';

test('conversationStatusClause: optout filtra só quem saiu', () => {
  assert.equal(conversationStatusClause('optout'), "status = 'optout'");
});

test('conversationStatusClause: optin filtra quem NÃO saiu', () => {
  assert.equal(conversationStatusClause('optin'), "status IS DISTINCT FROM 'optout'");
});

test('conversationStatusClause: sem filtro (undefined) não filtra nada', () => {
  assert.equal(conversationStatusClause(undefined), '1=1');
});

test('conversationStatusClause: valor desconhecido cai no "sem filtro"', () => {
  assert.equal(conversationStatusClause('lixo'), '1=1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/control.test.js`
Expected: FAIL — `conversationStatusClause is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 3: Implement `conversationStatusClause` in `src/control.js`**

Add near the top of the file, right after the imports (after line 7, before the `// ── AI auto-reply` comment on line 10):

```javascript
// Filtro de status pra listConversations (aba Conversas). 'status' aqui é a
// coluna já normalizada (COALESCE(c.status, 'pending')) — optin = qualquer
// coisa diferente de optout, não uma lista fixa de valores "bons".
export function conversationStatusClause(filter) {
  if (filter === 'optout') return "status = 'optout'";
  if (filter === 'optin') return "status IS DISTINCT FROM 'optout'";
  return '1=1';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/control.test.js`
Expected: PASS — 4 tests passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/control.js test/control.test.js
git commit -m "Add conversationStatusClause helper for conversation status filtering"
```

---

### Task 3: Record inbound/outbound DM messages

**Files:**
- Modify: `src/control.js`

**Interfaces:**
- Consumes: `query` (already imported from `./db.js` at line 4), `findContactByJid(jid)` (already defined at line 314, returns `{ id, jid, phone, name, status, sent_instance } | null`).
- Produces: internal `recordMessage(jid, direction, text, instance): Promise<void>` (not exported — only used inside this file). Task 4's `getConversationThread`/`listConversations` read the rows this writes, matching on the `jid` column.

- [ ] **Step 1: Add the `recordMessage` helper**

Add it right after the `sweepReplyDedup` function (after line 21, before `const BOT_PATTERNS`):

```javascript
async function recordMessage(jid, direction, text, instance) {
  await query(
    `INSERT INTO messages (jid, direction, text, instance) VALUES ($1, $2, $3, $4)`,
    [jid, direction, text, instance]
  );
}
```

- [ ] **Step 2: Log the AI's outbound reply inside `aiReply`**

In the current `aiReply` function, right after the `evoFetch` call succeeds and before `replyDedup.set(jid, Date.now())` (this is between lines 81–86 today):

Change the function signature (line 43) from:
```javascript
async function aiReply(jid, text) {
```
to:
```javascript
async function aiReply(jid, text, logJid) {
```

And change this block (lines 80–87):
```javascript
    const delay = 3000 + Math.floor(Math.random() * 4000);
    await evoFetch(`/message/sendText/${config.broadcast.instance}`, {
      number: jid,
      options: { delay, presence: 'composing', linkPreview: false },
      textMessage: { text: reply },
    });
    replyDedup.set(jid, Date.now());
    console.log(`[ai-reply] respondido ${jid.split('@')[0]}`);
```
to:
```javascript
    const delay = 3000 + Math.floor(Math.random() * 4000);
    await evoFetch(`/message/sendText/${config.broadcast.instance}`, {
      number: jid,
      options: { delay, presence: 'composing', linkPreview: false },
      textMessage: { text: reply },
    });
    await recordMessage(logJid || jid, 'out', reply, config.broadcast.instance);
    replyDedup.set(jid, Date.now());
    console.log(`[ai-reply] respondido ${jid.split('@')[0]}`);
```

(`logJid || jid` falls back to the raw jid if no canonical contact match was found — see Step 3.)

- [ ] **Step 3: Log the inbound message and pass the canonical jid, in `handleWebhook`**

Change this block (current lines 263–266):
```javascript
        // AI auto-reply: DMs recebidos na instância de disparo (não opt-out, não bot).
        if (isBroadcast && !isBotMessage(text)) {
          aiReply(jid, text).catch(() => {});
        }
```
to:
```javascript
        // AI auto-reply: DMs recebidos na instância de disparo (não opt-out, não bot).
        // Grava em `messages` (aba Conversas) usando o jid CANÔNICO do contato
        // (mesmo tratado no 9º dígito que findContactByJid já resolve pra
        // opt-out/dmViaBroadcast) — sem isso, a mesma pessoa apareceria como
        // duas conversas diferentes se mandar de variantes distintas do número.
        if (isBroadcast && !isBotMessage(text)) {
          const contactForLog = await findContactByJid(jid);
          const logJid = contactForLog ? contactForLog.jid : jid;
          await recordMessage(logJid, 'in', text, instance);
          aiReply(jid, text, logJid).catch(() => {});
        }
```

- [ ] **Step 4: Verify manually against a local dev server + Postgres**

Start the app locally (`npm start`, using your local `.env`/`DATABASE_URL` per `README.md`). Simulate an inbound DM on the broadcast instance by POSTing a fake Evolution webhook payload (replace `<WEBHOOK_TOKEN>` and instance name with your local `.env` values):

```bash
curl -X POST "http://localhost:3210/webhook/evolution/<WEBHOOK_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "messages.upsert",
    "instance": "<seu-broadcast-instance>",
    "data": {
      "key": { "remoteJid": "5519988887777@s.whatsapp.net", "fromMe": false },
      "message": { "conversation": "oi, quero saber mais" }
    }
  }'
```

Expected: HTTP 200 `{"ok":true,"handled":0}` (the DM doesn't match a command, so `handled` stays 0 — that's fine, it's unrelated to the AI reply path). Check the log line `[ai-reply] respondido 5519988887777` (or an `[ai-reply] erro: ...` if no `OPENAI_API_KEY` is configured locally — in that case at least confirm the `in` row landed).

Then check the DB:

Run: `node -e "import('./src/db.js').then(async ({ pool }) => { const r = await pool.query(\"SELECT direction, text, instance FROM messages WHERE jid LIKE '%5519988887777%' ORDER BY created_at\"); console.log(r.rows); await pool.end(); })"`

Expected: at least one row with `direction: 'in'`, `text: 'oi, quero saber mais'`. If `OPENAI_API_KEY` is configured, a second row with `direction: 'out'`.

- [ ] **Step 5: Commit**

```bash
git add src/control.js
git commit -m "Log inbound/outbound AI DMs into messages table"
```

---

### Task 4: Read API — `listConversations`, `getConversationThread` + routes

**Files:**
- Modify: `src/control.js` (add and export `listConversations`, `getConversationThread`)
- Modify: `src/panel.js` (add two `GET` routes)

**Interfaces:**
- Consumes: `conversationStatusClause` (Task 2), `query` (from `./db.js`), `findContactByJid` (existing, line 314).
- Produces:
  - `listConversations({ status }: { status?: 'optin' | 'optout' }): Promise<Array<{ jid: string, name: string|null, phone: string|null, status: string, last_text: string, last_at: string, total: number }>>`
  - `getConversationThread(jid: string): Promise<{ jid: string, name: string|null, phone: string|null, status: string, messages: Array<{ direction: 'in'|'out', text: string, created_at: string }> }>`
  - Both exported from `src/control.js`. Task 5 (UI) consumes the two new HTTP endpoints, not these functions directly.

- [ ] **Step 1: Add `listConversations` and `getConversationThread` to `src/control.js`**

Add them right after `findContactByJid` (after line 326, before the `// Envia DM por uma instância de DISPARO` comment):

```javascript
// Lista de conversas p/ aba Conversas (read-only): 1 linha por jid que já
// trocou mensagem, com a última mensagem e o status opt-in/opt-out atual.
export async function listConversations({ status } = {}) {
  const clause = conversationStatusClause(status);
  const { rows } = await query(
    `SELECT jid, name, phone, status, last_text, last_at, total
       FROM (
         SELECT m.jid,
                c.name,
                c.phone,
                COALESCE(c.status, 'pending') AS status,
                m.text AS last_text,
                m.created_at AS last_at,
                count(*) OVER (PARTITION BY m.jid) AS total,
                row_number() OVER (PARTITION BY m.jid ORDER BY m.created_at DESC) AS rn
           FROM messages m
           LEFT JOIN contacts c ON c.jid = m.jid
       ) sub
      WHERE rn = 1 AND ${clause}
      ORDER BY last_at DESC`
  );
  return rows;
}

// Thread completa de uma conversa (aba Conversas, clique numa linha da lista).
export async function getConversationThread(jid) {
  const contact = await findContactByJid(jid);
  const canonicalJid = contact ? contact.jid : jid;
  const { rows } = await query(
    `SELECT direction, text, created_at FROM messages WHERE jid = $1 ORDER BY created_at ASC`,
    [canonicalJid]
  );
  return {
    jid: canonicalJid,
    name: contact ? contact.name : null,
    phone: contact ? contact.phone : null,
    status: contact ? contact.status : 'pending',
    messages: rows,
  };
}
```

- [ ] **Step 2: Import them in `src/panel.js`**

Change the existing import (line 9):
```javascript
import { statusData } from './control.js';
```
to:
```javascript
import { statusData, listConversations, getConversationThread } from './control.js';
```

- [ ] **Step 3: Add the two routes**

Add right after the `/api/broadcast/failures` route (after line 781, before the `// ------------------------------------------------------------------- config` comment):

```javascript
  // Aba Conversas: DMs que a IA assume (aiReply) — somente leitura.
  app.get('/api/conversations', requireAdmin, asyncRoute(async (req, res) => {
    const status = ['optin', 'optout'].includes(req.query.status) ? req.query.status : undefined;
    res.json({ conversations: await listConversations({ status }) });
  }));

  app.get('/api/conversations/:jid', requireAdmin, asyncRoute(async (req, res) => {
    res.json(await getConversationThread(req.params.jid));
  }));
```

- [ ] **Step 4: Verify manually**

With the local server running and at least the `in` row from Task 3's Step 4 present:

Run: `curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3210/api/conversations`
Expected: `{"conversations":[{"jid":"5519988887777@s.whatsapp.net", ..., "status":"pending", "last_text":"oi, quero saber mais", ...}]}`

Run: `curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3210/api/conversations/5519988887777@s.whatsapp.net"`
Expected: `{"jid":"5519988887777@s.whatsapp.net","name":null,"phone":null,"status":"pending","messages":[{"direction":"in","text":"oi, quero saber mais","created_at":"..."}]}`

Run: `curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3210/api/conversations?status=optout"`
Expected: `{"conversations":[]}` (unless you have a real opt-out row in `messages`+`contacts`).

- [ ] **Step 5: Commit**

```bash
git add src/control.js src/panel.js
git commit -m "Add GET /api/conversations and /api/conversations/:jid read-only endpoints"
```

---

### Task 5: "Conversas" tab in the panel UI

**Files:**
- Modify: `public/painel.html`

**Interfaces:**
- Consumes: `GET /api/conversations` and `GET /api/conversations/:jid` (Task 4), the existing `api()`, `$()`, `$all()`, `esc()` helpers already defined in this file (lines 1193–1213, 1254), and the existing `switchTab`/`loadTab` dispatcher (lines 1493–1509).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Add the tab button**

Change the `<nav class="tabs" id="tabs">` block (lines 335–344) — add a new button right after the "Aquecedor" button and before "Config":

```html
      <button type="button" class="tab" data-tab="aquecedor">Aquecedor</button>
      <button type="button" class="tab" data-tab="conversas">Conversas</button>
      <button type="button" class="tab" data-tab="config">Config</button>
```
(replacing the two lines that currently read `aquecedor` then `config`).

- [ ] **Step 2: Add the section markup**

Add a new `<section>` right after the aquecedor section closes and before the `<!-- CONFIG -->` comment (the aquecedor section starts at line 623 with `<section id="tab-aquecedor" class="hidden">` — find its closing `</section>` right before the actual `<!-- CONFIG -->` HTML comment that precedes the config `<section>`, and insert this new section right after that closing tag):

```html
    <!-- CONVERSAS -->
    <section id="tab-conversas" class="hidden">
      <div class="warn" style="margin-bottom:12px;">
        💬 <b>Conversas da IA.</b> Só visualização — mostra os DMs que a IA responde
        automaticamente (não os disparos em massa, que ficam na aba Disparos).
      </div>
      <div class="toolbar">
        <select id="cv-status" title="filtro de status">
          <option value="" selected>Todos</option>
          <option value="optin">Opt-in</option>
          <option value="optout">Opt-out</option>
        </select>
      </div>
      <div class="row2" style="align-items:start;">
        <div id="cv-list"><p class="empty">carregando…</p></div>
        <div class="card" id="cv-thread"><p class="empty">selecione uma conversa</p></div>
      </div>
    </section>

```

- [ ] **Step 3: Wire the tab into the load/refresh dispatchers**

In `loadTab(name)` (lines 1501–1509), add a branch right after the `aquecedor` branch:
```javascript
  else if (name === 'aquecedor') loadWarmer();
```
becomes:
```javascript
  else if (name === 'aquecedor') loadWarmer();
  else if (name === 'conversas') loadConversas();
```

In the `#btn-refresh` click handler (lines 1446–1457), add a matching branch right after the `aquecedor` one:
```javascript
  else if (activeTab === 'aquecedor') jobs.push(loadWarmer());
```
becomes:
```javascript
  else if (activeTab === 'aquecedor') jobs.push(loadWarmer());
  else if (activeTab === 'conversas') jobs.push(loadConversas());
```

In `startAutoRefresh()` (lines 1461–1470), extend the existing 30s tick so the conversation list refreshes automatically while that tab is open (reuses the existing timer instead of adding a second one):
```javascript
  refreshTimer = setInterval(function () {
    if (document.visibilityState === 'visible' && !loginVisible) {
      loadOverview(true);
      if (tick++ % 2 === 0) loadHealth(); /* saúde a cada 60s (1 chamada à Evolution) */
    }
  }, 30000);
```
becomes:
```javascript
  refreshTimer = setInterval(function () {
    if (document.visibilityState === 'visible' && !loginVisible) {
      loadOverview(true);
      if (tick++ % 2 === 0) loadHealth(); /* saúde a cada 60s (1 chamada à Evolution) */
      if (activeTab === 'conversas') loadConversas();
    }
  }, 30000);
```

- [ ] **Step 4: Implement `loadConversas`, `renderConversaList`, `openConversa`**

Add this block right after the `loadWarmer` function ends (search for the function starting at line 2986; add these new functions right before the `loadBroadcast` function at line 3087, so it lands right after all the `loadWarmer`-related helpers):

```javascript
var cvSelectedJid = null;

function loadConversas() {
  var status = $('#cv-status').value;
  var qs = status ? ('?status=' + encodeURIComponent(status)) : '';
  return api('/api/conversations' + qs)
    .then(function (data) { renderConversaList((data && data.conversations) || []); })
    .catch(function () { $('#cv-list').innerHTML = '<p class="empty">erro ao carregar</p>'; });
}

function renderConversaList(list) {
  if (!list.length) { $('#cv-list').innerHTML = '<p class="empty">nenhuma conversa ainda</p>'; return; }
  $('#cv-list').innerHTML = list.map(function (c) {
    var badge = c.status === 'optout'
      ? '<span class="badge" style="color:var(--red); border-color:var(--red);">opt-out</span>'
      : '<span class="badge" style="color:var(--green); border-color:var(--green);">opt-in</span>';
    var label = c.name || c.phone || c.jid.split('@')[0];
    var when = new Date(c.last_at).toLocaleString('pt-BR');
    var active = c.jid === cvSelectedJid ? ' style="border-color:var(--blue);"' : '';
    return '<div class="card" data-jid="' + esc(c.jid) + '"' + active + ' style="cursor:pointer; margin-bottom:8px;">' +
      '<div style="display:flex; justify-content:space-between; gap:8px;">' +
        '<b>' + esc(label) + '</b>' + badge +
      '</div>' +
      '<div class="muted" style="font-size:13px; margin-top:4px;">' + esc(c.last_text) + '</div>' +
      '<div class="muted" style="font-size:11px; margin-top:4px;">' + esc(when) + ' · ' + c.total + ' msg(s)</div>' +
    '</div>';
  }).join('');
  $all('#cv-list [data-jid]').forEach(function (el) {
    el.addEventListener('click', function () { openConversa(el.dataset.jid); });
  });
}

function openConversa(jid) {
  cvSelectedJid = jid;
  $('#cv-thread').innerHTML = '<p class="empty">carregando…</p>';
  api('/api/conversations/' + encodeURIComponent(jid))
    .then(function (t) {
      var msgs = (t.messages || []).map(function (m) {
        var mine = m.direction === 'out';
        return '<div style="display:flex; justify-content:' + (mine ? 'flex-end' : 'flex-start') + '; margin-bottom:8px;">' +
          '<div style="max-width:75%; padding:8px 12px; border-radius:10px; background:' + (mine ? 'var(--bg3)' : 'var(--bg2)') + '; border:1px solid var(--border);">' +
            esc(m.text) +
            '<div class="muted" style="font-size:10px; margin-top:4px;">' + new Date(m.created_at).toLocaleString('pt-BR') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      $('#cv-thread').innerHTML = '<h2 style="margin-bottom:10px;">' + esc(t.name || t.phone || t.jid.split('@')[0]) + '</h2>' + (msgs || '<p class="empty">sem mensagens</p>');
    })
    .catch(function () { $('#cv-thread').innerHTML = '<p class="empty">erro ao carregar</p>'; });
}

$('#cv-status').addEventListener('change', loadConversas);
```

- [ ] **Step 5: Verify in the browser**

Start the app locally (`npm start`), open `http://localhost:3210/painel`, log in with `ADMIN_TOKEN`, click the new "Conversas" tab. With the test row from Task 3/4 present: confirm the list shows one card with the preview text and an "opt-in" badge (status was `pending` → not `optout`), click it, confirm the thread panel shows the message bubble on the left (inbound). Change the filter to "Opt-out" and confirm the list goes empty (assuming no real opt-out conversation exists locally).

- [ ] **Step 6: Commit**

```bash
git add public/painel.html
git commit -m "Add read-only Conversas tab to admin panel"
```
