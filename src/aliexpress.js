// [aliexpress] Cliente da AliExpress Affiliate (Portals) — API OFICIAL no gateway
// novo POST https://api-sg.aliexpress.com/sync. Auth TOP com sign_method=sha256:
//   sign = HMAC-SHA256(app_secret, sorted(key+value sem separador)) -> hex UPPERCASE
// Params de sistema: app_key, method, sign_method=sha256, timestamp (epoch MS),
// v=2.0, format=json, sign. Erros vêm em { error_response: { code, msg, sub_msg } }.
// O link s.click é hash opaco do servidor — só a API gera (não dá pra montar à mão).
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { scoreOffer } from './ranking.js';
import { parseAliexpressUrl } from './links.js';

const MAX_ATTEMPTS = 3;
let warnedNotConfigured = false;

function notConfigured() {
  if (config.aliexpress.appKey && config.aliexpress.appSecret) return false;
  if (!warnedNotConfigured) {
    console.log('[aliexpress] APP_KEY/SECRET não configurados — cliente AliExpress desligado (retornos neutros)');
    warnedNotConfigured = true;
  }
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Assinatura TOP sha256 (função PURA — testável no smoke). Ignora `sign` e
 * valores vazios; ordena chaves por ASCII; concatena chave+valor sem separador;
 * HMAC-SHA256 com app_secret como chave; hex MAIÚSCULO.
 */
export function aeSign(params, appSecret) {
  const base = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] != null && params[k] !== '')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return crypto.createHmac('sha256', String(appSecret)).update(base, 'utf8').digest('hex').toUpperCase();
}

/**
 * Chamada TOP. Monta system params + business, assina, POST form-urlencoded.
 * Retorna o JSON da resposta ou null (erro de rede/TOP, com retry em throttle).
 * Nunca lança por rede — segue o padrão neutro do shopee.js.
 */
async function aeRequest(method, business = {}) {
  if (notConfigured()) return null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const params = {
      app_key: config.aliexpress.appKey,
      method,
      sign_method: 'sha256',
      timestamp: String(Date.now()), // epoch MS no gateway novo
      v: '2.0',
      format: 'json',
      ...business,
    };
    params.sign = aeSign(params, config.aliexpress.appSecret);
    const body = new URLSearchParams(params).toString();

    let json;
    try {
      const res = await fetch(config.aliexpress.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(config.aliexpress.timeoutMs),
      });
      json = await res.json();
    } catch (err) {
      console.log(`[aliexpress] erro de rede/parse: ${err.message}`);
      return null;
    }

    const err = json?.error_response;
    if (!err) return json;

    const code = String(err.code ?? '');
    const msg = err.sub_msg || err.msg || 'erro desconhecido';
    // throttle do TOP (códigos 'ServerThrottle'/7/15/...) → backoff exponencial
    const throttled = /throttle|limit|frequenc|too many|^7$|^15$/i.test(`${code} ${err.sub_code || ''} ${msg}`);
    if (throttled && attempt < MAX_ATTEMPTS) {
      const waitMs = 1000 * 2 ** (attempt - 1);
      console.log(`[aliexpress] throttle (${code}), tentativa ${attempt}/${MAX_ATTEMPTS} — aguardando ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    console.log(`[aliexpress] erro da API (code=${code}): ${msg}`);
    return null;
  }
  return null;
}

/**
 * Gera link(s) de afiliado s.click a partir de URL(s) de produto. Aceita 1 URL
 * (retorna a string) ou um array (até 50 por chamada; retorna array de links na
 * ordem). Requer trackingId configurado. promotionLinkType: 0 = normal.
 * Retorna null (ou null nas posições que falharem) se a API não devolver link.
 */
export async function generateAffiliateLink(urls, { promotionLinkType = 0 } = {}) {
  if (notConfigured()) return null;
  if (!config.aliexpress.trackingId) {
    console.log('[aliexpress] trackingId não configurado — generateAffiliateLink desligado');
    return null;
  }
  const single = !Array.isArray(urls);
  const list = (single ? [urls] : urls).map((u) => String(u)).filter(Boolean).slice(0, 50);
  if (list.length === 0) return single ? null : [];

  // Escapa vírgula LITERAL dentro de cada URL (ex.: querystring com lista
  // "a,b,c") antes de juntar pelo delimitador ',' do batch — senão a API TOP
  // vê mais valores do que os enviados e desalinha o find/shift abaixo.
  const json = await aeRequest('aliexpress.affiliate.link.generate', {
    promotion_link_type: String(promotionLinkType),
    source_values: list.map((u) => u.replace(/,/g, '%2C')).join(','),
    tracking_id: config.aliexpress.trackingId,
  });

  const result = json?.aliexpress_affiliate_link_generate_response?.resp_result?.result;
  const links = result?.promotion_links?.promotion_link;
  const arr = Array.isArray(links) ? links : links ? [links] : [];
  // Casa por source_value primeiro (marca usado via Set — nunca reusa o mesmo
  // item pra duas URLs de entrada); só cai pro fallback posicional (próximo
  // item ainda não usado, na ordem que a API devolveu) quando source_value
  // vem ausente/não-bate. arr.shift() direto (versão antiga) mutava o array
  // toda vez que UMA URL não batia, deslocando o restante e trocando o link
  // de produtos DIFERENTES entre si — bug real de atribuição.
  const used = new Set();
  const out = list.map((src) => {
    let idx = arr.findIndex((l, i) => !used.has(i) && l.source_value === src);
    if (idx === -1) idx = arr.findIndex((l, i) => !used.has(i));
    if (idx === -1) return null;
    used.add(idx);
    return arr[idx]?.promotion_link || null;
  });
  return single ? out[0] : out;
}

/**
 * Importa uma oferta manual da AliExpress (mesmo contrato dos outros módulos).
 * marketplace='aliexpress', external_id = productId (ou hash da URL). O link de
 * afiliado já deve vir pronto (gerado por generateAffiliateLink). Re-import
 * revive p/ 'pending' exceto 'posted'/'posting' (preserva dedup e não interrompe
 * um envio em voo); NÃO protege 'rejected' — reimportar é ação explícita do dono.
 * Lança em campos faltando. Sem restrição de categoria.
 */
export async function importManualOffer({
  title,
  affiliateUrl,
  price,
  priceFrom = null,
  imageUrl = null,
  category = 'geral',
  productUrl = null,
}) {
  if (!title || !affiliateUrl || !(Number(price) > 0)) {
    throw new Error('[aliexpress] importManualOffer exige title, affiliateUrl e price > 0');
  }

  const cat = String(category || 'geral').trim().toLowerCase();
  const priceNum = Number(price);
  const priceFromNum = priceFrom != null && Number(priceFrom) > 0 ? Number(priceFrom) : null;
  let discountPct = 0;
  if (priceFromNum && priceFromNum > priceNum) {
    discountPct = Math.round((1 - priceNum / priceFromNum) * 100);
  }

  const parsed = parseAliexpressUrl(productUrl || affiliateUrl);
  const externalId =
    parsed?.productId || crypto.createHash('sha256').update(String(affiliateUrl)).digest('hex').slice(0, 16);

  const score = scoreOffer({
    marketplace: 'aliexpress',
    source: 'manual',
    title,
    price: priceNum,
    priceFrom: priceFromNum,
    discountPct,
    commissionRate: 0,
    sales: null,
    rating: null,
  });

  const { rows } = await query(
    `INSERT INTO offers
       (marketplace, external_id, title, price_from, price, discount_pct,
        commission_rate, image_url, affiliate_url, source, category, score, status)
     VALUES ('aliexpress', $1, $2, $3, $4, $5, 0, $6, $7, 'manual', $8, $9, 'pending')
     ON CONFLICT (marketplace, external_id) DO UPDATE SET
       title        = EXCLUDED.title,
       price_from   = EXCLUDED.price_from,
       price        = EXCLUDED.price,
       discount_pct = EXCLUDED.discount_pct,
       image_url    = EXCLUDED.image_url,
       score        = EXCLUDED.score,
       status       = CASE WHEN offers.status IN ('posted', 'posting') THEN offers.status ELSE 'pending' END,
       created_at   = now()
     RETURNING *`,
    [externalId, String(title).trim(), priceFromNum, priceNum, discountPct, imageUrl, String(affiliateUrl), cat, score]
  );

  console.log(`[aliexpress] oferta manual importada: #${rows[0].id} "${rows[0].title}" score=${rows[0].score}`);
  return rows[0];
}

/** Testa as credenciais com uma geração real. Retorna { ok, link?, error? }. */
export async function testCredentials(sampleUrl = 'https://www.aliexpress.com/item/1005006000000000.html') {
  if (notConfigured()) return { ok: false, error: 'app_key/app_secret não configurados' };
  if (!config.aliexpress.trackingId) return { ok: false, error: 'tracking_id não configurado' };
  const link = await generateAffiliateLink(sampleUrl);
  if (link) return { ok: true, link };
  return { ok: false, error: 'a API não retornou link — confira app_key/secret, permissão Affiliate e tracking_id' };
}
