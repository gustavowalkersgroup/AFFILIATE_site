// Cliente GraphQL da Shopee Affiliate (open-api.affiliate.shopee.com.br).
// Auth: assinatura SHA256 PURA (crypto.createHash, NÃO HMAC):
//   sig = sha256_hex(appId + ts + payloadString + appSecret)
// Header exato: Authorization: SHA256 Credential={appId}, Timestamp={ts}, Signature={sig}
// `ts` em SEGUNDOS unix. `payloadString` deve ser BYTE-IDÊNTICO ao body enviado
// (serializa UMA vez com JSON.stringify e usa a mesma string na assinatura e no body).
// Erros vêm com HTTP 200 + errors[] no body (extensions.code):
//   10020 assinatura inválida · 10030 rate limit (backoff exponencial, 3 tentativas) · 10035 sem acesso

import crypto from 'node:crypto';
import { config } from './config.js';

const NODE_FIELDS =
  'itemId productName priceMin priceMax priceDiscountRate sales ratingStar imageUrl ' +
  'offerLink productLink commissionRate sellerCommissionRate shopeeCommissionRate shopName productCatIds';

const MAX_ATTEMPTS = 3;

let warnedNotConfigured = false;

function notConfigured() {
  if (config.shopee.appId) return false;
  if (!warnedNotConfigured) {
    console.log('[shopee] SHOPEE_APP_ID não configurado — cliente Shopee desligado (retornos neutros)');
    warnedNotConfigured = true;
  }
  return true;
}

// Função pura de assinatura — SHA256 simples (não HMAC). Usada também pelo smoke test.
export function buildSignature(appId, timestamp, payloadString, appSecret) {
  return crypto
    .createHash('sha256')
    .update(String(appId) + String(timestamp) + payloadString + String(appSecret))
    .digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST GraphQL com assinatura. Retorna `data` ou null (nunca lança por erro de rede).
async function graphqlRequest(query) {
  // Serializa UMA única vez: a mesma string assina e vai no body (byte-idêntico).
  const payloadString = JSON.stringify({ query });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ts = Math.floor(Date.now() / 1000); // segundos unix
    const sig = buildSignature(config.shopee.appId, ts, payloadString, config.shopee.appSecret);

    let json;
    try {
      const res = await fetch(config.shopee.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `SHA256 Credential=${config.shopee.appId}, Timestamp=${ts}, Signature=${sig}`,
        },
        body: payloadString,
        // Sem timeout, conexão travada penduraria ~300s (default do undici) o
        // teste do painel e o lock do sourcing — 30s como o resto do sistema.
        signal: AbortSignal.timeout(30_000),
      });
      json = await res.json();
    } catch (err) {
      console.log(`[shopee] erro de rede/parse: ${err.message}`);
      return null;
    }

    const errors = Array.isArray(json?.errors) ? json.errors : [];
    if (errors.length === 0) return json?.data ?? null;

    const codes = errors.map((e) => Number(e?.extensions?.code));
    const firstMsg = errors[0]?.message || 'erro desconhecido';

    if (codes.includes(10030)) {
      // Rate limit → backoff exponencial (1s, 2s, 4s), máx 3 tentativas.
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 1000 * 2 ** (attempt - 1);
        console.log(`[shopee] rate limit (10030), tentativa ${attempt}/${MAX_ATTEMPTS} — aguardando ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      console.log(`[shopee] rate limit (10030) persistiu após ${MAX_ATTEMPTS} tentativas — desistindo`);
      return null;
    }
    if (codes.includes(10020)) {
      console.log(`[shopee] assinatura inválida (10020): ${firstMsg}`);
      return null;
    }
    if (codes.includes(10035)) {
      console.log(`[shopee] sem acesso à API (10035): ${firstMsg}`);
      return null;
    }
    console.log(`[shopee] erro da API (codes=${codes.join(',')}): ${firstMsg}`);
    return null;
  }
  return null;
}

// Normaliza um node de productOfferV2 para o shape interno do sistema.
function normalizeNode(node) {
  const price = Number(node.priceMin);
  const discountPct = Number(node.priceDiscountRate || 0);
  let priceFrom = null;
  // discountPct=100 daria divisão por zero (Infinity) — Postgres numeric rejeita
  // Infinity no INSERT, e o upsert descarta a oferta inteira em silêncio.
  if (discountPct > 0 && discountPct < 100) {
    priceFrom = Math.round((price / (1 - discountPct / 100)) * 100) / 100;
  }
  return {
    externalId: String(node.itemId),
    title: node.productName,
    price,
    priceFrom,
    discountPct,
    commissionRate: Number(node.commissionRate),
    sales: Number(node.sales || 0),
    rating: node.ratingStar != null && node.ratingStar !== '' ? Number(node.ratingStar) : null,
    imageUrl: node.imageUrl || null,
    productUrl: node.productLink || null,
    affiliateUrl: node.offerLink, // offerLink já vem com a NOSSA tag de afiliado
  };
}

export async function searchOffers(keyword, { sortType = 2, limit = 50, page = 1 } = {}) {
  if (notConfigured()) return [];
  const query =
    `{ productOfferV2(keyword: ${JSON.stringify(String(keyword))}, sortType: ${Number(sortType)}, ` +
    `page: ${Number(page)}, limit: ${Number(limit)}) { nodes { ${NODE_FIELDS} } } }`;
  const data = await graphqlRequest(query);
  const nodes = data?.productOfferV2?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map(normalizeNode);
}

// Busca 1 oferta pelo itemId (e shopId, se houver). Usado pelo monitor do Telegram.
export async function offerByItemId(itemId, shopId) {
  if (notConfigured()) return null;
  const args = [`itemId: ${Number(itemId)}`];
  if (shopId != null && shopId !== '') args.push(`shopId: ${Number(shopId)}`);
  const query = `{ productOfferV2(${args.join(', ')}) { nodes { ${NODE_FIELDS} } } }`;
  const data = await graphqlRequest(query);
  const nodes = data?.productOfferV2?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  return normalizeNode(nodes[0]);
}

export async function generateShortLink(originUrl, subIds = []) {
  if (notConfigured()) return null;
  const ids = (Array.isArray(subIds) ? subIds : []).slice(0, 5).map((s) => JSON.stringify(String(s)));
  const inputParts = [`originUrl: ${JSON.stringify(String(originUrl))}`];
  if (ids.length > 0) inputParts.push(`subIds: [${ids.join(', ')}]`);
  const query = `mutation { generateShortLink(input: { ${inputParts.join(', ')} }) { shortLink } }`;
  const data = await graphqlRequest(query);
  const shortLink = data?.generateShortLink?.shortLink;
  return typeof shortLink === 'string' && shortLink ? shortLink : null;
}
