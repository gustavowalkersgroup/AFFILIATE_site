// [meli] Mercado Livre — SEM API oficial de afiliados (pesquisado: não existe;
// o search da api.mercadolibre.com retorna 403 para este caso de uso).
// Links são montados na mão (atrás da flag config.meli.autoLinks) e ofertas
// entram por import manual ou pelo monitor do Telegram.
//
// IMPORTANTE: suplementos são PROIBIDOS no programa de afiliados do Mercado Livre.
// Ofertas meli com categoria 'suplementos' são rejeitadas no import (throw).

import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { scoreOffer } from './ranking.js';

/**
 * Anexa matt_word/matt_tool a uma URL de produto do Mercado Livre, preservando
 * a query existente. Retorna null se a flag autoLinks estiver desligada, se
 * faltar mattWord/mattTool ou se a URL for inválida.
 *
 * ATENÇÃO: montar link de afiliado manualmente viola o T&C 1.8 do programa de
 * afiliados do Mercado Livre (links devem ser gerados pela ferramenta oficial).
 * A flag MELI_AUTO_LINKS existe como risco consciente assumido pelo usuário.
 */
export function buildAffiliateUrl(productUrl) {
  if (!config.meli.autoLinks) return null;
  if (!config.meli.mattWord || !config.meli.mattTool) return null;
  if (!productUrl) return null;

  try {
    const u = new URL(String(productUrl));
    u.searchParams.set('matt_word', config.meli.mattWord);
    u.searchParams.set('matt_tool', config.meli.mattTool);
    return u.href;
  } catch (err) {
    console.log(`[meli] URL inválida em buildAffiliateUrl: ${err.message}`);
    return null;
  }
}

/**
 * true se há sessão do portal de afiliados configurada (cookie + tag).
 */
export function hasAffiliateSession() {
  return Boolean(config.meli.cookie && config.meli.tag);
}

// Varre a resposta do createLink procurando um link curto do ML (/sec/ ou /social/),
// ou qualquer campo *url/*link http(s). Tolerante ao shape exato (que pode mudar).
function extractMeliLink(json) {
  if (!json) return null;
  const found = [];
  const walk = (o) => {
    if (o == null) return;
    if (typeof o === 'string') {
      if (/^https?:\/\//.test(o) && /mercadoli[bv]re\.com|\/sec\/|\/social\//i.test(o)) found.push(o);
      return;
    }
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        // MESMA validação de domínio/path do ramo string acima — sem isso, uma
        // chave qualquer tipo "originalUrl" que ecoe a URL de ENTRADA (produto,
        // sem monetização) seria aceita como se fosse o link oficial.
        if (typeof v === 'string' && /short|link|url/i.test(k) && /^https?:\/\//.test(v) && /mercadoli[bv]re\.com|\/sec\/|\/social\//i.test(v)) found.push(v);
        else walk(v);
      }
    }
  };
  walk(json);
  return found.find((u) => /\/sec\//i.test(u)) || found.find((u) => /\/social\//i.test(u)) || found[0] || null;
}

/**
 * Gera o link OFICIAL de afiliado do ML via endpoint INTERNO do portal
 * (createLink), autenticado por cookie de sessão logada + x-csrf-token.
 * ZONA CINZENTA de T&C (risco de suspensão). Retorna o link ou null (sessão
 * expirada → re-logar no painel; rede; resposta sem link). Nunca lança.
 */
export async function generateAffiliateLink(productUrl) {
  if (!productUrl || !hasAffiliateSession()) return null;
  try {
    const res = await fetch(config.meli.createLinkEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: config.meli.cookie,
        ...(config.meli.csrf ? { 'x-csrf-token': config.meli.csrf } : {}),
        Origin: 'https://www.mercadolivre.com.br',
        Referer: 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      body: JSON.stringify({ urls: [String(productUrl)], tag: String(config.meli.tag) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // 403 sem x-csrf-token é o sintoma mais comum de csrf ausente/rotacionado
      // (não necessariamente sessão morta) — diagnóstico errado mandava o dono
      // relogar quando só faltava atualizar o csrf token.
      const reason = res.status === 403 && !config.meli.csrf
        ? 'HTTP 403 sem x-csrf-token configurado — provável csrf faltando/rotacionado (Config → Mercado Livre)'
        : `HTTP ${res.status} — sessão pode ter expirado (re-logar no painel)`;
      console.log(`[meli] createLink ${reason}`);
      return null;
    }
    // Parse manual (não res.json() direto): distingue "corpo não é JSON" (sessão
    // expirada — o portal costuma responder 200 com uma página HTML de login)
    // de "JSON válido mas sem link reconhecível" — mensagens diferentes hoje
    // eram idênticas, escondendo a causa real.
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      console.log('[meli] createLink respondeu 200 mas o corpo não é JSON — sessão provavelmente expirada (re-logar no painel)');
      return null;
    }
    const link = extractMeliLink(json);
    if (!link) console.log('[meli] createLink respondeu JSON sem link reconhecível');
    return link;
  } catch (err) {
    console.log(`[meli] createLink falhou: ${err.message}`);
    return null;
  }
}

/**
 * Resolve o melhor link de afiliado disponível para uma URL de produto do ML:
 * 1) endpoint interno createLink (link oficial s.click, se houver sessão);
 * 2) fallback matt_word/matt_tool (se a flag autoLinks estiver ligada).
 * Retorna null se nenhum caminho estiver disponível.
 */
export async function resolveAffiliateUrl(productUrl) {
  const official = await generateAffiliateLink(productUrl);
  if (official) return official;
  return buildAffiliateUrl(productUrl);
}

/**
 * Importa uma oferta manual do Mercado Livre (endpoint POST /offers/manual).
 * INSERT em offers com marketplace='meli', source='manual',
 * external_id = hash curto da affiliateUrl, desconto calculado se priceFrom,
 * status 'pending' e score via ranking.scoreOffer. Retorna a row criada.
 * Re-import da mesma URL (espelha ranking.upsertOffer): revive a oferta para
 * 'pending' (exceto se 'posted' — preserva o dedup) e renova created_at, senão
 * o re-import herdaria status 'expired'/'rejected' e um TTL já vencido, e o
 * endpoint responderia ok:true sem a oferta nunca ser postada. Reviver
 * 'rejected' aqui é intencional: import manual é ação explícita do dono.
 * Lança erro (mensagem clara) para categoria 'suplementos' ou campos faltando.
 */
export async function importManualOffer({
  title,
  affiliateUrl,
  price,
  priceFrom = null,
  imageUrl = null,
  category = 'geral',
}) {
  const cat = String(category || 'geral').trim().toLowerCase();
  if (cat === 'suplementos') {
    throw new Error(
      '[meli] categoria "suplementos" é PROIBIDA no programa de afiliados do Mercado Livre — oferta rejeitada'
    );
  }
  if (!title || !affiliateUrl || !(Number(price) > 0)) {
    throw new Error('[meli] importManualOffer exige title, affiliateUrl e price > 0');
  }

  const priceNum = Number(price);
  const priceFromNum = priceFrom != null && Number(priceFrom) > 0 ? Number(priceFrom) : null;

  let discountPct = 0;
  if (priceFromNum && priceFromNum > priceNum) {
    discountPct = Math.round((1 - priceNum / priceFromNum) * 100);
  }

  const externalId = crypto.createHash('sha256').update(String(affiliateUrl)).digest('hex').slice(0, 16);

  const score = scoreOffer({
    marketplace: 'meli',
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
     VALUES ('meli', $1, $2, $3, $4, $5, 0, $6, $7, 'manual', $8, $9, 'pending')
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

  console.log(`[meli] oferta manual importada: #${rows[0].id} "${rows[0].title}" score=${rows[0].score}`);
  return rows[0];
}
