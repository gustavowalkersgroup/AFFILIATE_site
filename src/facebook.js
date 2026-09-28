// src/facebook.js — auto-post das ofertas no feed do Facebook via Graph API
// Publicação de foto única em Página:
//   POST /{graphVersion}/{pageId}/photos (url, caption, access_token)
//
// Token: Page Access Token (long-lived).
// Imagem: a Graph API busca a image_url. Shopee fornece JPEG público.
//
// Convenção: try/catch em tudo, log prefixado '[facebook]', crons não propagam erro.
import { config } from './config.js';
import { query, getSetting, setSetting, isPaused } from './db.js';
import { fmtBRL, BASE_WHERE } from './catalog.js';
import { notifyOwnerOnce } from './poster.js';

const GRAPH = 'https://graph.facebook.com';

// Resiliência: 'error' re-tentável até MAX_FB_ATTEMPTS;
// MAX_FAIL_STREAK falhas SEGUIDAS auto-desliga a integração.
const MAX_FB_ATTEMPTS = 3;
const MAX_FAIL_STREAK = 5;

// ---------------------------------------------------------------------------
// Helpers de rede
// ---------------------------------------------------------------------------

function fbError(json, fallback) {
  if (json && json.error) {
    const e = json.error;
    return e.message || e.error_message || e.type || fallback;
  }
  return fallback;
}

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = /token|secret|code|password/i.test(k) ? '***' : (typeof v === 'object' ? redact(v) : v);
  }
  return out;
}

async function fbFetch(url, { method = 'GET', form = null, label = '' } = {}) {
  const init = { method, signal: AbortSignal.timeout(config.facebook.timeoutMs) };
  if (form) {
    init.body = new URLSearchParams(form);
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }
  const res = await fetch(url, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (label) {
      const path = (() => { try { return new URL(res.url).pathname; } catch { return res.url; } })();
      console.log(`[facebook] ${label} FALHOU: ${method} ${res.status} finalPath=${path} body=${JSON.stringify(redact(json))}`);
    }
    throw new Error(fbError(json, `HTTP ${res.status}`));
  }
  return json ?? {};
}

function gv() {
  return String(config.facebook.graphVersion || 'v23.0').replace(/^\/?/, '');
}

function effToken() {
  return String(config.facebook.accessToken ?? '').trim();
}

// ---------------------------------------------------------------------------
// Caption / Imagem
// ---------------------------------------------------------------------------

function precoBloco(offer) {
  const price = Number(offer.price);
  const from = offer.price_from != null ? Number(offer.price_from) : null;
  const disc = offer.discount_pct ? ` (-${offer.discount_pct}%)` : '';
  if (from && from > price) return `De ${fmtBRL(from)} por ${fmtBRL(price)}${disc}`;
  return `${fmtBRL(price)}${disc}`;
}

export function buildCaption(offer) {
  const tpl = config.facebook.caption || '{titulo}\n{preco_bloco}\n{link}\n{hashtags}';
  let caption = tpl
    .replace(/\{titulo\}/g, offer.title || '')
    .replace(/\{preco_bloco\}/g, precoBloco(offer))
    .replace(/\{link\}/g, offer.affiliate_url || offer.product_url || '')
    .replace(/\{hashtags\}/g, config.facebook.hashtags || '');

  if (caption.length > 5000) caption = caption.slice(0, 4997) + '...';
  return caption;
}

// ---------------------------------------------------------------------------
// Seleção + Publicação
// ---------------------------------------------------------------------------

function effMinScore() {
  const s = Number(config.facebook.minScore);
  return s > 0 ? s : config.ranking.minScore;
}

export async function pickNextOfferForFB() {
  try {
    const { rows } = await query(
      `SELECT * FROM offers
        WHERE ${BASE_WHERE}
          AND image_url IS NOT NULL
          AND score >= $1
          AND created_at > now() - make_interval(hours => $2::int)
          AND (fb_status IS NULL OR (fb_status = 'error' AND fb_attempts < $3))
        ORDER BY (fb_status IS NULL) DESC, score DESC, created_at DESC
        LIMIT 1`,
      [effMinScore(), config.posting.offerTtlHours, MAX_FB_ATTEMPTS]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.log(`[facebook] erro ao escolher oferta: ${err.message}`);
    return null;
  }
}

async function postedTodayCount() {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM offers
      WHERE fb_posted_at IS NOT NULL
        AND (fb_posted_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [config.tz]
  );
  return rows[0].n;
}

export async function postOfferToFacebook(offer) {
  const token = effToken();
  const pageId = String(config.facebook.pageId || '').trim();
  if (!token || !pageId) return { ok: false, error: 'token/pageId não configurados' };

  const claim = await query(
    `UPDATE offers SET fb_status = 'posting', fb_attempts = fb_attempts + 1
      WHERE id = $1 AND (fb_status IS NULL OR fb_status = 'error')`,
    [offer.id]
  );
  if (claim.rowCount === 0) {
    console.log(`[facebook] oferta ${offer.id} já em voo ou já postada — nada feito`);
    return { conflict: true };
  }

  const imageUrl = offer.image_url;
  if (!imageUrl) {
    await query(`UPDATE offers SET fb_status = 'error', fb_error = $2 WHERE id = $1`, [offer.id, 'sem image_url']);
    return { ok: false, error: 'sem image_url' };
  }

  try {
    const caption = buildCaption(offer);

    if (config.facebook.dryRun) {
      console.log(`[facebook] DRY-RUN: postando oferta ${offer.id} p/ página ${pageId} com legenda: ${caption}`);
      await query(`UPDATE offers SET fb_status = 'posted', fb_posted_at = now() WHERE id = $1`, [offer.id]);
      return { ok: true, postId: 'dry-run-id' };
    }

    const published = await fbFetch(`${GRAPH}/${gv()}/${pageId}/photos`, {
      method: 'POST',
      form: { url: imageUrl, caption, access_token: token },
      label: 'publish'
    });

    const postId = published.id;
    if (!postId) throw new Error('publish sem id');

    await query(
      `UPDATE offers SET fb_status = 'posted', fb_posted_at = now(), fb_post_id = $2, fb_error = NULL WHERE id = $1`,
      [offer.id, String(postId)]
    );
    console.log(`[facebook] oferta ${offer.id} publicada na página (id ${postId})`);
    return { ok: true, postId: String(postId) };
  } catch (err) {
    await query(`UPDATE offers SET fb_status = 'error', fb_error = $2 WHERE id = $1`, [offer.id, err.message.slice(0, 500)]);
    console.log(`[facebook] erro ao publicar oferta ${offer.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function postOfferNow(offer) {
  const r = await postOfferToFacebook(offer);
  if (r.ok) {
    await setSetting('facebook_last_post_at', new Date().toISOString());
    await resetFailStreak();
  } else if (r.error) {
    await bumpFailStreak(r.error);
  }
  return r;
}

async function bumpFailStreak(errMsg) {
  const n = Number(await getSetting('facebook_fail_streak', '0') || 0) + 1;
  await setSetting('facebook_fail_streak', String(n));
  await setSetting('facebook_last_error', String(errMsg || '').slice(0, 300));
  if (n >= MAX_FAIL_STREAK) {
    // No Facebook, apenas logamos e avisamos, não desligamos via saveOverrides (que é p/ IG)
    // a menos que implementemos fb.enabled no config.
    console.log(`[facebook] AUTO-PAUSADO após ${MAX_FAIL_STREAK} falhas seguidas. Último erro: ${errMsg}`);
    await notifyOwnerOnce(
      'fb-autopaused',
      `📘⚠️ Facebook: auto-post PAUSADO após ${MAX_FAIL_STREAK} falhas seguidas. Confira o token da página.\nÚltimo erro: ${String(errMsg || '').slice(0, 120)}`,
      { everyHours: 12 }
    ).catch(() => {});
  }
}

async function resetFailStreak() {
  await setSetting('facebook_fail_streak', '0');
  await setSetting('facebook_last_error', '');
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

let facebookRunning = false;

export async function runFacebookExecutor({ force = false } = {}) {
  if (facebookRunning) return { skipped: 'em execução' };
  facebookRunning = true;
  try {
    if (!config.facebook.enabled && !force) return { skipped: 'desligado' };
    const token = effToken();
    const pageId = String(config.facebook.pageId || '').trim();
    if (!token || !pageId) return { skipped: 'sem credenciais' };

    if (!force) {
      if (await isPaused()) return { skipped: 'pausado' };
      if (!withinFbWindow()) return { skipped: 'fora da janela' };
      const everyH = Math.max(1, Number(config.facebook.postEveryHours) || 3);
      const last = await getSetting('facebook_last_post_at', '');
      if (last && Date.now() - new Date(last).getTime() < everyH * 3600 * 1000) {
        return { skipped: 'cadência ainda não venceu' };
      }
    }

    const cap = Math.max(1, Number(config.facebook.dailyCap) || 8);
    if ((await postedTodayCount()) >= cap) return { skipped: 'teto diário atingido' };

    const offer = await pickNextOfferForFB();
    if (!offer) return { skipped: 'sem oferta elegível' };

    return await postOfferNow(offer);
  } catch (err) {
    console.log(`[facebook] erro no executor: ${err.message}`);
    return { error: err.message };
  } finally {
    facebookRunning = false;
  }
}

function withinFbWindow() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.tz, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date())) p[type] = value;
  const cur = (+p.hour % 24) * 60 + +p.minute;
  const w = config.posting.window;
  return cur >= w.startH * 60 + w.startM && cur < w.endH * 60 + w.endM;
}

export async function fbStatus() {
  let postedToday = 0;
  let lastPost = null;
  let pending = 0;
  let errors = 0;
  try {
    postedToday = await postedTodayCount();
    const { rows } = await query(
      `SELECT max(fb_posted_at) AS last,
              count(*) FILTER (
                WHERE fb_status IS NULL AND image_url IS NOT NULL
                  AND score >= $1 AND created_at > now() - make_interval(hours => $2::int)
                  AND ${BASE_WHERE}
              )::int AS pendentes,
              count(*) FILTER (WHERE fb_status = 'error')::int AS erros
         FROM offers`,
      [effMinScore(), config.posting.offerTtlHours]
    );
    lastPost = rows[0].last ? new Date(rows[0].last).toISOString() : null;
    pending = rows[0].pendentes;
    errors = rows[0].erros;
  } catch (err) {
    console.log(`[facebook] erro no status: ${err.message}`);
  }
  const lastError = await getSetting('facebook_last_error', '');
  return {
    enabled: config.facebook.enabled,
    configured: Boolean(effToken() && config.facebook.pageId),
    postedToday,
    dailyCap: config.facebook.dailyCap,
    postEveryHours: config.facebook.postEveryHours,
    lastPost,
    pending,
    errors,
    lastError: lastError || null,
  };
}
