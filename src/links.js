// [links] Utilitários PUROS de URL — sem DB, sem estado.
// Usados por telegram.js (extração/expansão de links) e meli.js/shopee.js (parse de ids).

import dns from 'node:dns/promises';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 10_000;

const PRIVATE_IPV4_RE = [
  /^127\./, /^10\./, /^169\.254\./, /^192\.168\./, /^0\.0\.0\.0$/,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
  }
  return PRIVATE_IPV4_RE.some((re) => re.test(ip));
}

// Guarda anti-SSRF: só http(s), e resolve o host via DNS pra bloquear IP
// privado/loopback/link-local (ex.: metadado de nuvem 169.254.169.254, rede
// interna) ANTES de seguir o hop. Sem isso, um encurtador (ou um intermediário
// com open-redirect) numa mensagem de canal PÚBLICO do Telegram podia mandar
// este servidor buscar qualquer endereço interno.
async function isSafeRedirectTarget(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return !isPrivateIp(hostname);
  try {
    const { address } = await dns.lookup(hostname);
    return !isPrivateIp(address);
  } catch {
    return false; // não resolveu → não arrisca
  }
}

/**
 * Segue redirects manualmente (máx 5 hops, timeout 10s por hop) e retorna a URL final.
 * Necessário p/ encurtadores: shope.ee, amzn.to, mercadolivre.com/sec.
 * Erro de rede NUNCA derruba o processo: loga e retorna a última URL conhecida.
 */
export async function expandUrl(url) {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!(await isSafeRedirectTarget(current))) {
      console.log(`[links] bloqueado (destino privado/loopback/esquema inválido): ${current}`);
      return url; // devolve a URL ORIGINAL — nunca chega a buscar o destino suspeito
    }
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      });
    } catch (err) {
      console.log(`[links] erro ao expandir ${current}: ${err.message}`);
      return current;
    }
    // não precisamos do body; cancela o stream pra liberar a conexão
    try { res.body?.cancel(); } catch { /* ignore */ }

    if (!REDIRECT_STATUSES.has(res.status)) return current;

    const location = res.headers.get('location');
    if (!location) return current;

    try {
      current = new URL(location, current).href;
    } catch {
      console.log(`[links] location inválido em ${current}: ${location}`);
      return current;
    }
  }
  return current;
}

/**
 * Extrai { shopId, itemId } de URLs Shopee nos formatos:
 *  - shopee.com.br/<slug>-i.<shopId>.<itemId>
 *  - shopee.com.br/product/<shopId>/<itemId>
 *  - querystring (?shopId=...&itemId=... ou variações shopid/itemid)
 * Retorna null se não casar.
 */
export function parseShopeeUrl(url) {
  if (!url) return null;
  const s = String(url);

  // formato slug: ...-i.<shopId>.<itemId>
  let m = s.match(/-i\.(\d+)\.(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };

  // formato /product/<shopId>/<itemId>
  m = s.match(/\/product\/(\d+)\/(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };

  // querystring
  try {
    const u = new URL(s);
    const itemId =
      u.searchParams.get('itemId') || u.searchParams.get('itemid') || u.searchParams.get('item_id');
    const shopId =
      u.searchParams.get('shopId') || u.searchParams.get('shopid') || u.searchParams.get('shop_id');
    if (itemId) return { shopId: shopId || null, itemId };
  } catch {
    // URL inválida → não casa
  }

  return null;
}

/**
 * Extrai o id MLB de URLs do Mercado Livre (produto/anúncio): MLB-1234567 ou MLB1234567.
 * Retorna { mlbId } (normalizado sem hífen), { short: true } para links curtos
 * mercadolivre.com/sec/... (sem id na URL), ou null.
 */
export function parseMeliUrl(url) {
  if (!url) return null;
  const s = String(url);

  const m = s.match(/MLB-?(\d+)/i);
  if (m) return { mlbId: `MLB${m[1]}` };

  // link curto /sec/ — não carrega o id; precisa de expandUrl antes
  if (/mercadoli[bv]re\.com(\.br)?\/sec\//i.test(s)) return { short: true };

  return null;
}

/** true para URLs Shopee, incluindo o encurtador shope.ee. */
export function isShopeeUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return (
      host === 'shope.ee' ||
      host === 'shopee.com.br' ||
      host.endsWith('.shopee.com.br') ||
      host === 'shopee.com' ||
      host.endsWith('.shopee.com')
    );
  } catch {
    return false;
  }
}

/** true para URLs Mercado Livre, incluindo o encurtador mercadolivre.com/sec. */
export function isMeliUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return (
      host === 'mercadolivre.com.br' ||
      host.endsWith('.mercadolivre.com.br') ||
      host === 'mercadolivre.com' ||
      host.endsWith('.mercadolivre.com') ||
      host === 'mercadolibre.com' ||
      host.endsWith('.mercadolibre.com')
    );
  } catch {
    return false;
  }
}

/**
 * Extrai o ASIN (10 chars alfanuméricos) de URLs Amazon:
 *  - amazon.com.br/dp/ASIN · /gp/product/ASIN · /<slug>/dp/ASIN · /gp/aw/d/ASIN
 *  - ?asin=ASIN
 * Retorna { asin } (uppercase), { short: true } para encurtador amzn.to/a.co
 * (sem ASIN na URL; precisa de expandUrl antes), ou null.
 */
export function parseAmazonUrl(url) {
  if (!url) return null;
  const s = String(url);

  const m = s.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
  if (m) return { asin: m[1].toUpperCase() };

  try {
    const u = new URL(s);
    const asin = u.searchParams.get('asin') || u.searchParams.get('ASIN');
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return { asin: asin.toUpperCase() };
  } catch {
    // segue
  }

  if (/(?:amzn\.to|amzn\.com|a\.co)\//i.test(s)) return { short: true };
  return null;
}

/**
 * Extrai o productId (numérico) de URLs AliExpress: .../item/<digits>.html
 * Retorna { productId }, { short: true } para encurtadores (s.click/a.aliexpress
 * — já são links de afiliado de outra conta; precisam de expandUrl antes), ou null.
 */
export function parseAliexpressUrl(url) {
  if (!url) return null;
  const s = String(url);

  const m = s.match(/\/item\/(?:_m\/)?(\d{6,})\.html/i) || s.match(/\/item\/(\d{6,})/i);
  if (m) return { productId: m[1] };

  if (/(?:s\.click\.aliexpress\.com|a\.aliexpress\.com)\//i.test(s)) return { short: true };
  return null;
}

/** true para URLs Amazon, incluindo encurtadores amzn.to / a.co. */
export function isAmazonUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return (
      host === 'amzn.to' ||
      host === 'a.co' ||
      host === 'amzn.com' ||
      host === 'amazon.com.br' ||
      host.endsWith('.amazon.com.br') ||
      host === 'amazon.com' ||
      host.endsWith('.amazon.com')
    );
  } catch {
    return false;
  }
}

/** true para URLs AliExpress, incluindo encurtadores s.click / a.aliexpress. */
export function isAliexpressUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'aliexpress.com' || host.endsWith('.aliexpress.com') || host.endsWith('.aliexpress.us');
  } catch {
    return false;
  }
}

/** Todas as URLs http(s) de um texto. Retorna [] se nada encontrado. */
export function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/https?:\/\/[^\s<>"']+/g) || [];
  // tira pontuação comum colada no fim do link em texto corrido
  return matches.map((u) => u.replace(/[)\].,;:!?'"»]+$/, '')).filter(Boolean);
}
