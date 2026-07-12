// src/instagram.js — auto-post das ofertas no feed do Instagram via API OFICIAL
// "Instagram API with Instagram Login" (host graph.instagram.com). Conta
// Business/Creator, SEM Página do Facebook. Fluxo de publicação de foto única:
//   1. cria media container  POST /{graphVersion}/{ig-user-id}/media (image_url, caption)
//   2. (opcional) checa status_code do container
//   3. publica               POST /{graphVersion}/{ig-user-id}/media_publish (creation_id)
//
// Token: long-lived (60 dias), renovado por cron (runInstagramTokenRefresh).
// Imagem: a Graph API BUSCA a image_url (precisa ser JPEG numa URL pública). As
// imagens da Shopee (cf.shopee.com.br/file/<hash>) já são JPEG público → vão
// direto; o proxy /img/ig/<id>.jpg é fallback (config.instagram.proxyImages).
//
// Convenção do projeto: nenhuma chamada de rede derruba o processo — tudo em
// try/catch, log com prefixo '[instagram]', funções de cron nunca propagam erro.
import crypto from 'node:crypto';
import { config } from './config.js';
import { query, getSetting, setSetting, isPaused } from './db.js';
import { saveOverrides } from './settings-store.js';
import { fmtBRL, BASE_WHERE } from './catalog.js';
import { notifyOwnerOnce } from './poster.js';

const GRAPH = 'https://graph.instagram.com';
const OAUTH_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const SCOPES = 'instagram_business_basic,instagram_business_content_publish';

const OAUTH_REDIRECT_PATH = '/api/instagram/oauth/callback';

// Resiliência: 'error' é re-tentável (falhas transitórias) até MAX_IG_ATTEMPTS;
// MAX_FAIL_STREAK falhas SEGUIDAS auto-desligam a integração (token morto /
// misconfig) p/ não drenar a fila nem estourar o rate-limit. State do OAuth é
// single-use com TTL. Proxy de imagem: só CDNs conhecidos + teto de tamanho.
const MAX_IG_ATTEMPTS = 3;
const MAX_FAIL_STREAK = 5;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const IMG_MAX_BYTES = 8 * 1024 * 1024;
const IMG_HOST_SUFFIXES = [
  'shopee.com.br', 'susercontent.com', // Shopee CDN
  'mlstatic.com',                      // Mercado Livre
  'media-amazon.com', 'ssl-images-amazon.com', // Amazon
  'alicdn.com',                        // AliExpress
];

// ---------------------------------------------------------------------------
// Helpers de rede (fetch global do Node 22 + timeout). Erro da Graph API vem
// como { error: { message, type, code } } — extraímos a message.
// ---------------------------------------------------------------------------

function igError(json, fallback) {
  if (json && json.error) {
    const e = json.error;
    return e.message || e.error_message || e.type || fallback;
  }
  return fallback;
}

// Redige segredos de um objeto/JSON p/ log (token/secret/code nunca vão pro log).
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = /token|secret|code|password/i.test(k) ? '***' : (typeof v === 'object' ? redact(v) : v);
  }
  return out;
}

async function igFetch(url, { method = 'GET', form = null, label = '' } = {}) {
  const init = { method, signal: AbortSignal.timeout(config.instagram.timeoutMs) };
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
    // DIAGNÓSTICO: loga passo + método + status + URL FINAL (revela redirect que
    // vira GET) + corpo bruto redigido — sem isso a msg da Meta vem sem contexto.
    if (label) {
      const path = (() => { try { return new URL(res.url).pathname; } catch { return res.url; } })();
      console.log(`[instagram] ${label} FALHOU: ${method} ${res.status} finalPath=${path} body=${JSON.stringify(redact(json))}`);
    }
    throw new Error(igError(json, `HTTP ${res.status}`));
  }
  return json ?? {};
}

function gv() {
  return String(config.instagram.graphVersion || 'v23.0').replace(/^\/?/, '');
}

function effToken(override) {
  return String(override ?? config.instagram.accessToken ?? '').trim();
}

// ---------------------------------------------------------------------------
// Token / conta
// ---------------------------------------------------------------------------

// GET /me?fields=user_id,username,account_type — valida o token e devolve o
// ig-user-id usado nos endpoints de publicação. Usado pelo /api/instagram/test.
export async function testToken(tokenOverride) {
  const token = effToken(tokenOverride);
  if (!token) return { ok: false, error: 'token não configurado' };
  try {
    const me = await igFetch(
      `${GRAPH}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(token)}`,
      { label: 'me' }
    );
    const igUserId = me.user_id ? String(me.user_id) : '';
    if (!igUserId) return { ok: false, error: 'resposta sem user_id — token sem permissão de publicação?' };
    return { ok: true, igUserId, username: me.username || null, accountType: me.account_type || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Troca o long-lived token por outro de +60 dias. Requer token com idade >24h e
// ainda válido (<60 dias). Retorna { access_token, expires_in }.
async function refreshToken() {
  const token = effToken();
  if (!token) throw new Error('token não configurado');
  return igFetch(
    `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
    { label: 'refresh' }
  );
}

// OAuth: monta a URL de autorização (login/consent do usuário). `state` (CSRF)
// é gerado e persistido p/ ser conferido no callback.
export async function buildAuthorizeUrl() {
  const { appId, publicBaseUrl } = config.instagram;
  if (!appId) throw new Error('configure o Instagram App ID primeiro');
  if (!publicBaseUrl) throw new Error('configure a URL pública (PUBLIC_BASE_URL) primeiro');
  const state = crypto.randomBytes(16).toString('hex');
  // guarda state + timestamp (single-use + TTL conferidos no callback)
  await setSetting('instagram_oauth_state', state + ':' + Date.now());
  const redirectUri = publicBaseUrl + OAUTH_REDIRECT_PATH;
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

// OAuth: troca o `code` por token long-lived + ig-user-id e PERSISTE tudo
// (saveOverrides → banco + config vivo). Usado pelo callback público.
async function handleOAuthCode(code, state) {
  const { appId, appSecret, publicBaseUrl } = config.instagram;
  if (!appId || !appSecret) throw new Error('App ID/Secret não configurados');
  if (!publicBaseUrl) throw new Error('PUBLIC_BASE_URL não configurada');
  // CSRF: valida ANTES de consumir. Assim um hit anônimo na rota pública com
  // state errado NÃO apaga o state pendente de um fluxo legítimo (anti-DoS); só
  // o match consome (single-use, anti-replay) e confere o TTL.
  const saved = await getSetting('instagram_oauth_state', '');
  const [expState, ts] = String(saved).split(':');
  if (!state || !expState || state !== expState) throw new Error('state inválido (refaça a conexão)');
  await setSetting('instagram_oauth_state', '');
  if (!ts || Date.now() - Number(ts) > OAUTH_STATE_TTL_MS) throw new Error('conexão expirou (refaça)');
  const redirectUri = publicBaseUrl + OAUTH_REDIRECT_PATH;

  // 1) short-lived
  const short = await igFetch(OAUTH_TOKEN_URL, {
    label: 'oauth:short-lived',
    method: 'POST',
    form: {
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    },
  });
  // o short-lived (Instagram Login) pode vir achatado {access_token,user_id} ou
  // embrulhado {data:[{access_token,...}]} — aceita os dois.
  const shortToken = short.access_token || short?.data?.[0]?.access_token;
  if (!shortToken) {
    console.log(`[instagram] oauth:short-lived sem access_token no corpo: ${JSON.stringify(redact(short))}`);
    throw new Error('não recebeu short-lived token');
  }

  // 2) long-lived (60 dias) — GET conforme doc oficial.
  const long = await igFetch(
    `${GRAPH}/access_token?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&access_token=${encodeURIComponent(shortToken)}`,
    { label: 'oauth:long-lived' }
  );
  const longToken = long.access_token;
  if (!longToken) throw new Error('não recebeu long-lived token');
  const expiresIn = Number(long.expires_in) || 60 * 24 * 3600;

  // 3) ig-user-id canônico
  const me = await testToken(longToken);
  if (!me.ok) throw new Error(`token obtido, mas /me falhou: ${me.error}`);

  await saveOverrides({ 'instagram.accessToken': longToken, 'instagram.igUserId': me.igUserId });
  await setSetting('instagram_token_expires_at', new Date(Date.now() + expiresIn * 1000).toISOString());
  await resetFailStreak();
  console.log(`[instagram] OAuth concluído: conectado como @${me.username || me.igUserId}`);
  return { igUserId: me.igUserId, username: me.username };
}

// Salva um token long-lived colado MANUALMENTE no painel: valida via /me,
// persiste token + igUserId e estima a expiração (60d) — assim o painel mostra
// a validade e o cron de refresh não tenta renovar à toa todo dia.
export async function saveTokenManual(token) {
  const me = await testToken(token);
  if (!me.ok) return me;
  await saveOverrides({ 'instagram.accessToken': token, 'instagram.igUserId': me.igUserId });
  await setSetting('instagram_token_expires_at', new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString());
  await resetFailStreak();
  return me;
}

// Desconecta: apaga o override do token/igUserId (segredo allowEmpty:false não
// dá pra zerar via saveOverrides) e desliga o auto-post. Muta o config vivo.
export async function disconnectInstagram() {
  await query(`DELETE FROM settings WHERE key IN ('cfg.instagram.accessToken','cfg.instagram.igUserId')`);
  config.instagram.accessToken = '';
  config.instagram.igUserId = '';
  await saveOverrides({ 'instagram.enabled': false }).catch(() => {});
  await setSetting('instagram_token_expires_at', '');
  await resetFailStreak();
  console.log('[instagram] desconectado (token/igUserId limpos, auto-post desligado)');
}

// Circuit breaker: falhas SEGUIDAS de publicação. Reset em qualquer sucesso.
async function bumpFailStreak(errMsg) {
  const n = Number(await getSetting('instagram_fail_streak', '0') || 0) + 1;
  await setSetting('instagram_fail_streak', String(n));
  await setSetting('instagram_last_error', String(errMsg || '').slice(0, 300));
  if (n >= MAX_FAIL_STREAK) {
    await saveOverrides({ 'instagram.enabled': false }).catch(() => {});
    await setSetting('instagram_fail_streak', '0');
    console.log(`[instagram] AUTO-DESLIGADO após ${MAX_FAIL_STREAK} falhas seguidas — verifique o token. Último erro: ${errMsg}`);
    await notifyOwnerOnce(
      'ig-autodisabled',
      `📸⚠️ Instagram: auto-post DESLIGADO após ${MAX_FAIL_STREAK} falhas seguidas (provável token expirado/revogado). Reconecte na aba Config → Instagram.\nÚltimo erro: ${String(errMsg || '').slice(0, 120)}`,
      { everyHours: 12 }
    ).catch(() => {});
  }
}

async function resetFailStreak() {
  await setSetting('instagram_fail_streak', '0');
  await setSetting('instagram_last_error', '');
}

// ---------------------------------------------------------------------------
// Caption / imagem
// ---------------------------------------------------------------------------

// Bloco de preço sem markdown (IG renderiza '*'/'~~' literalmente).
function precoBloco(offer) {
  const price = Number(offer.price);
  const from = offer.price_from != null ? Number(offer.price_from) : null;
  const disc = offer.discount_pct ? ` (-${offer.discount_pct}%)` : '';
  if (from && from > price) return `De ${fmtBRL(from)} por ${fmtBRL(price)}${disc}`;
  return `${fmtBRL(price)}${disc}`;
}

export function buildCaption(offer) {
  const tpl = config.instagram.caption || '{titulo}\n{preco_bloco}\n{link}\n{hashtags}';
  let caption = tpl
    .replace(/\{titulo\}/g, offer.title || '')
    .replace(/\{preco_bloco\}/g, precoBloco(offer))
    .replace(/\{link\}/g, offer.affiliate_url || offer.product_url || '')
    .replace(/\{hashtags\}/g, config.instagram.hashtags || '');
  // IG: caption até 2200 chars
  if (caption.length > 2200) caption = caption.slice(0, 2197) + '...';
  return caption;
}

// URL da imagem que a Graph API vai BUSCAR. Default: a própria image_url da
// Shopee (JPEG público). Com proxyImages=true e publicBaseUrl setada, usa o
// proxy /img/ig/<id>.jpg (garante Content-Type image/jpeg; útil p/ fontes WebP).
export function imageUrlFor(offer) {
  const { proxyImages, publicBaseUrl } = config.instagram;
  if (proxyImages && publicBaseUrl) return `${publicBaseUrl}/img/ig/${offer.id}.jpg`;
  return offer.image_url || '';
}

// ---------------------------------------------------------------------------
// Seleção da oferta + publicação
// ---------------------------------------------------------------------------

function effMinScore() {
  const s = Number(config.instagram.minScore);
  return s > 0 ? s : config.ranking.minScore;
}

// Próxima oferta a postar no IG: vendável (BASE_WHERE), ainda não enviada ao
// Insta (ig_status IS NULL), score mínimo e dentro do TTL. Dedup PRÓPRIO do IG —
// independente do status do WhatsApp. Retorna row ou null.
export async function pickNextOfferForIG() {
  try {
    const { rows } = await query(
      `SELECT * FROM offers
        WHERE ${BASE_WHERE}
          AND image_url IS NOT NULL
          AND score >= $1
          AND created_at > now() - make_interval(hours => $2::int)
          AND (ig_status IS NULL OR (ig_status = 'error' AND ig_attempts < $3))
        ORDER BY (ig_status IS NULL) DESC, score DESC, created_at DESC
        LIMIT 1`,
      [effMinScore(), config.posting.offerTtlHours, MAX_IG_ATTEMPTS]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.log(`[instagram] erro ao escolher oferta: ${err.message}`);
    return null;
  }
}

// Quantas ofertas já foram postadas no IG HOJE (em config.tz).
async function postedTodayCount() {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM offers
      WHERE ig_posted_at IS NOT NULL
        AND (ig_posted_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [config.tz]
  );
  return rows[0].n;
}

// Publica UMA oferta no feed do IG com reivindicação atômica (lock por ig_status).
// Retorna { ok, mediaId } | { ok:false, error } | { conflict:true }.
export async function postOfferToInstagram(offer) {
  const token = effToken();
  const igUserId = String(config.instagram.igUserId || '').trim();
  if (!token || !igUserId) return { ok: false, error: 'token/igUserId não configurados' };

  // claim: pega ofertas nunca tentadas (NULL) ou em 'error' (retry) — optimistic
  // lock. Conta a tentativa. 'posting' (em voo) e 'posted' não casam → conflict.
  const claim = await query(
    `UPDATE offers SET ig_status = 'posting', ig_attempts = ig_attempts + 1
      WHERE id = $1 AND (ig_status IS NULL OR ig_status = 'error')`,
    [offer.id]
  );
  if (claim.rowCount === 0) {
    console.log(`[instagram] oferta ${offer.id} já em voo ou já postada — nada feito`);
    return { conflict: true };
  }

  const imageUrl = imageUrlFor(offer);
  if (!imageUrl) {
    await query(`UPDATE offers SET ig_status = 'error', ig_error = $2 WHERE id = $1`, [offer.id, 'sem image_url']);
    return { ok: false, error: 'sem image_url' };
  }

  // Ponto de não-retorno: depois que chamamos media_publish o post PODE ter saído
  // no feed (a chamada não é atômica com o banco). Falha a partir daí NÃO pode
  // ser re-tentada — re-publicar duplicaria. Só falhas ANTES do publish re-tentam.
  let publishStarted = false;
  try {
    const caption = buildCaption(offer);
    // 1) container
    const container = await igFetch(`${GRAPH}/${gv()}/${igUserId}/media`, {
      method: 'POST',
      form: { image_url: imageUrl, caption, access_token: token },
    });
    const creationId = container.id;
    if (!creationId) throw new Error('container sem id');

    // 2) status (foto única costuma vir FINISHED quase imediato; tolera atraso)
    await waitContainerReady(creationId, token);

    // 3) publish
    publishStarted = true;
    const published = await igFetch(`${GRAPH}/${gv()}/${igUserId}/media_publish`, {
      method: 'POST',
      form: { creation_id: creationId, access_token: token },
    });
    const mediaId = published.id;
    if (!mediaId) throw new Error('publish sem id');

    await query(
      `UPDATE offers SET ig_status = 'posted', ig_posted_at = now(), ig_media_id = $2, ig_error = NULL WHERE id = $1`,
      [offer.id, String(mediaId)]
    );
    console.log(`[instagram] oferta ${offer.id} publicada no feed (media ${mediaId})`);
    return { ok: true, mediaId: String(mediaId) };
  } catch (err) {
    if (publishStarted) {
      // publish pode ter saído no feed — tira do retry automático (attempts no
      // teto) p/ não duplicar; fica visível p/ conferência manual.
      await query(
        `UPDATE offers SET ig_status = 'error', ig_attempts = GREATEST(ig_attempts, $3), ig_error = $2 WHERE id = $1`,
        [offer.id, ('publish incerto — confira o feed: ' + err.message).slice(0, 500), MAX_IG_ATTEMPTS]
      );
    } else {
      // falhou ANTES de publicar (container) — re-tentável dentro do teto.
      await query(`UPDATE offers SET ig_status = 'error', ig_error = $2 WHERE id = $1`, [offer.id, err.message.slice(0, 500)]);
    }
    console.log(`[instagram] erro ao publicar oferta ${offer.id} (publishStarted=${publishStarted}): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Wrapper compartilhado pelo executor e pelo post-now do painel: publica e
// mantém a contabilidade de cadência + circuit breaker num lugar só.
export async function postOfferNow(offer) {
  const r = await postOfferToInstagram(offer);
  if (r.ok) {
    await setSetting('instagram_last_post_at', new Date().toISOString());
    await resetFailStreak();
  } else if (r.error) {
    await bumpFailStreak(r.error);
  }
  return r;
}

// Aguarda o container ficar FINISHED (máx ~5 tentativas). FINISHED → ok;
// ERROR/EXPIRED → throw; IN_PROGRESS → espera e tenta de novo.
async function waitContainerReady(creationId, token, tries = 5) {
  for (let i = 0; i < tries; i++) {
    let status = 'FINISHED';
    try {
      const r = await igFetch(
        `${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`
      );
      status = r.status_code || 'FINISHED';
    } catch {
      // se a checagem de status falhar, segue pro publish (foto única raramente trava)
      return;
    }
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // não ficou pronto a tempo — tenta publicar mesmo assim (melhor que descartar)
}

// ---------------------------------------------------------------------------
// Crons (chamados pelo scheduler)
// ---------------------------------------------------------------------------

let instagramRunning = false;

// Postagem periódica: guardas na ordem habilitado → token/id → pausa → janela →
// cadência (postEveryHours) → teto/dia → escolhe e publica. Lock simples.
export async function runInstagramExecutor({ force = false } = {}) {
  if (instagramRunning) return { skipped: 'em execução' };
  instagramRunning = true;
  try {
    if (!config.instagram.enabled && !force) return { skipped: 'desligado' };
    const token = effToken();
    const igUserId = String(config.instagram.igUserId || '').trim();
    if (!token || !igUserId) return { skipped: 'sem credenciais' };

    if (!force) {
      if (await isPaused()) return { skipped: 'pausado' };
      if (!withinIgWindow()) return { skipped: 'fora da janela' };
      const everyH = Math.max(1, Number(config.instagram.postEveryHours) || 3);
      const last = await getSetting('instagram_last_post_at', '');
      if (last && Date.now() - new Date(last).getTime() < everyH * 3600 * 1000) {
        return { skipped: 'cadência ainda não venceu' };
      }
    }

    // Teto diário vale SEMPRE (inclusive sob force) — trava de segurança contra o
    // rate-limit oficial (~25/24h); force pula só janela/cadência/pausa.
    const cap = Math.max(1, Number(config.instagram.dailyCap) || 8);
    if ((await postedTodayCount()) >= cap) return { skipped: 'teto diário atingido' };

    const offer = await pickNextOfferForIG();
    if (!offer) return { skipped: 'sem oferta elegível' };

    return await postOfferNow(offer); // publica + cadência + circuit breaker
  } catch (err) {
    console.log(`[instagram] erro no executor: ${err.message}`);
    return { error: err.message };
  } finally {
    instagramRunning = false;
  }
}

// Janela de postagem do IG = mesma janela de grupos (config.posting.window).
function withinIgWindow(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.tz, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  const cur = (+p.hour % 24) * 60 + +p.minute;
  const w = config.posting.window;
  return cur >= w.startH * 60 + w.startM && cur < w.endH * 60 + w.endM;
}

// Refresh do long-lived token (~60 dias). Roda mesmo PAUSADO (deixar o token
// expirar exigiria re-login manual). Só renova quando falta pouco p/ expirar.
export async function runInstagramTokenRefresh() {
  try {
    const token = effToken();
    if (!token) return { skipped: 'sem token' };
    const exp = await getSetting('instagram_token_expires_at', '');
    // se sabemos a expiração e falta > 10 dias, ainda não renova
    if (exp) {
      const msLeft = new Date(exp).getTime() - Date.now();
      if (msLeft > 10 * 24 * 3600 * 1000) return { skipped: 'token ainda válido' };
    }
    const daysLeft = exp ? Math.floor((new Date(exp).getTime() - Date.now()) / 86_400_000) : null;
    const r = await refreshToken(); // pode falhar se token tiver <24h — só loga e tenta amanhã
    if (r && r.access_token) {
      const expiresIn = Number(r.expires_in) || 60 * 24 * 3600;
      await saveOverrides({ 'instagram.accessToken': r.access_token });
      await setSetting('instagram_token_expires_at', new Date(Date.now() + expiresIn * 1000).toISOString());
      console.log('[instagram] token renovado (+60 dias)');
      return { refreshed: true };
    }
    // renovação não veio E o token está perto de vencer → avisa o dono.
    if (daysLeft != null && daysLeft <= 7) {
      await notifyOwnerOnce(
        'ig-token-expiring',
        `📸⚠️ Instagram: o token de acesso vence em ${daysLeft} dia(s) e a renovação automática falhou. Reconecte na aba Config → Instagram antes de parar de postar.`,
        { everyHours: 24 }
      ).catch(() => {});
    }
    return { skipped: 'sem novo token' };
  } catch (err) {
    console.log(`[instagram] refresh de token falhou (tenta amanhã): ${err.message}`);
    return { error: err.message };
  }
}

// Estado da integração p/ o painel (GET /api/instagram/status).
export async function igStatus() {
  let postedToday = 0;
  let lastPost = null;
  let pending = 0;
  let errors = 0;
  try {
    postedToday = await postedTodayCount();
    // 'pendentes' usa os MESMOS critérios do pickNextOfferForIG (não só
    // ig_status IS NULL) — senão o painel mostraria fila que o executor descarta.
    const { rows } = await query(
      `SELECT max(ig_posted_at) AS last,
              count(*) FILTER (
                WHERE ig_status IS NULL AND image_url IS NOT NULL
                  AND score >= $1 AND created_at > now() - make_interval(hours => $2::int)
                  AND ${BASE_WHERE}
              )::int AS pendentes,
              count(*) FILTER (WHERE ig_status = 'error')::int AS erros
         FROM offers`,
      [effMinScore(), config.posting.offerTtlHours]
    );
    lastPost = rows[0].last ? new Date(rows[0].last).toISOString() : null;
    pending = rows[0].pendentes;
    errors = rows[0].erros;
  } catch (err) {
    console.log(`[instagram] erro no status: ${err.message}`);
  }
  const exp = await getSetting('instagram_token_expires_at', '');
  const lastError = await getSetting('instagram_last_error', '');
  return {
    enabled: config.instagram.enabled,
    configured: Boolean(effToken() && config.instagram.igUserId),
    igUserId: config.instagram.igUserId || null,
    tokenExpiresAt: exp || null,
    postedToday,
    dailyCap: config.instagram.dailyCap,
    postEveryHours: config.instagram.postEveryHours,
    lastPost,
    pending,
    errors,
    lastError: lastError || null,
  };
}

// ---------------------------------------------------------------------------
// Rotas PÚBLICAS (montadas no index.js ANTES do requireAdmin)
// ---------------------------------------------------------------------------

// Proxy de imagem: a Graph API (servidor da Meta) busca esta URL sem auth. Só
// re-serve a image_url de uma oferta EXISTENTE como image/jpeg (sem aceitar URL
// arbitrária — evita SSRF). Usado quando config.instagram.proxyImages=true.
export function mountInstagramImageRoute(app) {
  app.get('/img/ig/:offerId.jpg', (req, res) => {
    handleImage(req, res).catch((err) => {
      console.log('[instagram] erro no proxy de imagem:', err.message);
      if (!res.headersSent) res.status(502).end();
    });
  });
}

function imgHostAllowed(hostname) {
  const h = String(hostname).toLowerCase();
  return IMG_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

async function handleImage(req, res) {
  const id = Number(req.params.offerId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  const { rows } = await query('SELECT image_url FROM offers WHERE id = $1', [id]);
  const raw = rows[0]?.image_url;
  if (!raw) return res.status(404).end();
  // anti-SSRF: só CDN de imagem conhecido, https. image_url vem das APIs dos
  // marketplaces, mas a rota é PÚBLICA — não deixamos buscar host arbitrário.
  let u;
  try { u = new URL(raw); } catch { return res.status(400).end(); }
  if (u.protocol !== 'https:' || !imgHostAllowed(u.hostname)) return res.status(403).end();

  // redirect:'manual' — NÃO seguimos redirects: um CDN allowlistado que devolva
  // 30x p/ host interno burlaria o allowlist (SSRF via redirect). 3xx → 502.
  const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(config.instagram.timeoutMs) });
  if (!r.ok) return res.status(502).end(); // cobre 3xx/erro (r.ok só p/ 2xx)
  const ct = r.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) return res.status(415).end();
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > IMG_MAX_BYTES) return res.status(413).end();
  // lê com teto INCREMENTAL (não confia no content-length; aborta ao exceder) —
  // evita bufferizar gigabytes (DoS de memória) em resposta chunked sem tamanho.
  const buf = await readCapped(r.body, IMG_MAX_BYTES);
  if (!buf) return res.status(413).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.end(buf);
}

// Lê um ReadableStream acumulando bytes; retorna null se passar de `max`.
async function readCapped(stream, max) {
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

// Callback do OAuth (público — o navegador é redirecionado pra cá pela Instagram
// com ?code=&state=). Troca o code por token, persiste e volta pro painel.
export function mountInstagramOAuthRoutes(app) {
  app.get(OAUTH_REDIRECT_PATH, (req, res) => {
    finishOAuth(req, res).catch((err) => {
      console.log('[instagram] erro no OAuth callback:', err.message);
      if (!res.headersSent) res.redirect('/painel?ig=err&msg=' + encodeURIComponent(err.message));
    });
  });
}

async function finishOAuth(req, res) {
  if (req.query.error) {
    return res.redirect('/painel?ig=err&msg=' + encodeURIComponent(String(req.query.error_description || req.query.error)));
  }
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (!code) return res.redirect('/painel?ig=err&msg=' + encodeURIComponent('sem code'));
  const r = await handleOAuthCode(code, state);
  res.redirect('/painel?ig=ok&user=' + encodeURIComponent(r.username || r.igUserId));
}
