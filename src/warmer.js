// Aquecedor de chips: faz as instâncias conectadas conversarem entre si (mesh)
// de forma contínua e realista. Executor nunca lança (padrão broadcast.js).
import { config, randomBetween, range } from './config.js';
import { query, getSetting, setSetting } from './db.js';
import { evoFetch, notifyOwnerOnce } from './poster.js';
import { normalizePhone } from './broadcast.js';
import { OPENERS, REPLIES, FOLLOWUPS, CLOSERS } from './warmer-phrases.js';

// Circuit breaker (mesmo padrão do instagram.js/broadcast.js): falhas SEGUIDAS
// de envio indicam chip(s) desconectado(s) — sem isso o cron ficaria tentando
// pra sempre em silêncio, só logando.
const MAX_WARMER_FAIL_STREAK = 5;

async function bumpWarmerFailStreak(reason) {
  const n = Number(await getSetting('warmer_fail_streak', '0') || 0) + 1;
  await setSetting('warmer_fail_streak', String(n));
  if (n >= MAX_WARMER_FAIL_STREAK) {
    await setSetting('warmer_enabled', 'off');
    await setSetting('warmer_fail_streak', '0');
    console.log(`[warmer] AUTO-DESLIGADO após ${MAX_WARMER_FAIL_STREAK} falhas seguidas — confira os chips conectados.`);
    await notifyOwnerOnce(
      'warmer-autodisabled',
      `🔥⚠️ Aquecedor: DESLIGADO automaticamente após ${MAX_WARMER_FAIL_STREAK} falhas seguidas de envio (chip(s) provavelmente desconectado(s)). Reative na aba Aquecedor.\nÚltimo erro: ${String(reason || '').slice(0, 120)}`,
      { everyHours: 12 }
    ).catch(() => {});
  }
}

async function resetWarmerFailStreak() {
  await setSetting('warmer_fail_streak', '0');
}

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

/** Sorteia 1 item de uma lista não vazia. rnd injetável para teste. */
export function pickOne(list, rnd = Math.random) {
  return list[Math.floor(rnd() * list.length)];
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

/**
 * Normaliza a resposta de GET /instance/fetchInstances para [{instance,jid}],
 * mantendo só conexões 'open' com ownerJid. Tolera os formatos v1.8.x e v2.x.
 */
export function extractConnectedChips(fetchResult) {
  const arr = Array.isArray(fetchResult) ? fetchResult
    : (fetchResult && Array.isArray(fetchResult.instances) ? fetchResult.instances : []);
  const out = [];
  for (const item of arr) {
    const inner = item?.instance ?? item ?? {};
    const name = inner.instanceName ?? inner.name ?? item?.name;
    const jid = inner.owner ?? inner.ownerJid ?? item?.ownerJid;
    const status = inner.connectionStatus ?? inner.status ?? item?.connectionStatus ?? item?.status;
    if (name && jid && status === 'open') out.push({ instance: name, jid });
  }
  return out;
}

/**
 * Filtra a lista de chips pela allowlist (CSV de nomes de instância).
 * csv vazio/nulo → devolve todos (sem restrição).
 */
export function filterAllowed(chips, csv) {
  const allow = String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return chips;
  const set = new Set(allow);
  return chips.filter((c) => set.has(c.instance));
}

/**
 * Parseia a lista de números-alvo (CSV de DDI+DDD+número) para [{phone,jid}].
 * Números inválidos são descartados silenciosamente. csv vazio → [].
 */
export function parseTargets(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizePhone(s))
    .filter(Boolean);
}

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
 * opcional. Continua threads abertas (conversa encadeada), abre uma nova entre
 * chips do mesh, ou (se houver números-alvo cadastrados) manda uma mensagem
 * avulsa de um chip sorteado pro número-alvo — usado pra aquecer números de
 * fora do mesh (ex.: API oficial), que não respondem pelo sistema.
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

    const allChips = await discoverChips();
    const chips = filterAllowed(allChips, await getSetting('warmer_instances', ''));
    const targets = parseTargets(await getSetting('warmer_targets', ''));
    if (chips.length < 2 && !(chips.length && targets.length)) return;

    const cap = Number(await getSetting('warmer_daily_cap', '0')) || 0;
    const rampDays = Number(await getSetting('warmer_ramp_days', '0')) || 0;

    let threads = [];
    try { threads = JSON.parse(await getSetting('warmer_threads', '[]')) || []; } catch { threads = []; }
    const live = new Set(chips.map((c) => c.instance));
    threads = threads.filter((t) => live.has(t.aInst) && live.has(t.bInst));

    let toSend = null; // { fromInst, toJid, stage }
    if (chips.length && targets.length && Math.random() < 0.3) {
      const chip = pickOne(chips);
      const target = pickOne(targets);
      const stage = pickOne(['open', 'reply', 'followup']);
      toSend = { fromInst: chip.instance, toJid: target.jid, stage };
    } else if (threads.length && Math.random() < 0.7) {
      const idx = Math.floor(Math.random() * threads.length);
      const r = advanceThread(threads[idx]);
      toSend = r.send;
      if (r.thread) threads[idx] = r.thread; else threads.splice(idx, 1);
    } else if (chips.length >= 2) {
      const { a, b } = pickPair(chips);
      const r = advanceThread(openThread(a, b)); // 1a fala = open de A para B
      toSend = r.send;
      if (r.thread) threads.push(r.thread);
    } else {
      return; // só sobrou 1 chip e nenhum alvo pra mandar mensagem
    }

    const spacing = range(await getSetting('warmer_spacing_ms', '20000-120000'), [20000, 120000]);

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
        await setSetting('warmer_threads', JSON.stringify(threads));
        await setSetting('warmer_next_at', new Date(Date.now() + randomBetween(spacing)).toISOString());
        return;
      }
    }

    const text = buildWarmerMessage(toSend.stage);
    const result = await evoFetch(`/message/sendText/${toSend.fromInst}`, {
      number: toSend.toJid,
      text,
      delay: randomBetween([1200, 4000]),
    });

    if (result !== null) {
      await query('INSERT INTO warmer_log (from_inst, to_jid) VALUES ($1, $2)',
        [toSend.fromInst, toSend.toJid]);
      if (!(await getSetting('warmer_started_at', ''))) {
        await setSetting('warmer_started_at', new Date().toISOString());
      }
      console.log(`[warmer] ${toSend.fromInst} -> ${toSend.toJid.split('@')[0]} (${toSend.stage})`);
      await resetWarmerFailStreak();
    } else {
      console.log(`[warmer] envio falhou via ${toSend.fromInst}`);
      await bumpWarmerFailStreak(`envio falhou via ${toSend.fromInst}`);
    }

    await setSetting('warmer_threads', JSON.stringify(threads));
    await setSetting('warmer_next_at', new Date(Date.now() + randomBetween(spacing)).toISOString());
  } catch (err) {
    console.log(`[warmer] erro no executor: ${err.message}`);
  } finally {
    running = false;
  }
}

/**
 * Disparo imediato: cada chip do allowlist manda 1 mensagem avulsa pro número
 * informado, ignorando janela/espaçamento/teto — usado pelo botão "disparar
 * agora" do painel pra aquecer um número de fora do mesh (ex.: API oficial).
 * Nunca lança.
 */
export async function blastWarmerTarget(rawNumber) {
  const norm = normalizePhone(rawNumber);
  if (!norm) return { ok: false, error: 'número inválido' };

  const allChips = await discoverChips();
  const chips = filterAllowed(allChips, await getSetting('warmer_instances', ''));
  if (!chips.length) return { ok: false, error: 'nenhum chip conectado no aquecedor' };

  let sent = 0;
  for (const chip of chips) {
    try {
      const text = buildWarmerMessage(pickOne(['open', 'reply', 'followup']));
      const result = await evoFetch(`/message/sendText/${chip.instance}`, {
        number: norm.jid,
        text,
        delay: randomBetween([1200, 4000]),
      });
      if (result !== null) {
        sent += 1;
        await query('INSERT INTO warmer_log (from_inst, to_jid) VALUES ($1, $2)', [chip.instance, norm.jid]);
      }
    } catch (err) {
      console.log(`[warmer] blast falhou via ${chip.instance}: ${err.message}`);
    }
  }
  return { ok: sent > 0, sent, total: chips.length, jid: norm.jid };
}

/** Estatísticas para o painel. Nunca lança (retorna zeros em erro). */
export async function warmerStats() {
  try {
    const enabled = (await getSetting('warmer_enabled', 'off')) === 'on';
    const allChips = await discoverChips();
    const allowlist = await getSetting('warmer_instances', '');
    const chips = filterAllowed(allChips, allowlist);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM warmer_log WHERE sent_at >= date_trunc('day', now())`
    );
    let openThreads = 0;
    try { openThreads = (JSON.parse(await getSetting('warmer_threads', '[]')) || []).length; } catch { openThreads = 0; }
    return {
      enabled,
      chips: chips.length,
      instances: allChips.map((c) => c.instance),
      allowlist,
      targets: parseTargets(await getSetting('warmer_targets', '')).map((t) => t.phone),
      sentToday: rows[0].n,
      openThreads,
      nextAt: await getSetting('warmer_next_at', ''),
    };
  } catch (err) {
    console.log(`[warmer] erro em warmerStats: ${err.message}`);
    return { enabled: false, chips: 0, instances: [], allowlist: '', targets: [], sentToday: 0, openThreads: 0, nextAt: '' };
  }
}
