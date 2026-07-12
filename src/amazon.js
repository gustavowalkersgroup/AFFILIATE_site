// [amazon] Amazon Associados — link de afiliado é a URL canônica do produto
// (/dp/ASIN) com ?tag=<tag de associado>. Confirmado no Operating Agreement
// oficial: NÃO precisa de API, app key/secret nem assinatura. Só do tag.
// Sourcing automático não existe (sem API de busca barata) — ofertas entram
// pelo monitor do Telegram (auto-link) e por import manual.
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { scoreOffer } from './ranking.js';
import { parseAmazonUrl } from './links.js';

/**
 * Monta o link de afiliado: URL canônica https://<amazon>/dp/<ASIN>?tag=<tag>.
 * Preserva o domínio do produto (.com.br padrão, onde o tag axelot-20 credita).
 * Retorna null se faltar o tag, a URL não tiver ASIN (encurtador → expandUrl
 * antes) ou for inválida.
 */
export function buildAffiliateUrl(productUrl) {
  if (!config.amazon.tag) return null;
  if (!productUrl) return null;

  const parsed = parseAmazonUrl(productUrl);
  if (!parsed?.asin) return null; // short/irreconhecível: o chamador expande antes

  let host = 'www.amazon.com.br';
  try {
    const h = new URL(String(productUrl)).hostname.toLowerCase().replace(/^www\./, '');
    // endsWith exige match exato OU subdomínio real (.amazon.com) — sem o ponto,
    // "notamazon.com" também bateria em endsWith('amazon.com').
    if (h === 'amazon.com.br' || h.endsWith('.amazon.com.br')) host = 'www.amazon.com.br';
    else if (h === 'amazon.com' || h.endsWith('.amazon.com')) host = 'www.amazon.com';
  } catch {
    return null;
  }

  const u = new URL(`https://${host}/dp/${parsed.asin}`);
  u.searchParams.set('tag', config.amazon.tag);
  return u.href;
}

/**
 * Importa uma oferta manual da Amazon (mesmo contrato do meli.importManualOffer).
 * marketplace='amazon', source='manual', external_id = ASIN (ou hash da URL se
 * não extrair ASIN). Sem restrição de suplementos (Amazon permite). Re-import
 * revive p/ 'pending' exceto 'posted'/'posting' (preserva dedup e não interrompe
 * um envio em voo). Diferente do upsert automático do ranking.js, NÃO protege
 * 'rejected': reimportar aqui é ação explícita do dono, então revive de propósito.
 * Lança erro em campos faltando.
 */
export async function importManualOffer({
  title,
  affiliateUrl,
  price,
  priceFrom = null,
  imageUrl = null,
  category = 'geral',
}) {
  if (!title || !affiliateUrl || !(Number(price) > 0)) {
    throw new Error('[amazon] importManualOffer exige title, affiliateUrl e price > 0');
  }

  const cat = String(category || 'geral').trim().toLowerCase();
  const priceNum = Number(price);
  const priceFromNum = priceFrom != null && Number(priceFrom) > 0 ? Number(priceFrom) : null;

  let discountPct = 0;
  if (priceFromNum && priceFromNum > priceNum) {
    discountPct = Math.round((1 - priceNum / priceFromNum) * 100);
  }

  const parsed = parseAmazonUrl(affiliateUrl);
  const externalId =
    parsed?.asin || crypto.createHash('sha256').update(String(affiliateUrl)).digest('hex').slice(0, 16);

  const score = scoreOffer({
    marketplace: 'amazon',
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
     VALUES ('amazon', $1, $2, $3, $4, $5, 0, $6, $7, 'manual', $8, $9, 'pending')
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

  console.log(`[amazon] oferta manual importada: #${rows[0].id} "${rows[0].title}" score=${rows[0].score}`);
  return rows[0];
}
