// Cliente Evolution API v1.8.6 — formato v1 (wrappers textMessage/mediaMessage).
// Erros de rede NUNCA derrubam o processo: tudo capturado, logado e retorna neutro.
import { config, randomBetween } from './config.js';
import { query, getSetting, setSetting } from './db.js';
import { generateShortLink } from './shopee.js';
import { assembleMessage } from './copy.js';
import { bucketOf } from './ranking.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Alfanumérico ≤40 — sanitiza o subId de rastreio antes de mandar pra Shopee.
const subSafe = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

/**
 * Chamada base à Evolution. POST com body JSON; GET se body === undefined.
 * Retorna o JSON da resposta ou null (logando o erro).
 */
export async function evoFetch(path, body) {
  const url = `${config.evolution.url}${path}`;
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        apikey: config.evolution.apikey,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      console.log(`[poster] evoFetch ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }
    return json;
  } catch (err) {
    console.log(`[poster] evoFetch ${path} falhou: ${err.message}`);
    return null;
  }
}

/**
 * Envia texto (formato v1: wrapper textMessage).
 */
export async function sendText(jid, text, { delay } = {}) {
  return evoFetch(`/message/sendText/${config.evolution.instance}`, {
    number: jid,
    options: {
      delay: delay ?? randomBetween(config.posting.sendDelayMs),
      presence: 'composing',
      linkPreview: true,
    },
    textMessage: { text },
  });
}

/**
 * Envia imagem com legenda (formato v1: wrapper mediaMessage).
 */
export async function sendImage(jid, imageUrl, caption) {
  return evoFetch(`/message/sendMedia/${config.evolution.instance}`, {
    number: jid,
    options: {
      delay: randomBetween(config.posting.sendDelayMs),
      presence: 'composing',
    },
    mediaMessage: {
      mediatype: 'image',
      media: imageUrl,
      caption,
    },
  });
}

/**
 * Posta a oferta em todos os grupos habilitados (ordem por position),
 * com espaçamento aleatório entre grupos. Registra cada envio em posts.
 * Retorna { sent, failed }.
 */
export async function postOfferToGroups(offer, hook) {
  let groups = [];
  try {
    const { rows } = await query(
      'SELECT jid, name FROM groups WHERE enabled = true ORDER BY position'
    );
    groups = rows;
  } catch (err) {
    console.log(`[poster] erro ao buscar grupos: ${err.message}`);
    return { sent: 0, failed: 0 };
  }

  if (!groups.length) {
    console.log('[poster] nenhum grupo habilitado — nada a postar');
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let ok = false;
    let error = null;

    // SubId de rastreio por oferta+grupo (só Shopee c/ product_url). Regenera o
    // short link com subIds pra atribuir conversão no relatório de Sub ID; falha/
    // não-configurado → mantém o affiliate_url atual (com tag, sem subId).
    let trackedUrl = offer.affiliate_url;
    let subId = null;
    if (offer.marketplace === 'shopee' && offer.product_url) {
      const subIds = [
        subSafe(`o${offer.id}`),
        subSafe(bucketOf(offer.category)),
        subSafe(`g${String(group.jid).replace(/\D/g, '').slice(-8)}`),
      ];
      subId = subIds.join('_');
      try {
        const short = await generateShortLink(offer.product_url, subIds);
        if (short) trackedUrl = short;
      } catch (err) {
        console.log(`[poster] subId link falhou p/ ${group.jid}: ${err.message}`);
      }
    }
    const message = assembleMessage({ ...offer, affiliate_url: trackedUrl }, hook);

    try {
      const result = offer.image_url
        ? await sendImage(group.jid, offer.image_url, message)
        : await sendText(group.jid, message);
      ok = result !== null;
      if (!ok) error = 'envio falhou (resposta nula da Evolution)';
    } catch (err) {
      ok = false;
      error = err.message;
    }

    if (ok) {
      sent++;
      console.log(`[poster] enviado para ${group.jid} (${group.name ?? 's/nome'})`);
    } else {
      failed++;
      console.log(`[poster] falha ao enviar para ${group.jid}: ${error}`);
    }

    try {
      await query(
        'INSERT INTO posts (offer_id, group_jid, ok, error, sub_id) VALUES ($1, $2, $3, $4, $5)',
        [offer.id, group.jid, ok, error, subId]
      );
    } catch (err) {
      console.log(`[poster] erro ao registrar post de ${group.jid}: ${err.message}`);
    }

    // Espaçamento aleatório ENTRE grupos (não espera depois do último)
    if (i < groups.length - 1) {
      const spacing = randomBetween(config.posting.groupSpacingMs);
      console.log(`[poster] aguardando ${Math.round(spacing / 1000)}s antes do próximo grupo`);
      await sleep(spacing);
    }
  }

  console.log(`[poster] postagem concluída: ${sent} ok, ${failed} falha(s)`);
  return { sent, failed };
}

/**
 * Divulga o link do Canal do WhatsApp em todos os grupos habilitados (mesmo
 * espaçamento anti-ban entre grupos do postOfferToGroups). NÃO posta no canal
 * em si (a Evolution v1.8.x não tem API de canal) — só convida os membros dos
 * grupos a seguir o canal. Risco zero: grupos próprios, audiência opt-in.
 * Retorna { sent, failed, skipped? }.
 */
export async function postChannelInvite() {
  const url = String(config.channel?.url ?? '').trim();
  if (!url) return { sent: 0, failed: 0, skipped: 'sem link de canal configurado' };

  let groups = [];
  try {
    const { rows } = await query(
      'SELECT jid, name FROM groups WHERE enabled = true ORDER BY position'
    );
    groups = rows;
  } catch (err) {
    console.log(`[poster] erro ao buscar grupos (convite de canal): ${err.message}`);
    return { sent: 0, failed: 0 };
  }
  if (!groups.length) return { sent: 0, failed: 0, skipped: 'nenhum grupo habilitado' };

  const message = String(config.channel?.inviteText ?? '').replace(/\{link\}/g, url);

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    let ok = false;
    try {
      const result = await sendText(group.jid, message);
      ok = result !== null;
    } catch (err) {
      console.log(`[poster] falha no convite de canal para ${group.jid}: ${err.message}`);
    }
    if (ok) sent++;
    else failed++;

    if (i < groups.length - 1) {
      await sleep(randomBetween(config.posting.groupSpacingMs));
    }
  }
  return { sent, failed };
}

/**
 * Notifica o dono via WhatsApp (delay fixo 1200ms). No-op se ownerJid vazio.
 */
export async function notifyOwner(text) {
  if (!config.evolution.ownerJid) return null;
  return sendText(config.evolution.ownerJid, text, { delay: 1200 });
}

// Alerta o dono NO MÁXIMO 1x a cada `everyHours` por `key` (dedup via settings
// alert.<key>) — evita spam quando uma mesma falha se repete em loop. Usado pra
// avisos acionáveis (IG desligado, token vencendo, monitor do Telegram caído).
export async function notifyOwnerOnce(key, text, { everyHours = 24 } = {}) {
  if (!config.evolution.ownerJid) return null;
  const skey = `alert.${key}`;
  try {
    const last = await getSetting(skey, '');
    if (last && Date.now() - new Date(last).getTime() < everyHours * 3600 * 1000) return null;
  } catch { /* se o read falhar, tenta enviar mesmo assim */ }
  const result = await notifyOwner(text);
  // só arma a janela de dedup se o envio REALMENTE saiu (evoFetch retorna null
  // em falha) — senão o alerta crítico ficaria suprimido sem nunca ter chegado.
  if (result !== null) {
    try { await setSetting(skey, new Date().toISOString()); } catch { /* ignora */ }
  }
  return result;
}

/**
 * Lista todos os grupos da instância.
 * getParticipants=false é OBRIGATÓRIO na v1.8.6 (sem ele a chamada falha/trava).
 * Retorna array de { id, subject, size } (size = nº de participantes).
 */
export async function fetchAllGroups() {
  const json = await evoFetch(
    `/group/fetchAllGroups/${config.evolution.instance}?getParticipants=false`
  );
  if (!Array.isArray(json)) {
    if (json !== null) console.log('[poster] fetchAllGroups: resposta inesperada (não-array)');
    return [];
  }
  return json.map((g) => ({ id: g.id, subject: g.subject, size: g.size ?? null }));
}
