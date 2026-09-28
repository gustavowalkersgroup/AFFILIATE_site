// [broadcast] Disparos 1-a-1 NÃO-OFICIAIS via Evolution (convite pro grupo).
// ⚠️ Viola o ToS do WhatsApp e arrisca BAN do número — por isso usa uma
// instância DEDICADA (config.broadcast.instance, NÃO a affiliate-fitness),
// com anti-ban pesado: espaçamento grande randomizado, teto diário com ramp-up,
// janela de horário, opt-out automático e kill-switch (settings broadcast_paused).
import { config, randomBetween } from './config.js';
import { query, getSetting, setSetting } from './db.js';
import { evoFetch, notifyOwnerOnce } from './poster.js';

// Circuit breaker (mesmo padrão do instagram.js): falhas SEGUIDAS de envio (em
// TODAS as instâncias) indicam instância/API fora do ar, não número ruim —
// sem isso o cron drenaria a fila inteira pra 'failed' sem avisar o dono.
const MAX_BROADCAST_FAIL_STREAK = 5;

async function bumpBroadcastFailStreak(reason) {
  const n = Number(await getSetting('broadcast_fail_streak', '0') || 0) + 1;
  await setSetting('broadcast_fail_streak', String(n));
  if (n >= MAX_BROADCAST_FAIL_STREAK) {
    await setSetting('broadcast_paused', 'true');
    await setSetting('broadcast_fail_streak', '0');
    console.log(`[broadcast] AUTO-PAUSADO após ${MAX_BROADCAST_FAIL_STREAK} falhas seguidas — confira a(s) instância(s) dedicada(s).`);
    await notifyOwnerOnce(
      'bc-autopaused',
      `📨⚠️ Disparos: PAUSADOS automaticamente após ${MAX_BROADCAST_FAIL_STREAK} falhas seguidas (provável instância desconectada). Reconecte e retome na aba Disparos.\nÚltimo erro: ${String(reason || '').slice(0, 120)}`,
      { everyHours: 12 }
    ).catch(() => {});
  }
}

async function resetBroadcastFailStreak() {
  await setSetting('broadcast_fail_streak', '0');
}

// Variantes com SPINTAX {a|b|c} (resolvido por envio) + {nome}/{link}. A combinação
// 6 variantes × spintax × nome deixa quase todo envio único — anti-ban.
const DEFAULT_MESSAGES = [
  '{Oi|Olá|Opa}{nome}! {Tudo bem|Beleza|Como vai}? Montei um grupo no Zap só de {achados|promoções|ofertas} fitness — roupa, tênis e suplemento com desconto de verdade. {Bora|Quer entrar}? {link}',
  '{E aí|Fala}{nome}! Criei um grupinho com as {melhores|top} promoções fitness do dia, direto da fonte. Se quiser {dar uma olhada|conferir}, é só clicar 👇 {link}',
  '{Oi|Olá}{nome}, {tudo certo|beleza}? Tô reunindo as melhores ofertas de academia num grupo. Quer {entrar|participar}? {link}',
  '{Psiu|Ó}{nome}! Se você curte {treino|academia|fitness}, vai curtir: um grupo que só posta {oferta|promoção} boa de roupa, tênis e suplemento. {link}',
  '{Oi|Olá}{nome}! Separei um grupo de {descontos|ofertas} fitness — tem coisa saindo bem barata. Cola lá: {link}',
  '{Fala|E aí}{nome}! Grupo novo de {achados|ofertas} fitness pra quem treina. {Promoção relâmpago|Desconto bom} cai lá primeiro. {Entra|Bora}? {link}',
];

/* ------------------------------- helpers --------------------------------- */

// Normaliza um telefone BR cru para { phone (só dígitos), jid }. null se inválido.
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (!d.startsWith('55')) d = '55' + d;
  // 55 + DDD(2) + 8 ou 9 dígitos = 12 ou 13
  if (d.length < 12 || d.length > 13) return null;
  return { phone: d, jid: `${d}@s.whatsapp.net` };
}

function tzNowMinutes() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.tz, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date())) p[type] = value;
  return (+p.hour % 24) * 60 + +p.minute;
}

function withinBroadcastWindow() {
  const w = config.broadcast.window;
  const cur = tzNowMinutes();
  return cur >= w.startH * 60 + w.startM && cur < w.endH * 60 + w.endM;
}

export async function isBroadcastPaused() {
  return (await getSetting('broadcast_paused', 'true')) === 'true';
}

// Teto de hoje pelo ramp-up (semana desde broadcast_started_at).
async function rampTarget() {
  const startedAt = await getSetting('broadcast_started_at', '');
  const ramp = config.broadcast.dailyRamp.length ? config.broadcast.dailyRamp : [20];
  if (!startedAt) return ramp[0];
  const weeks = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / (7 * 24 * 3600 * 1000)));
  return ramp[Math.min(weeks, ramp.length - 1)];
}

async function sentTodayCount() {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM contacts
      WHERE status = 'sent' AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [config.tz]
  );
  return rows[0].n;
}

function firstName(name) {
  const n = String(name ?? '').trim().split(/\s+/)[0];
  return n && /^[\p{L}'-]{2,}$/u.test(n) ? n : '';
}

// Resolve SPINTAX: cada {a|b|c} vira uma opção aleatória. NÃO toca em {nome}/{link}
// (não têm '|'), que são substituídos depois.
function spin(text) {
  return String(text).replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
    const choices = opts.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

// true se há pelo menos um link de convite (lista de rodízio OU o único).
export function hasInviteLink() {
  return Boolean(config.broadcast.inviteLink || config.broadcast.inviteLinks.length);
}

// Round-robin entre os links (os 5 grupos) pra distribuir os contatos. Se só
// houver inviteLink único, usa ele. Counter em memória (reset no boot = ok).
let linkIdx = 0;
function pickLink() {
  const links = config.broadcast.inviteLinks.length
    ? config.broadcast.inviteLinks
    : (config.broadcast.inviteLink ? [config.broadcast.inviteLink] : ['']);
  const l = links[linkIdx % links.length];
  linkIdx++;
  return l;
}

function buildMessage(contact) {
  const variants = config.broadcast.messages.length ? config.broadcast.messages : DEFAULT_MESSAGES;
  const tpl = variants[Math.floor(Math.random() * variants.length)];
  const fn = firstName(contact?.name);
  return spin(tpl)
    .replace(/\{nome\}/g, fn ? ` ${fn}` : '')
    .replace(/\{link\}/g, pickLink());
}

// true se um texto curto de resposta indica opt-out (sair/parar/...).
export function isOptOut(text) {
  const norm = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!norm || norm.length > 40) return false;
  return config.broadcast.optOutKeywords.some((k) => {
    const kk = k.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return norm === kk || new RegExp(`(^|\\W)${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(norm);
  });
}

/* ------------------------------- API ------------------------------------- */

/**
 * Importa contatos de um texto cru (uma linha por contato; aceita
 * "nome,telefone", "telefone nome" ou só "telefone"). Normaliza, deduplica por
 * jid (ON CONFLICT mantém o status existente — não revive optout). Retorna
 * { adicionados, duplicados, invalidos, total }.
 */
// Extrai { jid, phone, name } de uma linha (CSV/TXT). Acha o TRECHO telefônico
// (sequência com 10-13 dígitos, mesmo com () - . espaço), ignorando dígitos
// soltos do nome/ID; nome = parte alfabética. null se não houver telefone válido.
function parseLine(line) {
  const candidates = (String(line).match(/\d[\d()+\-.\s]{8,}\d/g) || [])
    .map((s) => s.replace(/\D/g, ''))
    .filter((d) => d.length >= 10 && d.length <= 13);
  let digits = candidates.sort((a, b) => b.length - a.length)[0];
  if (!digits) {
    const all = String(line).replace(/\D/g, '');
    if (all.length >= 10 && all.length <= 13) digits = all;
  }
  if (!digits) return null;
  const norm = normalizePhone(digits);
  if (!norm) return null;
  const letters = String(line).replace(/[\d()+\-.,;\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const name = /[\p{L}]{2,}/u.test(letters) ? letters : null;
  return { jid: norm.jid, phone: norm.phone, name };
}

export async function importContacts(text, source = 'manual') {
  const lines = String(text ?? '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  let invalidos = 0;
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) { invalidos++; continue; }
    if (seen.has(parsed.jid)) continue; // dedup dentro do próprio lote
    seen.add(parsed.jid);
    rows.push([parsed.jid, parsed.phone, parsed.name, source]);
  }

  // INSERT em lote (chunks de 500 tuplas) — aguenta dezenas de milhares rápido.
  let adicionados = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 4;
      params.push(r[0], r[1], r[2], r[3]);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
    });
    const { rowCount } = await query(
      `INSERT INTO contacts (jid, phone, name, source) VALUES ${tuples.join(', ')}
       ON CONFLICT (jid) DO NOTHING`,
      params
    );
    adicionados += rowCount;
  }
  const duplicados = rows.length - adicionados; // já existiam no banco (in-batch dups já saíram)
  return { adicionados, duplicados, invalidos, total: lines.length };
}

export async function markOptOut(jid) {
  // registra o opt-out mesmo se o contato não estiver na lista (nunca mais enviar)
  await query(
    `INSERT INTO contacts (jid, phone, status, optout_at, source)
     VALUES ($1, $2, 'optout', now(), 'optout')
     ON CONFLICT (jid) DO UPDATE SET status = 'optout', optout_at = now()`,
    [jid, String(jid).split('@')[0]]
  );
  console.log(`[broadcast] opt-out registrado: ${jid}`);
}

export async function broadcastStats() {
  const { rows } = await query(`SELECT status, count(*)::int AS n FROM contacts GROUP BY status`);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const paused = await isBroadcastPaused();
  const configured = Boolean(getInstances().length && hasInviteLink());
  const pending = byStatus.pending ?? 0;
  const sentToday = await sentTodayCount();
  const dailyTarget = await rampTarget();
  const nextAt = await getSetting('broadcast_next_at', '');

  // motivo legível de por que NÃO está enviando agora (mesma ordem dos guards
  // do runBroadcast) — pro painel mostrar em vez de deixar o dono no escuro.
  const pad = (n) => String(n).padStart(2, '0');
  const w = config.broadcast.window;
  const winStr = `${pad(w.startH)}:${pad(w.startM)}–${pad(w.endH)}:${pad(w.endM)}`;
  let reason;
  if (paused) reason = 'pausado';
  else if (!configured) reason = 'falta configurar instância + link';
  else if (pending === 0) reason = 'fila vazia (importe contatos)';
  else if (sentToday >= dailyTarget) reason = `teto do dia atingido (${sentToday}/${dailyTarget})`;
  else if (!withinBroadcastWindow()) reason = `fora da janela (envia das ${winStr})`;
  else if (nextAt && Date.now() < new Date(nextAt).getTime()) {
    const t = new Intl.DateTimeFormat('pt-BR', { timeZone: config.tz, hour: '2-digit', minute: '2-digit' }).format(new Date(nextAt));
    reason = `próximo envio às ${t}`;
  } else reason = 'enviando';

  return {
    paused,
    configured,
    instance: getInstances()[0] || null,
    instances: getInstances(),
    pending,
    sent: byStatus.sent ?? 0,
    failed: byStatus.failed ?? 0,
    optout: byStatus.optout ?? 0,
    sending: byStatus.sending ?? 0,
    sentToday,
    dailyTarget,
    window: winStr,
    reason,
  };
}

// Resolve o jid canônico do número no WhatsApp via whatsappNumbers (corrige o
// nono dígito BR e confirma existência). Retorna o jid (ex.: 558599016208@s...)
// ou null (sem WhatsApp). Nunca lança.
async function resolveWaJid(phone) {
  for (const inst of getInstances()) {
    try {
      const json = await evoFetch(`/chat/whatsappNumbers/${inst}`, { numbers: [String(phone)] });
      const arr = Array.isArray(json) ? json : (json && Array.isArray(json.response) ? json.response : []);
      const hit = arr[0];
      if (hit && hit.exists && hit.jid) return hit.jid;
    } catch { /* neutro */ }
  }
  return null;
}

function getInstances() {
  return config.broadcast.instances?.length
    ? config.broadcast.instances
    : (config.broadcast.instance ? [config.broadcast.instance] : []);
}

// Exposto p/ o control.js (DM de boas-vindas/feedback sai por instância de disparo).
export function broadcastInstances() {
  return getInstances();
}

let instanceIdx = 0;
let running = false;

/**
 * Executor de disparo (chamado por cron a cada minuto). Envia NO MÁXIMO 1
 * convite por chamada, respeitando: kill-switch, configuração, janela,
 * espaçamento randomizado (broadcast_next_at) e teto diário (ramp). Reivindica
 * o contato atomicamente ('sending') antes de enviar. Nunca lança.
 */
export async function runBroadcast() {
  if (running) return;
  running = true;
  try {
    if (await isBroadcastPaused()) return;
    if (!getInstances().length || !hasInviteLink()) return;
    if (!withinBroadcastWindow()) return;

    const next = await getSetting('broadcast_next_at', '');
    if (next && Date.now() < new Date(next).getTime()) return;

    const target = await rampTarget();
    if ((await sentTodayCount()) >= target) return;

    const { rows } = await query(
      `UPDATE contacts SET status = 'sending'
        WHERE id = (SELECT id FROM contacts WHERE status = 'pending' ORDER BY id LIMIT 1)
          AND status = 'pending'
        RETURNING *`
    );
    const c = rows[0];
    if (!c) return; // fila vazia

    // Resolve o jid CANÔNICO (corrige nono dígito BR + confirma WhatsApp). Sem
    // isso, número do interior cadastrado sem o 9 dá exists:false e falha à toa.
    const jid = await resolveWaJid(c.phone);
    if (!jid) {
      await query(
        `UPDATE contacts SET status = 'failed', attempts = attempts + 1, last_error = 'sem whatsapp' WHERE id = $1`,
        [c.id]
      );
      // número morto: avança rápido (não gasta o espaçamento cheio, mas não martela o check)
      await setSetting('broadcast_next_at', new Date(Date.now() + randomBetween([8000, 20000])).toISOString());
      console.log(`[broadcast] ${c.phone} sem WhatsApp — pulado`);
      return;
    }

    const message = buildMessage(c);
    const instances = getInstances();
    let usedInst = null;
    for (let attempt = 0; attempt < instances.length; attempt++) {
      const inst = instances[instanceIdx % instances.length];
      instanceIdx = (instanceIdx + 1) % instances.length;
      try {
        const result = await evoFetch(`/message/sendText/${inst}`, {
          number: jid,
          text: message,
          delay: randomBetween([1500, 4000]),
          linkPreview: true,
        });
        if (result !== null) { usedInst = inst; break; }
      } catch (err) {
        console.log(`[broadcast] erro no envio via ${inst} p/ ${c.phone}: ${err.message}`);
      }
    }

    if (usedInst) {
      await query(`UPDATE contacts SET status = 'sent', sent_at = now(), attempts = attempts + 1, sent_instance = $2 WHERE id = $1`, [c.id, usedInst]);
      if (!(await getSetting('broadcast_started_at', ''))) {
        await setSetting('broadcast_started_at', new Date().toISOString());
      }
      console.log(`[broadcast] convite enviado p/ ${c.phone} (jid ${jid.split('@')[0]}) via ${usedInst}`);
      await resetBroadcastFailStreak();
    } else {
      await query(
        `UPDATE contacts SET status = 'failed', attempts = attempts + 1, last_error = 'envio falhou' WHERE id = $1`,
        [c.id]
      );
      console.log(`[broadcast] falha em todas as instâncias p/ ${c.phone}`);
      await bumpBroadcastFailStreak(`falha em todas as instâncias p/ ${c.phone}`);
    }
    // próximo envio (REAL) só depois do espaçamento randomizado cheio (anti-ban)
    await setSetting('broadcast_next_at', new Date(Date.now() + randomBetween(config.broadcast.spacingMs)).toISOString());
  } catch (err) {
    console.log(`[broadcast] erro no executor: ${err.message}`);
  } finally {
    running = false;
  }
}

/** Envio de TESTE imediato p/ um número (ignora fila/teto/pausa). Retorna {ok,error?}. */
export async function sendTestInvite(rawNumber) {
  if (!getInstances().length) return { ok: false, error: 'nenhuma instância de disparo configurada' };
  if (!hasInviteLink()) return { ok: false, error: 'link do convite não configurado' };
  const norm = normalizePhone(rawNumber);
  if (!norm) return { ok: false, error: 'número inválido' };
  const jid = await resolveWaJid(norm.phone);
  if (!jid) return { ok: false, error: 'esse número não tem WhatsApp (checado com e sem o 9)' };
  const message = buildMessage({ name: null });
  for (const inst of getInstances()) {
    const result = await evoFetch(`/message/sendText/${inst}`, {
      number: jid,
      text: message,
      delay: 1200,
      linkPreview: true,
    });
    if (result !== null) return { ok: true, preview: message };
  }
  return { ok: false, error: 'envio falhou em todas as instâncias (verifique conexão)' };
}
