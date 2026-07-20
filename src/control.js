// Comandos do dono via webhook da Evolution (messages.upsert).
// Segurança: só aceita comando vindo do ownerJid E da nossa instância.
import { config } from './config.js';
import { query, setSetting, isPaused } from './db.js';
import { pickNextOffer } from './ranking.js';
import { notifyOwner, evoFetch } from './poster.js';
import { isOptOut, markOptOut, broadcastInstances } from './broadcast.js';

// Filtro de status pra listConversations (aba Conversas). 'status' aqui é a
// coluna já normalizada (COALESCE(c.status, 'pending')) — optin = qualquer
// coisa diferente de optout, não uma lista fixa de valores "bons".
export function conversationStatusClause(filter) {
  if (filter === 'optout') return "status = 'optout'";
  if (filter === 'optin') return "status IS DISTINCT FROM 'optout'";
  return '1=1';
}

// ── AI auto-reply p/ DMs recebidos na instância de disparo ───────────────────
const replyDedup = new Map(); // jid → timestamp da última resposta
const REPLY_COOLDOWN_MS = 6 * 3600 * 1000;

// Sem isso o Map cresce pra sempre (1 entrada por contato único que responde,
// rodando 24/7 por meses) — varre entradas vencidas a cada resposta nova.
function sweepReplyDedup() {
  const cutoff = Date.now() - REPLY_COOLDOWN_MS;
  for (const [jid, ts] of replyDedup) {
    if (ts < cutoff) replyDedup.delete(jid);
  }
}

async function recordMessage(jid, direction, text, instance) {
  await query(
    `INSERT INTO messages (jid, direction, text, instance) VALUES ($1, $2, $3, $4)`,
    [jid, direction, text, instance]
  );
}

const BOT_PATTERNS = [
  /mensagem autom[aá]tica/i,
  /atendimento autom[aá]tico/i,
  /fora do hor[aá]rio/i,
  /obrigad[ao] por entrar em contato/i,
  /hor[aá]rio de atendimento/i,
  /aguard[ae] um momento/i,
  /em breve entraremos em contato/i,
  /powered by/i,
  /desenvolvid[ao] por/i,
  /este [eé] um recado autom[aá]tico/i,
  /resposta autom[aá]tica/i,
  /bot/i,
];

function isBotMessage(text) {
  if (text.length > 700) return true;
  return BOT_PATTERNS.some(p => p.test(text));
}

async function aiReply(jid, text, logJid) {
  const last = replyDedup.get(jid);
  if (last && Date.now() - last < REPLY_COOLDOWN_MS) return;
  sweepReplyDedup();

  const apiKey = config.copy?.openai?.apiKey;
  if (!apiKey) return;

  const link = (config.broadcast?.inviteLinks && config.broadcast.inviteLinks[0])
    || config.broadcast?.inviteLink || '';
  const official = '+55 19 97603-1141';

  const system = [
    'Você é uma assistente simpática de um sistema de achadinhos fitness.',
    'Você entrou em contato porque mantemos um grupo gratuito no WhatsApp com promoções diárias de academia, roupas fitness e suplementos.',
    'Se perguntarem de onde veio o número, seja evasiva e gentil: diga que "foi indicação de um sistema de sugestões de pessoas interessadas em fitness" ou algo similar — NUNCA revele a fonte real nem diga explicitamente que não pode contar.',
    link ? `Sempre convide para o grupo: ${link}` : 'Sempre convide para o grupo de achadinhos fitness.',
    `Se a pessoa estiver irritada ou quiser falar com um humano, direcione para o número oficial ${official}, onde temos uma IA mais completa.`,
    'Responda em português casual e amigável. Seja breve: máximo 3 frases.',
  ].join(' ');

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.copy?.replyModel || config.copy?.openai?.model || 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
        max_tokens: 160,
        temperature: 0.75,
      }),
    });
    if (!res.ok) { console.log(`[ai-reply] OpenAI ${res.status}`); return; }
    const json = await res.json();
    const reply = json.choices?.[0]?.message?.content?.trim();
    if (!reply) return;

    const delay = 3000 + Math.floor(Math.random() * 4000);
    await evoFetch(`/message/sendText/${config.broadcast.instance}`, {
      number: jid,
      options: { delay, presence: 'composing', linkPreview: false },
      textMessage: { text: reply },
    });
    await recordMessage(logJid || jid, 'out', reply, config.broadcast.instance);
    replyDedup.set(jid, Date.now());
    console.log(`[ai-reply] respondido ${jid.split('@')[0]}`);
  } catch (err) {
    console.log(`[ai-reply] erro: ${err.message}`);
  }
}

const COMMANDS = {
  pausar: 'pause',
  pause: 'pause',
  retomar: 'resume',
  voltar: 'resume',
  resume: 'resume',
  status: 'status',
  pular: 'skip',
  skip: 'skip',
  ajuda: 'help',
  help: 'help',
  comandos: 'help',
};

const HELP_TEXT = [
  '🤖 Comandos disponíveis:',
  '• pausar — pausa as postagens',
  '• retomar — retoma as postagens',
  '• status — situação atual do sistema',
  '• pular — descarta a próxima oferta da fila',
  '• ajuda — esta lista',
].join('\n');

// Normaliza (minúsculas, trim, sem acentos) e mapeia para o comando canônico.
// Retorna 'pause' | 'resume' | 'status' | 'skip' | 'help' ou null.
export function parseCommand(text) {
  const norm = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  return COMMANDS[norm] ?? null;
}

// Dados do status — fonte ÚNICA usada pelo comando "status" do WhatsApp e pelo
// GET /status (index.js), garantindo as mesmas infos nos dois lugares.
// "Hoje" sempre no timezone config.tz (AT TIME ZONE), nunca no fuso do Postgres.
export async function statusData() {
  const tz = config.tz;
  const paused = await isPaused();

  const { rows: postRows } = await query(
    `SELECT count(*) FILTER (WHERE ok)::int AS ok,
            count(*) FILTER (WHERE NOT ok)::int AS fail
       FROM posts
      WHERE (posted_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  const { rows: slotRows } = await query(
    `SELECT count(*)::int AS n
       FROM slots
      WHERE status = 'pending'
        AND (scheduled_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  const { rows: offerRows } = await query(
    `SELECT count(*)::int AS n FROM offers WHERE status = 'pending' AND score >= $1`,
    [config.ranking.minScore]
  );
  const { rows: groupRows } = await query(
    `SELECT count(*)::int AS n FROM groups WHERE enabled = true`
  );

  return {
    paused,
    postsToday: { ok: postRows[0].ok, failed: postRows[0].fail },
    slotsRemainingToday: slotRows[0].n,
    pendingOffersAboveMinScore: offerRows[0].n,
    enabledGroups: groupRows[0].n,
  };
}

async function buildStatusText() {
  const s = await statusData();
  return [
    '📡 Status do sistema',
    s.paused ? '⏸️ PAUSADO' : '▶️ Ativo',
    `📬 Posts hoje: ${s.postsToday.ok} ok, ${s.postsToday.failed} falha(s)`,
    `🗓️ Slots restantes hoje: ${s.slotsRemainingToday}`,
    `🎯 Ofertas pending (score ≥ ${config.ranking.minScore}): ${s.pendingOffersAboveMinScore}`,
    `👥 Grupos ativos: ${s.enabledGroups}`,
  ].join('\n');
}

async function runCommand(cmd) {
  switch (cmd) {
    case 'pause':
      await setSetting('paused', 'true');
      await notifyOwner('⏸️ Sistema pausado');
      break;
    case 'resume':
      await setSetting('paused', 'false');
      await notifyOwner('▶️ Sistema retomado');
      break;
    case 'skip': {
      const offer = await pickNextOffer();
      if (!offer) {
        await notifyOwner('⏭️ Nenhuma oferta pendente para pular.');
        break;
      }
      await query(`UPDATE offers SET status = 'rejected' WHERE id = $1`, [offer.id]);
      await notifyOwner(`⏭️ Oferta pulada: ${offer.title}`);
      break;
    }
    case 'status':
      await notifyOwner(await buildStatusText());
      break;
    case 'help':
      await notifyOwner(HELP_TEXT);
      break;
    default:
      break;
  }
}

// Extrai o texto da mensagem (formato v1.8 da Evolution).
function messageText(msg) {
  return msg?.message?.conversation ?? msg?.message?.extendedTextMessage?.text ?? '';
}

// Processa o payload do webhook da Evolution (evento messages.upsert).
// Shape v1.8: { event, instance, data } — data pode ser objeto ou array.
// Aceita comandos SOMENTE do ownerJid e somente da nossa instância.
export async function handleWebhook(payload) {
  try {
    // normaliza tanto MESSAGES_UPSERT quanto group-participants.update → pontos
    // (cobre underscore E hífen, variando por fork da Evolution).
    const event = String(payload?.event ?? '').toLowerCase().replace(/[_-]/g, '.');
    if (event === 'group.participants.update') return handleGroupParticipants(payload);
    if (event !== 'messages.upsert') return { ok: true, ignored: 'event' };

    const instance = payload?.instance;
    const isMain = instance === config.evolution.instance;
    const isBroadcast = config.broadcast.instance && instance === config.broadcast.instance;
    if (!isMain && !isBroadcast) {
      console.log(`[control] webhook ignorado: instância "${instance}" não é nossa nem a de disparo`);
      return { ok: true, ignored: 'instance' };
    }

    const data = payload?.data;
    const msgs = Array.isArray(data) ? data : data ? [data] : [];
    let handled = 0;

    for (const msg of msgs) {
      try {
        const jid = msg?.key?.remoteJid;
        if (!jid) continue;
        if (msg?.key?.fromMe) continue;             // ignora o que nós enviamos
        if (String(jid).endsWith('@g.us')) continue; // ignora grupos
        const text = messageText(msg);
        if (!text) continue;

        // opt-out: resposta de qualquer contato (nas 2 instâncias) → descadastra.
        if (isOptOut(text)) {
          await markOptOut(jid);
          if (isBroadcast && config.broadcast.instance) {
            // confirmação opcional poderia ir aqui; por anti-ban, fica só o registro.
          }
          handled++;
          continue;
        }

        // feedback de saída (WS4): se há pergunta pendente p/ este jid, grava a
        // resposta como motivo e NÃO segue pro aiReply (não reconvida quem saiu).
        if (isBroadcast && await recordExitFeedbackReply(jid, text)) {
          console.log(`[control] feedback de saída registrado de ${String(jid).split('@')[0]}`);
          handled++;
          continue;
        }

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

        // comandos do dono: só na instância principal e só do ownerJid.
        if (isMain && config.evolution.ownerJid && jid === config.evolution.ownerJid) {
          const cmd = parseCommand(text);
          if (cmd) {
            console.log(`[control] comando do dono: ${cmd}`);
            await runCommand(cmd);
            handled++;
          }
        }
      } catch (err) {
        console.log(`[control] erro ao processar mensagem: ${err.message}`);
      }
    }

    return { ok: true, handled };
  } catch (err) {
    console.log(`[control] erro no webhook: ${err.message}`);
    return { ok: false };
  }
}

/* ── WS4: boas-vindas ao entrar / feedback ao sair (via DM, só p/ contacts) ── */

const DEFAULT_WELCOME =
  'Oi{nome}! 🎉 Que bom te ver no grupo! Aqui a gente garimpa os melhores achados fitness todo dia. Fica de olho que vem coisa boa. 💜';
const DEFAULT_EXIT =
  'Oi{nome}, vi que você saiu do grupo — sem problema! 🙏 Só pra melhorar pra você: o que te fez sair? (muita mensagem, não era o que esperava, outro motivo...) Sua resposta ajuda demais!';

function firstNameOf(name) {
  const n = String(name ?? '').trim().split(/\s+/)[0];
  return n && /^[\p{L}'-]{2,}$/u.test(n) ? n : '';
}

// jid → variantes com/sem o 9º dígito BR (mesmo problema que resolveWaJid trata).
function phoneVariants(jid) {
  const digits = String(jid).split('@')[0].replace(/\D/g, '');
  const set = new Set([digits]);
  const m = digits.match(/^55(\d{2})(\d+)$/);
  if (m) {
    const [, ddd, rest] = m;
    if (rest.length === 9 && rest[0] === '9') set.add(`55${ddd}${rest.slice(1)}`); // tira o 9
    if (rest.length === 8) set.add(`55${ddd}9${rest}`);                            // põe o 9
  }
  return [...set];
}

async function findContactByJid(jid) {
  const variants = phoneVariants(jid);
  const jids = variants.map((d) => `${d}@s.whatsapp.net`);
  const { rows } = await query(
    `SELECT id, jid, phone, name, status, sent_instance
       FROM contacts
      WHERE jid = ANY($1::text[]) OR phone = ANY($2::text[])
      ORDER BY (status = 'optout') ASC, id ASC
      LIMIT 1`,
    [jids, variants]
  );
  return rows[0] || null;
}

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

// Envia DM por uma instância de DISPARO (conversa aberta). Prefere a instância
// que originalmente falou com o contato (sent_instance). Retorna a instância ou null.
async function dmViaBroadcast(jid, text, preferInstance) {
  const insts = broadcastInstances();
  if (!insts.length) return null;
  const ordered = preferInstance && insts.includes(preferInstance)
    ? [preferInstance, ...insts.filter((i) => i !== preferInstance)]
    : insts;
  for (const inst of ordered) {
    const r = await evoFetch(`/message/sendText/${inst}`, {
      number: jid,
      options: { delay: 2500 + Math.floor(Math.random() * 3000), presence: 'composing', linkPreview: false },
      textMessage: { text },
    });
    if (r !== null) return inst;
  }
  return null;
}

// Boas-vindas: só 1x por contato (welcomed_at). LGPD: só quem já está em contacts.
async function welcomeContact(contact) {
  const { rowCount } = await query(
    `UPDATE contacts SET welcomed_at = now() WHERE id = $1 AND welcomed_at IS NULL`,
    [contact.id]
  );
  if (!rowCount) return; // já foi saudado
  const fn = firstNameOf(contact.name);
  const text = (config.broadcast.welcomeText || DEFAULT_WELCOME).replace(/\{nome\}/g, fn ? ` ${fn}` : '');
  await dmViaBroadcast(contact.jid, text, contact.sent_instance);
  console.log(`[control] boas-vindas p/ ${contact.jid.split('@')[0]}`);
}

// Pergunta o motivo da saída e registra a linha. A resposta é capturada depois
// em recordExitFeedbackReply. Não pergunta a quem foi EXPULSO por admin.
async function askExitReason(contact, groupJid, author, pjid) {
  if (author && author !== pjid) return; // expulso por admin → não incomoda
  const fn = firstNameOf(contact.name);
  const text = (config.broadcast.exitFeedbackText || DEFAULT_EXIT).replace(/\{nome\}/g, fn ? ` ${fn}` : '');
  const inst = await dmViaBroadcast(contact.jid, text, contact.sent_instance);
  await query(
    `INSERT INTO group_exit_feedback (contact_jid, phone, name, group_jid, question_sent, question_at, instance)
     VALUES ($1, $2, $3, $4, $5, now(), $6)`,
    [contact.jid, contact.phone, contact.name, groupJid, inst !== null, inst]
  );
  console.log(`[control] feedback de saída perguntado p/ ${contact.jid.split('@')[0]}`);
}

// Casa uma DM recebida com uma pergunta de feedback pendente (< 48h). Grava a
// resposta e retorna true (aí o handler NÃO chama o aiReply).
async function recordExitFeedbackReply(jid, text) {
  const jids = phoneVariants(jid).map((d) => `${d}@s.whatsapp.net`);
  if (!jids.includes(jid)) jids.push(jid);
  const { rows } = await query(
    `UPDATE group_exit_feedback
        SET reason_text = $2, answered_at = now()
      WHERE id = (
        SELECT id FROM group_exit_feedback
         WHERE contact_jid = ANY($1::text[])
           AND answered_at IS NULL
           AND question_at > now() - interval '48 hours'
         ORDER BY question_at DESC LIMIT 1)
      RETURNING id`,
    [jids, text]
  );
  return rows.length > 0;
}

// Roteia GROUP_PARTICIPANTS_UPDATE: entrou → boas-vindas; saiu → feedback.
// LGPD: só age sobre quem já está em contacts (conversa aberta) e nunca optout.
// Kill-switch config.broadcast.groupDmEnabled (default OFF).
async function handleGroupParticipants(payload) {
  try {
    if (payload?.instance !== config.evolution.instance) return { ok: true, ignored: 'instance' };
    const d = payload?.data || {};
    const groupJid = d.id ?? d.groupJid ?? d.remoteJid;
    const action = d.action;
    const author = d.author ?? d.participant ?? '';
    const participants = Array.isArray(d.participants) ? d.participants : [];
    // Log ANTES do kill-switch: confirma o plumbing/shape do evento mesmo com as
    // DMs desligadas (o shape do payload varia por fork da Evolution).
    console.log(`[control] group-participants: action=${action} group=${String(groupJid).split('@')[0]} n=${participants.length} raw=${JSON.stringify(d).slice(0, 300)}`);
    if (!config.broadcast.groupDmEnabled) return { ok: true, ignored: 'groupDm desligado' };
    if (!groupJid || (action !== 'add' && action !== 'remove') || !participants.length) {
      return { ok: true, ignored: 'shape' };
    }
    // só grupos NOSSOS
    const { rows: gr } = await query(`SELECT 1 FROM groups WHERE jid = $1`, [groupJid]);
    if (!gr.length) return { ok: true, ignored: 'group' };

    for (const pjid of participants) {
      try {
        const contact = await findContactByJid(pjid);
        if (!contact || contact.status === 'optout') continue; // só contatos, nunca opt-out
        if (action === 'add') await welcomeContact(contact);
        else await askExitReason(contact, groupJid, author, pjid);
      } catch (err) {
        console.log(`[control] participante ${pjid}: ${err.message}`);
      }
    }
    return { ok: true };
  } catch (err) {
    console.log(`[control] erro group-participants: ${err.message}`);
    return { ok: false };
  }
}
