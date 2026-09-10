// src/ranking.js — pontuação (score 0–100), upsert e seleção da próxima oferta.
// Pisos e pesos vêm de config.ranking; TTL e dedup vêm de config.posting.
import { config } from './config.js';
import { query } from './db.js';

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// remove acentos e baixa caixa, para comparação robusta de termos
function fold(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Título indica produto explicitamente masculino (penaliza score em scoreOffer;
// reusado em tryon.js pra pular virtual try-on — avatar é feminino).
export function isMasculineTitle(title) {
  return /masculino|masculina|masc|bermuda masculin|short(?:s)? de futebol|chuteira|meiao de futebol|camisa de time|camisa selecao/.test(
    fold(title)
  );
}

// Categoria (keyword) → bucket de mix. Football/Copa usa as categorias
// roupas/calcados, caindo em 'vestuario'. Null/desconhecida → 'acessorios'.
const CATEGORY_BUCKET = {
  roupas: 'vestuario',
  calcados: 'vestuario',
  equipamentos: 'acessorios',
  geral: 'acessorios',
  suplementos: 'suplementos',
};

export function bucketOf(category) {
  return CATEGORY_BUCKET[category] || 'acessorios';
}

function categoriesOfBucket(bucket) {
  return Object.keys(CATEGORY_BUCKET).filter((c) => CATEGORY_BUCKET[c] === bucket);
}

// Título cai na denylist (emagrecedor/anabolizante/"palhaçada")?
export function isBlocked(title) {
  const t = fold(title);
  if (!t) return false;
  return config.content.denylist.some((term) => t.includes(term));
}

// Título casa a penaltylist (genéricos de dropship que não convertem)? Devolve o
// multiplicador de penalidade (config.ranking.penaltyMult, ex. 0.4) ou 1.0.
// Diferente da denylist: NÃO exclui, só afunda na fila. Comparação sem acento/caixa.
export function penaltyFactor(title) {
  const t = fold(title);
  if (!t) return 1;
  const list = config.content.penaltylist || [];
  return list.some((term) => t.includes(term)) ? config.ranking.penaltyMult : 1;
}

// Aceita tanto objetos normalizados (camelCase, vindos de shopee.js/telegram.js)
// quanto rows do banco (snake_case).
function normalize(o) {
  const rating = o.rating == null ? null : toNum(o.rating, null);
  const salesRaw = o.sales;
  return {
    externalId: o.externalId ?? o.external_id ?? null,
    title: o.title ?? null,
    price: toNum(o.price, 0),
    priceFrom: (o.priceFrom ?? o.price_from) == null ? null : toNum(o.priceFrom ?? o.price_from, null),
    discountPct: Math.round(toNum(o.discountPct ?? o.discount_pct, 0)),
    commissionRate: toNum(o.commissionRate ?? o.commission_rate, 0),
    sales: Math.round(toNum(salesRaw, 0)),
    salesInformed: salesRaw != null,
    rating,
    imageUrl: o.imageUrl ?? o.image_url ?? null,
    productUrl: o.productUrl ?? o.product_url ?? null,
    affiliateUrl: o.affiliateUrl ?? o.affiliate_url ?? null,
    marketplace: o.marketplace ?? null,
    source: o.source ?? 'api',
  };
}

// Score 0–100. Pisos primeiro — reprovou num piso aplicável, retorna 0:
// - commissionRate >= minCommission (só para marketplace 'shopee')
// - discountPct >= minDiscount
// - sales >= minSales (só quando sales > 0 informado)
// - rating >= minRating (só quando rating informado/> 0)
// Ofertas source='manual'/'telegram' com sales/rating nulos pulam esses pisos
// naturalmente (campo não informado → piso não aplicável).
export function scoreOffer(o) {
  const r = config.ranking;
  const n = normalize(o);

  if (n.marketplace === 'shopee' && n.commissionRate < r.minCommission) return 0;
  if (n.discountPct < r.minDiscount) return 0;
  if (n.salesInformed && n.sales > 0 && n.sales < r.minSales) return 0;
  if (n.rating != null && n.rating > 0 && n.rating < r.minRating) return 0;

  const w = r.weights;
  const rawScore = 100 * (
    w.commission * Math.min(n.commissionRate / 0.20, 1) +
    w.discount * Math.min(n.discountPct / 60, 1) +
    w.popularity * Math.min(Math.log10(n.sales + 1) / 4, 1)
  );

  // Multiplicador de gênero: público-alvo feminino.
  // Explicitamente masculino → penaliza forte. Explicitamente feminino → bônus leve.
  const titleLow = fold(o.title);
  const isMasculine = isMasculineTitle(o.title);
  const isFeminine  = /feminino|feminina|fem|mulher|her|cropped|legging|sutia|sutia/.test(titleLow);
  const genderMult  = isMasculine ? 0.25 : (isFeminine ? 1.08 : 1.0);

  // Sinal ausente/zero → penaliza (não exclui): produto sem prova social. Default
  // dos mults = 1 (desligado); pega itens sem avaliação/poucas vendas que hoje
  // escapam dos pisos (que só cortam quando o sinal é informado E > 0).
  const noSignalMult =
    ((n.rating == null || n.rating === 0) ? r.noReviewMult : 1) *
    ((!n.salesInformed || n.sales === 0) ? r.noSalesMult : 1);

  const score = rawScore * genderMult * penaltyFactor(o.title) * noSignalMult;
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100;
}

// INSERT ... ON CONFLICT (marketplace, external_id) DO UPDATE de
// price/price_from/discount/commission/sales/score. Mantém status se já
// 'posted' (dedup), 'rejected' (o "pular" do dono NÃO pode ser desfeito pelo
// sourcing, que roda a cada 3h e reencontra as mesmas ofertas) ou 'posting'
// (oferta em envio NÃO pode ser resetada no meio); senão volta a 'pending'
// (revive 'expired' quando a oferta reaparece no sourcing)
// e renova created_at (TTL conta da última vez vista).
// Retorna a row (ou null em erro — nunca derruba o processo).
export async function upsertOffer(o, { marketplace, source, sourceCopy = null, category = null }) {
  const n = normalize(o);
  // Descarta lixo (emagrecedor/anabolizante/"palhaçada") antes de gravar.
  if (isBlocked(n.title)) {
    return null;
  }
  const score = scoreOffer({ ...o, marketplace, source });
  try {
    const { rows } = await query(
      `INSERT INTO offers
         (marketplace, external_id, title, price_from, price, discount_pct, commission_rate,
          sales, rating, image_url, product_url, affiliate_url, source, source_copy, category, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (marketplace, external_id) DO UPDATE SET
         price           = EXCLUDED.price,
         price_from      = EXCLUDED.price_from,
         discount_pct    = EXCLUDED.discount_pct,
         commission_rate = EXCLUDED.commission_rate,
         sales           = EXCLUDED.sales,
         score           = EXCLUDED.score,
         status          = CASE WHEN offers.status IN ('posted', 'rejected', 'posting') THEN offers.status ELSE 'pending' END,
         created_at      = now()
       RETURNING *`,
      [
        marketplace,
        n.externalId,
        n.title,
        n.priceFrom,
        n.price,
        n.discountPct,
        n.commissionRate,
        n.sales,
        n.rating,
        n.imageUrl,
        n.productUrl,
        n.affiliateUrl,
        source,
        sourceCopy,
        category,
        score,
      ]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.log(`[ranking] erro no upsert de oferta ${marketplace}/${n.externalId}: ${err.message}`);
    return null;
  }
}

// Melhor oferta postável: pending, score >= minScore, dentro do TTL
// (offerTtlHours) e sem o mesmo external_id postado COM SUCESSO nos últimos
// dedupDays (checa posts com p.ok e offers.posted_at). Envios FALHOS (ok=false)
// não contam no dedup — senão o retry do executor (oferta volta a 'pending'
// quando todos os envios falham) viraria código morto. Ordena score DESC,
// created_at DESC. Retorna row ou null.
// Núcleo da seleção: melhor oferta postável, opcionalmente restrita a um
// conjunto de categorias (bucket). Mesmos critérios de TTL/dedup.
async function pickBest(categories = null) {
  const params = [config.ranking.minScore, config.posting.offerTtlHours, config.posting.dedupDays];
  let catFilter = '';
  if (categories && categories.length) {
    params.push(categories);
    catFilter = `AND o.category = ANY($4)`;
  }
  const { rows } = await query(
    `SELECT o.*
       FROM offers o
      WHERE o.status = 'pending'
        AND o.score >= $1
        AND o.created_at > now() - make_interval(hours => $2::int)
        ${catFilter}
        AND NOT EXISTS (
              SELECT 1
                FROM posts p
                JOIN offers op ON op.id = p.offer_id
               WHERE op.external_id = o.external_id
                 AND op.marketplace = o.marketplace
                 AND p.ok
                 AND p.posted_at > now() - make_interval(days => $3::int)
            )
        AND NOT EXISTS (
              SELECT 1
                FROM offers o2
               WHERE o2.external_id = o.external_id
                 AND o2.marketplace = o.marketplace
                 AND o2.posted_at IS NOT NULL
                 AND o2.posted_at > now() - make_interval(days => $3::int)
            )
      ORDER BY o.score DESC, o.created_at DESC
      LIMIT 1`,
    params
  );
  return rows[0] ?? null;
}

// Melhor oferta postável SEM cota de categoria (usada pelo painel/post-now).
export async function pickNextOffer() {
  try {
    return await pickBest(null);
  } catch (err) {
    console.log(`[ranking] erro ao escolher próxima oferta: ${err.message}`);
    return null;
  }
}

// Seleção COM cota de categoria (usada pelo executor). Olha a distribuição
// postada nos últimos MIX_WINDOW_DAYS, escolhe o bucket com maior déficit vs
// config.ranking.categoryMix e devolve a melhor oferta dele. Buckets vazios
// caem para o próximo de maior déficit; se todos vazios, sem filtro.
const MIX_WINDOW_DAYS = 7;

export async function pickNextOfferByMix() {
  try {
    const mix = config.ranking.categoryMix;
    const buckets = Object.keys(mix);

    const { rows } = await query(
      `SELECT category, count(*)::int AS n
         FROM offers
        WHERE status = 'posted'
          AND posted_at > now() - make_interval(days => $1::int)
        GROUP BY category`,
      [MIX_WINDOW_DAYS]
    );

    const counts = {};
    for (const b of buckets) counts[b] = 0;
    let total = 0;
    for (const r of rows) {
      const b = bucketOf(r.category);
      if (counts[b] === undefined) counts[b] = 0;
      counts[b] += r.n;
      total += r.n;
    }

    // ordena por maior déficit (alvo - fração atual); desempate: maior alvo
    const ranked = buckets.slice().sort((a, b) => {
      const da = mix[a] - (total ? counts[a] / total : 0);
      const db = mix[b] - (total ? counts[b] / total : 0);
      if (db !== da) return db - da;
      return mix[b] - mix[a];
    });

    for (const b of ranked) {
      const offer = await pickBest(categoriesOfBucket(b));
      if (offer) return offer;
    }
    // nenhum bucket com oferta elegível → tenta sem filtro (cobre category null)
    return await pickBest(null);
  } catch (err) {
    console.log(`[ranking] erro no pickNextOfferByMix: ${err.message}`);
    return await pickNextOffer();
  }
}

// Preview READ-ONLY da sequência REAL de postagem (mix 70/20/10). A aba Fila
// mostra ofertas por SCORE — suplementos dominam o topo e parece que o mix não
// funciona. Este preview simula o pickNextOfferByMix repetido limit vezes, em
// memória, SEM tocar no banco: nada é marcado posted/posting, nenhum INSERT.
// Retorna a sequência em ordem de postagem; em qualquer erro, lista vazia.
export async function previewNextOffers(limit = 12) {
  try {
    const mix = config.ranking.categoryMix;
    const buckets = Object.keys(mix);

    // 1. TODAS as ofertas elegíveis (MESMO WHERE de pickBest), score DESC,
    //    created_at DESC, sem LIMIT.
    const { rows: eligible } = await query(
      `SELECT o.id, o.title, o.category, o.marketplace, o.price, o.discount_pct,
              o.commission_rate, o.score
         FROM offers o
        WHERE o.status = 'pending'
          AND o.score >= $1
          AND o.created_at > now() - make_interval(hours => $2::int)
          AND NOT EXISTS (
                SELECT 1
                  FROM posts p
                  JOIN offers op ON op.id = p.offer_id
                 WHERE op.external_id = o.external_id
                   AND op.marketplace = o.marketplace
                   AND p.ok
                   AND p.posted_at > now() - make_interval(days => $3::int)
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM offers o2
                 WHERE o2.external_id = o.external_id
                   AND o2.marketplace = o.marketplace
                   AND o2.posted_at IS NOT NULL
                   AND o2.posted_at > now() - make_interval(days => $3::int)
              )
        ORDER BY o.score DESC, o.created_at DESC`,
      [config.ranking.minScore, config.posting.offerTtlHours, config.posting.dedupDays]
    );

    // 2. Agrupa em pools por bucket (já em ordem de score por causa do ORDER BY).
    //    Ofertas cuja category não casa com NENHUM bucket do mix (NULL ou valor
    //    fora de CATEGORY_BUCKET) vão para um pseudo-pool 'unbucketed': o executor
    //    real (pickNextOfferByMix) só as alcança pelo fallback final pickBest(null),
    //    sem filtro de categoria, depois de esgotar todos os buckets. Espelhamos
    //    isso aqui consumindo 'unbucketed' por último (passo 4). bucketOf() mapeia
    //    desconhecidos para 'acessorios', então comparamos contra os buckets do mix.
    const knownBuckets = new Set(buckets);
    const pools = {};
    for (const b of buckets) pools[b] = [];
    pools.__unbucketed = [];
    for (const o of eligible) {
      const b = bucketOf(o.category);
      const inMix = knownBuckets.has(b) && CATEGORY_BUCKET[o.category] === b;
      if (inMix) pools[b].push(o);
      else pools.__unbucketed.push(o);
    }

    // 3. Contagem já postada por bucket nos últimos 7 dias (mesma janela do mix).
    const { rows: postedRows } = await query(
      `SELECT category, count(*)::int AS n
         FROM offers
        WHERE status IN ('posted', 'posting')
          AND posted_at > now() - make_interval(days => $1::int)
        GROUP BY category`,
      [MIX_WINDOW_DAYS]
    );
    const counts = {};
    for (const b of buckets) counts[b] = 0;
    let total = 0;
    for (const r of postedRows) {
      const b = bucketOf(r.category);
      if (counts[b] === undefined) counts[b] = 0;
      counts[b] += r.n;
      total += r.n;
    }

    // 4. Repete limit vezes: ordena por maior déficit (alvo - fração atual;
    //    desempate maior alvo), escolhe o 1º bucket do mix com pool não-vazio, dá
    //    shift e incrementa count/total em memória. Se NENHUM bucket do mix tem
    //    item, cai para o pseudo-pool 'unbucketed' (espelha o fallback final
    //    pickBest(null) do executor): consome a melhor oferta sem categoria de mix
    //    SEM mexer nos contadores do mix (o executor escolhe fora do loop de
    //    buckets, então não conta na cota). Para quando todos os pools esvaziam.
    const sequence = [];
    for (let i = 0; i < limit; i++) {
      const ranked = buckets.slice().sort((a, b) => {
        const da = mix[a] - (total ? counts[a] / total : 0);
        const db = mix[b] - (total ? counts[b] / total : 0);
        if (db !== da) return db - da;
        return mix[b] - mix[a];
      });

      const chosen = ranked.find((b) => pools[b] && pools[b].length > 0);
      let o;
      let bucket;
      if (chosen) {
        o = pools[chosen].shift();
        bucket = chosen;
        counts[chosen] += 1;
        total += 1;
      } else if (pools.__unbucketed.length > 0) {
        o = pools.__unbucketed.shift();
        // rótulo p/ UI: bucketOf mapeia desconhecidos para 'acessorios'.
        bucket = bucketOf(o.category);
      } else {
        break;
      }

      sequence.push({
        position: sequence.length + 1,
        bucket,
        id: o.id,
        title: o.title,
        category: o.category,
        marketplace: o.marketplace,
        price: o.price == null ? null : Number(o.price),
        discount_pct: o.discount_pct == null ? null : Number(o.discount_pct),
        commission_rate: o.commission_rate == null ? null : Number(o.commission_rate),
        score: o.score == null ? null : Number(o.score),
      });
    }

    return sequence;
  } catch (err) {
    console.log(`[ranking] erro no previewNextOffers: ${err.message}`);
    return [];
  }
}

// Marca como 'expired' ofertas pending mais velhas que offerTtlHours.
// Retorna a contagem (0 em erro).
export async function expireOldOffers() {
  try {
    const res = await query(
      `UPDATE offers
          SET status = 'expired'
        WHERE status = 'pending'
          AND created_at < now() - make_interval(hours => $1::int)`,
      [config.posting.offerTtlHours]
    );
    if (res.rowCount > 0) console.log(`[ranking] ${res.rowCount} oferta(s) expirada(s)`);
    return res.rowCount;
  } catch (err) {
    console.log(`[ranking] erro ao expirar ofertas: ${err.message}`);
    return 0;
  }
}
