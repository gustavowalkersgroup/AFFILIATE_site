# Aquecedor de Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manter as instâncias de WhatsApp conectadas conversando entre si em mesh, de forma contínua e realista, para aquecer chips e reduzir risco de ban — liga/desliga manual no painel.

**Architecture:** Novo módulo `src/warmer.js` simétrico ao `src/broadcast.js`, com executor `runWarmer()` chamado por um cron minuto-a-minuto em `src/scheduler.js`. Lógica de decisão isolada em funções puras testáveis (seleção de par, avanço de thread, janela, montagem de mensagem); efeitos colaterais (Evolution, Postgres) ficam só em `runWarmer()` e `discoverChips()`. Banco de frases em `src/warmer-phrases.js`. Estado em settings (string/JSON) + tabela `warmer_log`. UI: nova aba no `public/painel.html` + rotas `/api/warmer/*` em `src/panel.js`.

**Tech Stack:** Node 20 (ESM), `node:test` (runner nativo, sem deps novas), Postgres (`pg`), Evolution API v1, Express, `node-cron`.

## Global Constraints

- ESM puro (`"type": "module"`); imports com extensão `.js`.
- O executor **nunca lança**: todo erro capturado, logado com prefixo `[warmer]`, retorna neutro. Padrão herdado de `broadcast.js`.
- Reaproveitar helpers existentes: `evoFetch` (`src/poster.js`), `query/getSetting/setSetting` (`src/db.js`), `range/randomBetween/config` (`src/config.js`).
- Settings persistem **sempre como string** (`setSetting` faz `String(value)`); estruturas (threads, cache) gravadas com `JSON.stringify` e lidas com `JSON.parse`.
- Ranges de tempo gravados no formato `"min-max"` (ms) e parseados com `range()`.
- Timezone para janela horária: `config.tz` (`America/Sao_Paulo`).
- Sem mídia, sem links, sem IA. Só texto.
- Defaults: `warmer_enabled=off`, `warmer_spacing_ms="20000-120000"`, `warmer_window="07:00-23:00"`, `warmer_daily_cap=0` (sem teto), `warmer_ramp_days=0` (desligado).

---

### Task 1: Banco de frases + montagem de mensagem

**Files:**
- Create: `src/warmer-phrases.js`
- Create: `src/warmer.js`
- Test: `test/warmer.test.js`
- Modify: `package.json` (adicionar script `test`)

**Interfaces:**
- Consumes: nada (primeira task).
- Produces:
  - `src/warmer-phrases.js` exporta `OPENERS: string[]`, `REPLIES: string[]`, `FOLLOWUPS: string[]`, `CLOSERS: string[]`.
  - `src/warmer.js` exporta `spin(text: string): string` e `buildWarmerMessage(stage: 'open'|'reply'|'followup'|'close'): string`.

- [ ] **Step 1: Adicionar script de teste ao package.json**

Modificar o bloco `"scripts"` de `package.json` para incluir a linha do `test` (manter as demais):

```json
  "scripts": {
    "start": "node src/index.js",
    "migrate": "node src/db.js --migrate",
    "telegram:login": "node scripts/telegram-login.js",
    "groups:setup": "node scripts/setup-groups.js",
    "smoke": "node scripts/smoke.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `test/warmer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spin, buildWarmerMessage } from '../src/warmer.js';
import { OPENERS, REPLIES, FOLLOWUPS, CLOSERS } from '../src/warmer-phrases.js';

test('spin resolve {a|b|c} para uma das opcoes', () => {
  for (let i = 0; i < 50; i++) {
    const out = spin('{oi|opa|e ai}');
    assert.ok(['oi', 'opa', 'e ai'].includes(out), `inesperado: ${out}`);
  }
});

test('spin deixa texto sem chaves intacto', () => {
  assert.equal(spin('tudo bem'), 'tudo bem');
});

test('bancos de frases nao estao vazios', () => {
  for (const arr of [OPENERS, REPLIES, FOLLOWUPS, CLOSERS]) {
    assert.ok(Array.isArray(arr) && arr.length >= 3);
  }
});

test('buildWarmerMessage retorna texto nao-vazio sem chaves residuais', () => {
  for (const stage of ['open', 'reply', 'followup', 'close']) {
    const msg = buildWarmerMessage(stage);
    assert.ok(typeof msg === 'string' && msg.length > 0, `stage ${stage} vazio`);
    assert.ok(!/[{}]/.test(msg), `stage ${stage} deixou chaves: ${msg}`);
  }
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/warmer.js'` (e `warmer-phrases.js`).

- [ ] **Step 4: Criar o banco de frases**

Criar `src/warmer-phrases.js`:

```js
// Frases curtas e coloquiais para o aquecedor. Sintaxe spin {a|b|c}.
// Sem links, sem mídia — só conversa fiada pra dar tráfego humano entre chips.

export const OPENERS = [
  '{oi|opa|e aí|fala}{!|, tudo bem?| tudo certo?}',
  '{bom dia|boa tarde|boa noite}{!|, blz?}',
  'e aí, {sumido|some|tudo tranquilo}?',
  '{viu|tá ligado} {a novidade|aquilo}?',
  'oi, {posso te perguntar uma coisa|tô passando pra dar um oi}?',
];

export const REPLIES = [
  '{tudo sim|por aqui de boa|tranquilo e vc?|tudo certo!}',
  '{opa|oi}, {bem e vc|tudo ótimo|de boa}?',
  '{sim sim|isso aí|exatamente|com certeza}',
  '{kkk|haha|rsrs} {pois é|verdade|nem me fala}',
  '{tô aqui|chegando agora|acabei de ver}',
];

export const FOLLOWUPS = [
  '{e aí|então|pois é}, {como tá|o que manda|novidades}?',
  '{nem me fala|imagina|verdade} {kkk|rsrs}',
  '{depois|mais tarde} a gente {conversa|se fala}',
  'tá {corrido|tranquilo} {por aí|hoje}?',
  '{bora|vamo} {marcar algo|combinar}?',
];

export const CLOSERS = [
  '{falou|abraço|valeu|até mais}{!|, fui|, depois te chamo}',
  '{tmj|tamo junto|qualquer coisa chama}',
  '{vou nessa|preciso ir}, {abraço|falou}!',
  'depois continuamos, {abraço|valeu}',
];
```

- [ ] **Step 5: Criar warmer.js com spin e buildWarmerMessage**

Criar `src/warmer.js`:

```js
// Aquecedor de chips: faz as instâncias conectadas conversarem entre si (mesh)
// de forma contínua e realista. Executor nunca lança (padrão broadcast.js).
import { config, randomBetween, range } from './config.js';
import { query, getSetting, setSetting } from './db.js';
import { evoFetch } from './poster.js';
import { OPENERS, REPLIES, FOLLOWUPS, CLOSERS } from './warmer-phrases.js';

/** Resolve a sintaxe spin {a|b|c} escolhendo uma opção aleatória. */
export function spin(text) {
  return String(text).replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
    const choices = opts.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

const STAGE_BANK = { open: OPENERS, reply: REPLIES, followup: FOLLOWUPS, close: CLOSERS };

/** Monta uma mensagem do estágio pedido: sorteia uma frase do banco e aplica spin. */
export function buildWarmerMessage(stage) {
  const bank = STAGE_BANK[stage] || REPLIES;
  const phrase = bank[Math.floor(Math.random() * bank.length)];
  return spin(phrase);
}
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npm test`
Expected: PASS — 4 testes ok.

- [ ] **Step 7: Commit**

```bash
git add package.json test/warmer.test.js src/warmer.js src/warmer-phrases.js
git commit -m "feat(warmer): banco de frases + montagem de mensagem com spin"
```

(Projeto pode não ser repo git — se `git` falhar, pular o commit e seguir.)

---

### Task 2: Seleção de par (mesh) e avanço de thread

**Files:**
- Modify: `src/warmer.js`
- Test: `test/warmer.test.js`

**Interfaces:**
- Consumes: `buildWarmerMessage` (Task 1).
- Produces (todas funções puras, exportadas de `src/warmer.js`):
  - `pickPair(chips: {instance,jid}[], rnd?: ()=>number): {a,b}` — sorteia dois chips distintos. `a`/`b` são objetos `{instance,jid}`. Lança se `chips.length < 2`.
  - `openThread(a, b, rnd?): Thread` — cria thread nova com `target` aleatório 3–8.
  - `advanceThread(thread): { thread: Thread|null, send: {fromInst,toJid,stage} }` — calcula a próxima fala; retorna `thread:null` quando a conversa fecha (estágio `close`).
  - Tipo `Thread = { aInst, aJid, bInst, bJid, turn:'a'|'b', exchanges:number, target:number }`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar a `test/warmer.test.js`:

```js
import { pickPair, openThread, advanceThread } from '../src/warmer.js';

const CHIPS = [
  { instance: 'chip-1', jid: '5511111111111@s.whatsapp.net' },
  { instance: 'chip-2', jid: '5522222222222@s.whatsapp.net' },
  { instance: 'chip-3', jid: '5533333333333@s.whatsapp.net' },
];

test('pickPair retorna dois chips distintos', () => {
  for (let i = 0; i < 50; i++) {
    const { a, b } = pickPair(CHIPS);
    assert.notEqual(a.instance, b.instance);
  }
});

test('pickPair lanca com menos de 2 chips', () => {
  assert.throws(() => pickPair([CHIPS[0]]));
});

test('openThread cria thread com target entre 3 e 8 e turn=a', () => {
  const t = openThread(CHIPS[0], CHIPS[1]);
  assert.equal(t.aInst, 'chip-1');
  assert.equal(t.bInst, 'chip-2');
  assert.equal(t.turn, 'a');
  assert.equal(t.exchanges, 0);
  assert.ok(t.target >= 3 && t.target <= 8);
});

test('advanceThread: primeira fala vem de a como open e alterna turn', () => {
  const t = openThread(CHIPS[0], CHIPS[1]);
  const { thread, send } = advanceThread(t);
  assert.equal(send.stage, 'open');
  assert.equal(send.fromInst, 'chip-1');
  assert.equal(send.toJid, CHIPS[1].jid);
  assert.equal(thread.turn, 'b');
  assert.equal(thread.exchanges, 1);
});

test('advanceThread: segunda fala vem de b como reply', () => {
  let t = openThread(CHIPS[0], CHIPS[1]);
  t.target = 8;
  t = advanceThread(t).thread;           // open (A)
  const { thread, send } = advanceThread(t); // reply (B)
  assert.equal(send.stage, 'reply');
  assert.equal(send.fromInst, 'chip-2');
  assert.equal(send.toJid, CHIPS[0].jid);
  assert.equal(thread.turn, 'a');
});

test('advanceThread fecha a thread no target e envia close', () => {
  let t = openThread(CHIPS[0], CHIPS[1]);
  t.target = 3;
  let last;
  for (let i = 0; i < 3; i++) {
    const r = advanceThread(t);
    last = r;
    t = r.thread;
  }
  assert.equal(last.send.stage, 'close');
  assert.equal(last.thread, null);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `pickPair is not a function` (ainda não exportada).

- [ ] **Step 3: Implementar as funções puras**

Adicionar a `src/warmer.js`:

```js
/** Sorteia dois chips distintos da lista. rnd injetável para teste. */
export function pickPair(chips, rnd = Math.random) {
  if (!Array.isArray(chips) || chips.length < 2) {
    throw new Error('pickPair: precisa de ao menos 2 chips');
  }
  const i = Math.floor(rnd() * chips.length);
  let j = Math.floor(rnd() * (chips.length - 1));
  if (j >= i) j += 1;
  return { a: chips[i], b: chips[j] };
}

/** Abre uma thread A<->B com alvo de trocas aleatório (3..8). */
export function openThread(a, b, rnd = Math.random) {
  return {
    aInst: a.instance, aJid: a.jid,
    bInst: b.instance, bJid: b.jid,
    turn: 'a', exchanges: 0,
    target: 3 + Math.floor(rnd() * 6), // 3..8
  };
}

/**
 * Avança a thread uma fala. Retorna a instrução de envio e a thread atualizada
 * (ou null quando a conversa fecha). Estágios pela ordem da conversa:
 * exchanges 0 → 'open' (A abre); 1 → 'reply' (B responde); meio → 'followup';
 * ao atingir target → 'close'. `turn` alterna a cada fala.
 */
export function advanceThread(thread) {
  const isCloser = thread.exchanges + 1 >= thread.target;
  const stage = isCloser ? 'close'
    : (thread.exchanges === 0 ? 'open'
    : (thread.exchanges === 1 ? 'reply' : 'followup'));
  const sender = thread.turn === 'a'
    ? { fromInst: thread.aInst, toJid: thread.bJid }
    : { fromInst: thread.bInst, toJid: thread.aJid };
  const send = { ...sender, stage };
  if (isCloser) return { thread: null, send };
  return {
    thread: { ...thread, turn: thread.turn === 'a' ? 'b' : 'a', exchanges: thread.exchanges + 1 },
    send,
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS — todos os testes (Task 1 + Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/warmer.js test/warmer.test.js
git commit -m "feat(warmer): selecao de par mesh e maquina de estado de thread"
```

---

### Task 3: Janela horária e cadência (funções puras)

**Files:**
- Modify: `src/warmer.js`
- Test: `test/warmer.test.js`

**Interfaces:**
- Consumes: `config` (Task 1 import).
- Produces (exportadas de `src/warmer.js`):
  - `parseWindow(str: string, fallback): {startH,startM,endH,endM}` — parseia `"07:00-23:00"`.
  - `withinWindow(win, nowMinutes: number): boolean` — true se `nowMinutes` está no intervalo `[início, fim)`.
  - `effectiveCap(dailyCap: number, rampDays: number, daysSinceStart: number): number` — teto efetivo do dia; `0` significa "sem teto" e devolve `Infinity`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar a `test/warmer.test.js`:

```js
import { parseWindow, withinWindow, effectiveCap } from '../src/warmer.js';

test('parseWindow le HH:MM-HH:MM', () => {
  assert.deepEqual(parseWindow('07:00-23:00', null), { startH: 7, startM: 0, endH: 23, endM: 0 });
});

test('parseWindow cai no fallback se invalido', () => {
  const fb = { startH: 8, startM: 0, endH: 22, endM: 0 };
  assert.deepEqual(parseWindow('lixo', fb), fb);
});

test('withinWindow respeita inicio inclusivo e fim exclusivo', () => {
  const w = { startH: 7, startM: 0, endH: 23, endM: 0 };
  assert.equal(withinWindow(w, 7 * 60), true);      // 07:00 dentro
  assert.equal(withinWindow(w, 22 * 60 + 59), true); // 22:59 dentro
  assert.equal(withinWindow(w, 23 * 60), false);     // 23:00 fora
  assert.equal(withinWindow(w, 6 * 60 + 59), false); // 06:59 fora
});

test('effectiveCap: cap 0 = sem teto (Infinity)', () => {
  assert.equal(effectiveCap(0, 0, 0), Infinity);
  assert.equal(effectiveCap(0, 7, 3), Infinity);
});

test('effectiveCap: sem ramp devolve o cap cheio', () => {
  assert.equal(effectiveCap(50, 0, 0), 50);
});

test('effectiveCap: ramp linear sobe ate o cap', () => {
  // ramp 10 dias, cap 100 → dia 0 = 10, dia 5 = ~55, dia >=9 = 100
  assert.equal(effectiveCap(100, 10, 0), 10);
  assert.equal(effectiveCap(100, 10, 9), 100);
  assert.ok(effectiveCap(100, 10, 4) > 10 && effectiveCap(100, 10, 4) < 100);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `parseWindow is not a function`.

- [ ] **Step 3: Implementar**

Adicionar a `src/warmer.js`:

```js
/** Parseia "HH:MM-HH:MM" → {startH,startM,endH,endM}; fallback se inválido. */
export function parseWindow(str, fallback) {
  const m = String(str ?? '').match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);
  if (!m) return fallback;
  return { startH: +m[1], startM: +m[2], endH: +m[3], endM: +m[4] };
}

/** true se nowMinutes (0..1439) está em [início, fim). */
export function withinWindow(win, nowMinutes) {
  const start = win.startH * 60 + win.startM;
  const end = win.endH * 60 + win.endM;
  return nowMinutes >= start && nowMinutes < end;
}

/**
 * Teto efetivo do dia para um chip. cap=0 → Infinity (sem limite). Com rampDays>0
 * o teto sobe linearmente de cap/rampDays no dia 0 até cap no dia (rampDays-1).
 */
export function effectiveCap(dailyCap, rampDays, daysSinceStart) {
  if (!dailyCap || dailyCap <= 0) return Infinity;
  if (!rampDays || rampDays <= 0) return dailyCap;
  const frac = Math.min(1, (daysSinceStart + 1) / rampDays);
  return Math.max(1, Math.round(dailyCap * frac));
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warmer.js test/warmer.test.js
git commit -m "feat(warmer): janela horaria e teto efetivo com ramp (puros)"
```

---

### Task 4: Descoberta de chips com cache

**Files:**
- Modify: `src/warmer.js`
- Test: `test/warmer.test.js`

**Interfaces:**
- Consumes: `evoFetch` (import existente).
- Produces (exportada de `src/warmer.js`):
  - `extractConnectedChips(fetchResult: any): {instance,jid}[]` — pura: extrai instâncias com `connectionStatus === 'open'` e `ownerJid` presente, da resposta de `GET /instance/fetchInstances`. Tolera os dois formatos da Evolution v1.8.x (item plano `{instance:{instanceName,owner,connectionStatus}}` OU `{name,ownerJid,connectionStatus}`).

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `test/warmer.test.js`:

```js
import { extractConnectedChips } from '../src/warmer.js';

test('extractConnectedChips: formato com wrapper instance{}', () => {
  const raw = [
    { instance: { instanceName: 'chip-1', owner: '5511111111111@s.whatsapp.net', connectionStatus: 'open' } },
    { instance: { instanceName: 'chip-2', owner: '5522222222222@s.whatsapp.net', connectionStatus: 'close' } },
  ];
  const chips = extractConnectedChips(raw);
  assert.equal(chips.length, 1);
  assert.deepEqual(chips[0], { instance: 'chip-1', jid: '5511111111111@s.whatsapp.net' });
});

test('extractConnectedChips: formato plano name/ownerJid', () => {
  const raw = [
    { name: 'chip-a', ownerJid: '5599999999999@s.whatsapp.net', connectionStatus: 'open' },
  ];
  const chips = extractConnectedChips(raw);
  assert.deepEqual(chips, [{ instance: 'chip-a', jid: '5599999999999@s.whatsapp.net' }]);
});

test('extractConnectedChips: descarta sem jid ou desconectado e lida com null', () => {
  assert.deepEqual(extractConnectedChips(null), []);
  const raw = [{ name: 'x', connectionStatus: 'open' }]; // sem ownerJid
  assert.deepEqual(extractConnectedChips(raw), []);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `extractConnectedChips is not a function`.

- [ ] **Step 3: Implementar**

Adicionar a `src/warmer.js`:

```js
/**
 * Normaliza a resposta de GET /instance/fetchInstances para [{instance,jid}],
 * mantendo só conexões 'open' com ownerJid. Tolera os formatos v1.8.x.
 */
export function extractConnectedChips(fetchResult) {
  const arr = Array.isArray(fetchResult) ? fetchResult
    : (fetchResult && Array.isArray(fetchResult.instances) ? fetchResult.instances : []);
  const out = [];
  for (const item of arr) {
    const inner = item?.instance ?? item ?? {};
    const name = inner.instanceName ?? inner.name ?? item?.name;
    const jid = inner.owner ?? inner.ownerJid ?? item?.ownerJid;
    const status = inner.connectionStatus ?? item?.connectionStatus;
    if (name && jid && status === 'open') out.push({ instance: name, jid });
  }
  return out;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warmer.js test/warmer.test.js
git commit -m "feat(warmer): extracao de chips conectados da Evolution (puro)"
```

---

### Task 5: Schema warmer_log + executor runWarmer

**Files:**
- Modify: `sql/schema.sql` (acrescentar tabela ao fim, antes de qualquer bloco de seed; pode ser no final do arquivo)
- Modify: `src/warmer.js`
- Test: manual (smoke) — `runWarmer` é integração com Evolution+Postgres.

**Interfaces:**
- Consumes: todas as funções puras das Tasks 1–4, `evoFetch`, `query`, `getSetting`, `setSetting`, `config`, `range`, `randomBetween`.
- Produces (exportadas de `src/warmer.js`):
  - `discoverChips(): Promise<{instance,jid}[]>` — chama `evoFetch('/instance/fetchInstances')`, aplica `extractConnectedChips`, cacheia ~5 min em setting `warmer_chips_cache`.
  - `runWarmer(): Promise<void>` — executor por tick; nunca lança.
  - `warmerStats(): Promise<{enabled,chips,sentToday,openThreads,nextAt}>` — para o painel.

- [ ] **Step 1: Acrescentar a tabela ao schema**

Adicionar ao FINAL de `sql/schema.sql`:

```sql

-- Aquecedor de chips: log de mensagens trocadas entre instâncias (contagem/auditoria).
CREATE TABLE IF NOT EXISTS warmer_log (
  id        BIGSERIAL PRIMARY KEY,
  from_inst TEXT NOT NULL,
  to_jid    TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warmer_log_sent_at_idx ON warmer_log (sent_at);
```

- [ ] **Step 2: Aplicar a migração**

Run: `npm run migrate`
Expected: `Schema aplicado com sucesso.` (schema.sql é idempotente — `CREATE TABLE IF NOT EXISTS`).

- [ ] **Step 3: Implementar discoverChips, runWarmer e warmerStats**

Adicionar a `src/warmer.js`:

```js
const CHIPS_TTL_MS = 5 * 60 * 1000;

/** Hora atual (minutos do dia) no timezone configurado. */
function tzNowMinutes() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.tz, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date())) p[type] = value;
  return (+p.hour % 24) * 60 + +p.minute;
}

/** Descobre chips conectados, com cache de ~5 min em setting. */
export async function discoverChips() {
  const cacheRaw = await getSetting('warmer_chips_cache', '');
  if (cacheRaw) {
    try {
      const { at, chips } = JSON.parse(cacheRaw);
      if (Date.now() - at < CHIPS_TTL_MS && Array.isArray(chips)) return chips;
    } catch { /* cache corrompido: refaz */ }
  }
  const res = await evoFetch('/instance/fetchInstances'); // GET (body undefined)
  const chips = extractConnectedChips(res);
  await setSetting('warmer_chips_cache', JSON.stringify({ at: Date.now(), chips }));
  return chips;
}

let running = false;

/**
 * Executor do aquecedor (chamado por cron a cada minuto). Envia NO MÁXIMO 1
 * mensagem por chamada, respeitando: kill-switch, janela, espaçamento e teto
 * opcional. Continua threads abertas (conversa encadeada) ou abre uma nova.
 * Nunca lança.
 */
export async function runWarmer() {
  if (running) return;
  running = true;
  try {
    if ((await getSetting('warmer_enabled', 'off')) !== 'on') return;

    const win = parseWindow(await getSetting('warmer_window', '07:00-23:00'),
      { startH: 7, startM: 0, endH: 23, endM: 0 });
    if (!withinWindow(win, tzNowMinutes())) return;

    const nextAt = await getSetting('warmer_next_at', '');
    if (nextAt && Date.now() < new Date(nextAt).getTime()) return;

    const chips = await discoverChips();
    if (chips.length < 2) return;

    // teto opcional por chip/dia (com ramp opcional)
    const cap = Number(await getSetting('warmer_daily_cap', '0')) || 0;
    const rampDays = Number(await getSetting('warmer_ramp_days', '0')) || 0;

    // Continua uma thread aberta (70%) ou abre nova. Threads em setting JSON.
    let threads = [];
    try { threads = JSON.parse(await getSetting('warmer_threads', '[]')) || []; } catch { threads = []; }
    // descarta threads cujos chips sumiram da lista de conectados
    const live = new Set(chips.map((c) => c.instance));
    threads = threads.filter((t) => live.has(t.aInst) && live.has(t.bInst));

    let toSend = null; // { fromInst, toJid, stage }
    let idx = -1;
    if (threads.length && Math.random() < 0.7) {
      idx = Math.floor(Math.random() * threads.length);
      const r = advanceThread(threads[idx]);
      toSend = r.send;
      if (r.thread) threads[idx] = r.thread; else threads.splice(idx, 1);
    } else {
      const { a, b } = pickPair(chips);
      const r = advanceThread(openThread(a, b)); // 1ª fala = 'open' de A para B
      toSend = r.send;
      if (r.thread) threads.push(r.thread);
    }

    // teto: conta envios de hoje do chip remetente
    if (cap > 0) {
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM warmer_log
          WHERE from_inst = $1 AND sent_at >= date_trunc('day', now())`,
        [toSend.fromInst]
      );
      const startRaw = await getSetting('warmer_started_at', '');
      const days = startRaw
        ? Math.floor((Date.now() - new Date(startRaw).getTime()) / 86400000) : 0;
      if (rows[0].n >= effectiveCap(cap, rampDays, days)) {
        // chip no teto: salva threads e reagenda sem enviar
        await setSetting('warmer_threads', JSON.stringify(threads));
        await setSetting('warmer_next_at',
          new Date(Date.now() + randomBetween(range(await getSetting('warmer_spacing_ms', '20000-120000'), [20000, 120000]))).toISOString());
        return;
      }
    }

    const text = buildWarmerMessage(toSend.stage);
    const result = await evoFetch(`/message/sendText/${toSend.fromInst}`, {
      number: toSend.toJid,
      options: { delay: randomBetween([1200, 4000]), presence: 'composing' },
      textMessage: { text },
    });

    if (result !== null) {
      await query('INSERT INTO warmer_log (from_inst, to_jid) VALUES ($1, $2)',
        [toSend.fromInst, toSend.toJid]);
      if (!(await getSetting('warmer_started_at', ''))) {
        await setSetting('warmer_started_at', new Date().toISOString());
      }
      console.log(`[warmer] ${toSend.fromInst} → ${toSend.toJid.split('@')[0]} (${toSend.stage})`);
    } else {
      console.log(`[warmer] envio falhou via ${toSend.fromInst}`);
    }

    await setSetting('warmer_threads', JSON.stringify(threads));
    const spacing = range(await getSetting('warmer_spacing_ms', '20000-120000'), [20000, 120000]);
    await setSetting('warmer_next_at', new Date(Date.now() + randomBetween(spacing)).toISOString());
  } catch (err) {
    console.log(`[warmer] erro no executor: ${err.message}`);
  } finally {
    running = false;
  }
}

/** Estatísticas para o painel. Nunca lança (retorna zeros em erro). */
export async function warmerStats() {
  try {
    const enabled = (await getSetting('warmer_enabled', 'off')) === 'on';
    const chips = await discoverChips();
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM warmer_log WHERE sent_at >= date_trunc('day', now())`
    );
    let openThreads = 0;
    try { openThreads = (JSON.parse(await getSetting('warmer_threads', '[]')) || []).length; } catch { openThreads = 0; }
    return {
      enabled,
      chips: chips.length,
      sentToday: rows[0].n,
      openThreads,
      nextAt: await getSetting('warmer_next_at', ''),
    };
  } catch (err) {
    console.log(`[warmer] erro em warmerStats: ${err.message}`);
    return { enabled: false, chips: 0, sentToday: 0, openThreads: 0, nextAt: '' };
  }
}
```

- [ ] **Step 4: Smoke manual do executor**

Garantir que há ao menos 2 instâncias conectadas na Evolution. Num shell com o `.env` carregado, rodar uma vez forçando o estado ligado:

Run:
```bash
node --input-type=module -e "import('./src/db.js').then(async ({setSetting,pool})=>{await setSetting('warmer_enabled','on');await setSetting('warmer_window','00:00-23:59');await setSetting('warmer_next_at','');const {runWarmer,warmerStats}=await import('./src/warmer.js');await runWarmer();console.log(await warmerStats());await pool.end();})"
```
Expected: log `[warmer] <chip> → <numero> (open)` e um objeto `warmerStats` com `chips >= 2` e `sentToday >= 1`. Conferir no WhatsApp que a mensagem chegou de um chip ao outro.

- [ ] **Step 5: Desligar de volta e commit**

Run:
```bash
node --input-type=module -e "import('./src/db.js').then(async ({setSetting,pool})=>{await setSetting('warmer_enabled','off');await pool.end();})"
git add sql/schema.sql src/warmer.js
git commit -m "feat(warmer): executor runWarmer + discoverChips + warmerStats + tabela warmer_log"
```

---

### Task 6: Registrar o cron no scheduler

**Files:**
- Modify: `src/scheduler.js` (import no topo, junto dos demais; e novo `cron.schedule` no bloco de registros ~linha 525, ao lado do `runBroadcast`)

**Interfaces:**
- Consumes: `runWarmer` (Task 5).
- Produces: cron ativo minuto-a-minuto.

- [ ] **Step 1: Adicionar o import**

Em `src/scheduler.js`, ao lado de `import { runBroadcast, broadcastStats } from './broadcast.js';` (linha 13), adicionar:

```js
import { runWarmer } from './warmer.js';
```

- [ ] **Step 2: Registrar o cron**

Em `src/scheduler.js`, logo após a linha do broadcast (`cron.schedule('* * * * *', () => { runBroadcast(); }, opts);`), adicionar:

```js
  // 3d. aquecedor de chips: por minuto; espaçamento/janela/teto internos
  //     controlam a cadência. Roda contínuo enquanto warmer_enabled='on'.
  cron.schedule('* * * * *', () => { runWarmer(); }, opts);
```

- [ ] **Step 3: Verificar boot sem erro**

Run: `node -e "import('./src/scheduler.js').then(()=>console.log('scheduler import OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `scheduler import OK` (sem erro de import/sintaxe).

- [ ] **Step 4: Commit**

```bash
git add src/scheduler.js
git commit -m "feat(warmer): registra cron do aquecedor no scheduler"
```

---

### Task 7: Rotas REST do painel

**Files:**
- Modify: `src/panel.js` (import no topo ~linha 11; bloco de rotas dentro de `registerPanelRoutes`, junto das demais `/api/*`)

**Interfaces:**
- Consumes: `warmerStats` (Task 5), `getSetting`/`setSetting` (db).
- Produces:
  - `GET  /api/warmer/status` → `{ ...warmerStats(), spacingMs, window, dailyCap, rampDays }`.
  - `POST /api/warmer/toggle` body `{ enabled: boolean }` → `{ ok:true, enabled }`.
  - `POST /api/warmer/settings` body `{ spacingMin?, spacingMax?, window?, dailyCap?, rampDays? }` → `{ ok:true }`.

- [ ] **Step 1: Adicionar imports**

Em `src/panel.js`, junto de `import { importContacts, broadcastStats, sendTestInvite } from './broadcast.js';` (linha 11), adicionar:

```js
import { warmerStats } from './warmer.js';
import { getSetting, setSetting } from './db.js';
```

(Se `getSetting`/`setSetting` já estiverem importados de `./db.js` neste arquivo, apenas acrescentar os nomes ao import existente em vez de duplicar a linha.)

- [ ] **Step 2: Registrar as rotas**

Dentro de `registerPanelRoutes(app, requireAdmin)`, junto das demais rotas `/api/*` (ex.: após o handler `/api/health`), adicionar:

```js
  app.get('/api/warmer/status', requireAdmin, asyncRoute(async (_req, res) => {
    const stats = await warmerStats();
    res.json({
      ...stats,
      spacingMs: await getSetting('warmer_spacing_ms', '20000-120000'),
      window: await getSetting('warmer_window', '07:00-23:00'),
      dailyCap: Number(await getSetting('warmer_daily_cap', '0')) || 0,
      rampDays: Number(await getSetting('warmer_ramp_days', '0')) || 0,
    });
  }));

  app.post('/api/warmer/toggle', requireAdmin, asyncRoute(async (req, res) => {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    await setSetting('warmer_enabled', enabled ? 'on' : 'off');
    if (enabled) await setSetting('warmer_next_at', ''); // dispara já no próximo tick
    res.json({ ok: true, enabled });
  }));

  app.post('/api/warmer/settings', requireAdmin, asyncRoute(async (req, res) => {
    const b = req.body || {};
    if (b.spacingMin != null && b.spacingMax != null) {
      const min = Math.max(1, Math.round(Number(b.spacingMin) * 1000)); // segundos → ms
      const max = Math.max(min, Math.round(Number(b.spacingMax) * 1000));
      await setSetting('warmer_spacing_ms', `${min}-${max}`);
    }
    if (typeof b.window === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(b.window)) {
      await setSetting('warmer_window', b.window);
    }
    if (b.dailyCap != null) await setSetting('warmer_daily_cap', String(Math.max(0, Math.floor(Number(b.dailyCap)) || 0)));
    if (b.rampDays != null) await setSetting('warmer_ramp_days', String(Math.max(0, Math.floor(Number(b.rampDays)) || 0)));
    res.json({ ok: true });
  }));
```

(`asyncRoute` é o wrapper já usado pelas demais rotas neste arquivo — reutilizar o mesmo.)

- [ ] **Step 3: Verificar import sem erro**

Run: `node -e "import('./src/panel.js').then(()=>console.log('panel import OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `panel import OK`.

- [ ] **Step 4: Smoke das rotas**

Com o servidor rodando (`npm start`) e o header de admin configurado, testar (substituir `<ADMIN>` pelo valor do header de auth usado pelo painel):

Run:
```bash
curl -s -X POST localhost:3000/api/warmer/toggle -H 'content-type: application/json' -H 'x-admin-key: <ADMIN>' -d '{"enabled":true}'
curl -s localhost:3000/api/warmer/status -H 'x-admin-key: <ADMIN>'
```
Expected: 1ª retorna `{"ok":true,"enabled":true}`; 2ª retorna JSON com `enabled:true`, `chips`, `sentToday`, `spacingMs`, `window`. (Conferir a porta real em `src/index.js`/`.env` e o nome do header de admin em `src/panel.js`.)

- [ ] **Step 5: Commit**

```bash
git add src/panel.js
git commit -m "feat(warmer): rotas /api/warmer status/toggle/settings"
```

---

### Task 8: Aba "Aquecedor" no painel

**Files:**
- Modify: `public/painel.html` (botão de aba ~linha 341; `<section>` nova ao lado de `tab-disparos` ~linha 507; JS de carregamento junto de `loadBroadcast`/dispatch de abas ~linhas 1323/1375)

**Interfaces:**
- Consumes: rotas `/api/warmer/*` (Task 7).
- Produces: UI funcional (toggle, settings, status).

- [ ] **Step 1: Adicionar o botão da aba**

Em `public/painel.html`, junto da linha do botão de disparos (`<button type="button" class="tab" data-tab="disparos">Disparos</button>`, ~341), adicionar logo depois:

```html
      <button type="button" class="tab" data-tab="aquecedor">Aquecedor</button>
```

- [ ] **Step 2: Adicionar a section**

Logo após o fechamento da `<section id="tab-disparos">` (~linha onde ela termina, perto da 600), adicionar:

```html
    <section id="tab-aquecedor" class="hidden">
      <div class="warn" style="margin-bottom:12px;">
        🔥 <b>Aquecedor de chips.</b> Faz as instâncias conectadas conversarem entre si (mesh),
        contínuo, até você desligar aqui. Use chips dedicados ao aquecimento.
      </div>

      <div class="card form">
        <h2>🔥 Status do aquecedor</h2>
        <div id="wm-status" class="cfg-status"><span class="muted">carregando…</span></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
          <button id="btn-wm-on" class="btn btn-primary" type="button">▶️ Ligar</button>
          <button id="btn-wm-off" class="btn btn-danger-ghost" type="button">⏸️ Desligar</button>
          <button id="btn-wm-refresh" class="btn" type="button">Atualizar</button>
        </div>
      </div>

      <div class="card form">
        <h2>⚙️ Configuração</h2>
        <p class="cfg-note">⚡ Vale na hora que você salva. Espaçamento menor = mais conversa.</p>
        <div class="row2">
          <label>Espaçamento — mínimo (segundos)
            <input id="wm-space-min" type="number" min="1" step="1" inputmode="numeric" placeholder="20">
          </label>
          <label>Espaçamento — máximo (segundos)
            <input id="wm-space-max" type="number" min="1" step="1" inputmode="numeric" placeholder="120">
          </label>
        </div>
        <label>Janela horária <span class="muted">— formato HH:MM-HH:MM</span>
          <input id="wm-window" type="text" placeholder="07:00-23:00">
        </label>
        <div class="row2">
          <label>Teto por chip/dia <span class="muted">— 0 = sem limite</span>
            <input id="wm-cap" type="number" min="0" step="1" inputmode="numeric" placeholder="0">
          </label>
          <label>Dias de ramp <span class="muted">— 0 = desligado</span>
            <input id="wm-ramp" type="number" min="0" step="1" inputmode="numeric" placeholder="0">
          </label>
        </div>
        <button id="btn-wm-save" class="btn btn-primary" type="button" style="margin-top:8px;">Salvar configuração</button>
      </div>
    </section>
```

- [ ] **Step 3: Adicionar o JS de carregamento**

No `<script>` do painel, adicionar a função `loadWarmer` (junto das demais `load*`) e ligar os botões. Usar o mesmo helper de fetch autenticado que `loadBroadcast` usa (procurar como `loadBroadcast` faz a chamada — ex. `api('/api/...')` ou `fetch` com header; reutilizar exatamente o mesmo padrão deste arquivo):

```js
async function loadWarmer() {
  try {
    const s = await api('/api/warmer/status');
    document.getElementById('wm-status').innerHTML =
      (s.enabled ? '🟢 <b>Ligado</b>' : '⚪ <b>Desligado</b>') +
      ' — chips conectados: <b>' + s.chips + '</b>' +
      ' · enviadas hoje: <b>' + s.sentToday + '</b>' +
      ' · conversas abertas: <b>' + s.openThreads + '</b>' +
      (s.nextAt ? ' · próximo: ' + new Date(s.nextAt).toLocaleTimeString('pt-BR') : '');
    const sp = String(s.spacingMs || '20000-120000').split('-');
    document.getElementById('wm-space-min').value = Math.round((+sp[0] || 20000) / 1000);
    document.getElementById('wm-space-max').value = Math.round((+sp[1] || 120000) / 1000);
    document.getElementById('wm-window').value = s.window || '07:00-23:00';
    document.getElementById('wm-cap').value = s.dailyCap || 0;
    document.getElementById('wm-ramp').value = s.rampDays || 0;
  } catch (e) {
    document.getElementById('wm-status').innerHTML = '<span class="muted">erro ao carregar</span>';
  }
}

document.getElementById('btn-wm-on').addEventListener('click', async () => {
  await api('/api/warmer/toggle', { method: 'POST', body: { enabled: true } });
  loadWarmer();
});
document.getElementById('btn-wm-off').addEventListener('click', async () => {
  await api('/api/warmer/toggle', { method: 'POST', body: { enabled: false } });
  loadWarmer();
});
document.getElementById('btn-wm-refresh').addEventListener('click', loadWarmer);
document.getElementById('btn-wm-save').addEventListener('click', async () => {
  await api('/api/warmer/settings', { method: 'POST', body: {
    spacingMin: +document.getElementById('wm-space-min').value,
    spacingMax: +document.getElementById('wm-space-max').value,
    window: document.getElementById('wm-window').value.trim(),
    dailyCap: +document.getElementById('wm-cap').value,
    rampDays: +document.getElementById('wm-ramp').value,
  }});
  loadWarmer();
});
```

> **Nota de adaptação:** este arquivo usa um helper próprio para chamadas autenticadas (o mesmo que `loadBroadcast` invoca). Antes de escrever, leia como `loadBroadcast` faz o `fetch`/`api` e o envio de body, e ajuste as chamadas acima para o MESMO formato (nome do helper, como passa método/body/headers). Não introduza um padrão de fetch novo.

- [ ] **Step 4: Ligar a aba ao dispatch de carregamento**

Localizar os dois pontos onde as abas disparam seu load (a linha `else if (activeTab === 'disparos') jobs.push(loadBroadcast());` ~1323 e `else if (name === 'disparos') loadBroadcast();` ~1375) e adicionar, em cada um, a cláusula equivalente para o aquecedor:

```js
  else if (activeTab === 'aquecedor') jobs.push(loadWarmer());
```
e
```js
  else if (name === 'aquecedor') loadWarmer();
```

- [ ] **Step 5: Verificar no navegador**

Run: `npm start` e abrir o painel. Clicar na aba **Aquecedor**.
Expected: status carrega (mostra nº de chips conectados); botão **Ligar** muda o status para 🟢; **Salvar configuração** persiste e recarrega os campos com os valores salvos. Após ligar, em até ~1 min uma mensagem trafega entre dois chips (conferir no WhatsApp e no log `[warmer]`).

- [ ] **Step 6: Commit**

```bash
git add public/painel.html
git commit -m "feat(warmer): aba Aquecedor no painel (status, toggle, config)"
```

---

## Notas de execução

- **TDD aplica-se às Tasks 1–4** (funções puras, `node:test`). As Tasks 5–8 são integração/UI: validadas por smoke manual descrito em cada uma, pois dependem da Evolution conectada, do Postgres e do DOM do painel.
- **Git:** o ambiente reporta "not a git repository". Se os comandos `git commit` falharem, ignore-os e prossiga — o código não depende de git.
- **Header de admin / porta:** confirmar em `src/panel.js` (nome do header em `requireAdmin`) e em `src/index.js`/`.env` (porta) antes dos smokes com `curl`.
