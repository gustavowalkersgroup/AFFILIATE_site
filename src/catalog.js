// Lógica de catálogo (consultas read-only sobre a pool `offers`) compartilhada
// entre o MCP em Node (src/mcp.js — uso interno do Gustavo) e os endpoints REST
// /catalog/* (src/catalog-routes.js — consumidos pelo MCP do n8n / bot NexTags).
import { config } from './config.js';
import { query } from './db.js';

// Só peças "vendáveis": com link de afiliado, preço real, não expiradas/rejeitadas.
export const BASE_WHERE = `affiliate_url IS NOT NULL AND price > 0 AND status NOT IN ('expired','rejected')`;
export const COLS =
  'id, marketplace, title, price_from, price, discount_pct, commission_rate, sales, rating, image_url, product_url, affiliate_url, category, score';

// Categoria aceita crua (roupas/calcados/equipamentos/suplementos/geral) OU
// bucket do mix (vestuario/acessorios/suplementos). Desconhecida = ignora o filtro.
const CAT_BUCKETS = {
  vestuario: ['roupas', 'calcados'],
  acessorios: ['equipamentos', 'geral'],
  suplementos: ['suplementos'],
};
const RAW_CATS = ['roupas', 'calcados', 'equipamentos', 'suplementos', 'geral'];

function categoryClause(categoria, params) {
  if (!categoria) return null;
  const c = String(categoria).trim().toLowerCase();
  let cats = null;
  if (CAT_BUCKETS[c]) cats = CAT_BUCKETS[c];
  else if (RAW_CATS.includes(c)) cats = [c];
  if (!cats) return null;
  params.push(cats);
  return `category = ANY($${params.length})`;
}

export function fmtBRL(n) {
  if (n == null) return null;
  return 'R$ ' + Number(n).toFixed(2).replace('.', ',');
}

const ORDER_MAP = {
  score: 'score DESC NULLS LAST',
  desconto: 'discount_pct DESC NULLS LAST',
  preco_asc: 'price ASC',
  preco_desc: 'price DESC',
  vendas: 'sales DESC NULLS LAST',
};

const has = (v) => v != null && v !== '';

/* --------------------------- consultas (rows crus) ------------------------ */

export async function qCategorias() {
  const { rows } = await query(
    `SELECT category,
            count(*)::int AS n,
            round(min(price)::numeric, 2) AS preco_min,
            round(max(price)::numeric, 2) AS preco_max,
            round(avg(discount_pct)::numeric, 0)::int AS desconto_medio
       FROM offers WHERE ${BASE_WHERE}
      GROUP BY category ORDER BY n DESC`
  );
  return rows;
}

export async function qBuscar(a = {}) {
  const where = [BASE_WHERE];
  const params = [];
  if (a.texto) {
    for (const t of String(a.texto).trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      params.push('%' + t + '%');
      where.push(`title ILIKE $${params.length}`);
    }
  }
  const cc = categoryClause(a.categoria, params);
  if (cc) where.push(cc);
  if (has(a.preco_min)) { params.push(Number(a.preco_min)); where.push(`price >= $${params.length}`); }
  if (has(a.preco_max)) { params.push(Number(a.preco_max)); where.push(`price <= $${params.length}`); }
  if (has(a.desconto_min)) { params.push(Number(a.desconto_min)); where.push(`discount_pct >= $${params.length}`); }
  const order = ORDER_MAP[a.ordenar] || ORDER_MAP.score;
  const limite = Math.min(Math.max(Number(a.limite) || 8, 1), 30);
  params.push(limite);
  const sql = `SELECT ${COLS} FROM offers WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function qRecomendar(a = {}) {
  const where = [BASE_WHERE];
  const params = [];
  let relevance = '0';
  const tokens = String(a.objetivo || '').trim().split(/\s+/).filter((t) => t.length >= 3).slice(0, 6);
  if (tokens.length) {
    params.push(tokens.map((t) => '%' + t + '%'));
    relevance = `(CASE WHEN title ILIKE ANY($${params.length}) THEN 1 ELSE 0 END)`;
  }
  const cc = categoryClause(a.categoria, params);
  if (cc) where.push(cc);
  if (has(a.orcamento)) { params.push(Number(a.orcamento)); where.push(`price <= $${params.length}`); }
  const limite = Math.min(Math.max(Number(a.limite) || 6, 1), 15);
  params.push(limite);
  const sql =
    `SELECT ${COLS}, ${relevance} AS _match FROM offers WHERE ${where.join(' AND ')} ` +
    `ORDER BY _match DESC, score DESC NULLS LAST LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function qDetalhe(id) {
  const { rows } = await query(`SELECT ${COLS} FROM offers WHERE id = $1 AND ${BASE_WHERE}`, [id]);
  return rows[0] || null;
}

/* ------------------------------- mapeadores ------------------------------- */

// Hosts de CDN da Shopee que servem SEMPRE JPEG real mesmo sem extensão na URL
// (cf.shopee.com.br/file/<hash>, *.susercontent.com/file/<hash>). Confirmado em
// 17/06/2026: Content-Type image/jpeg + magic bytes FFD8/JFIF independente do
// header Accept (testado com Accept: image/webp também). É a MESMA URL que o
// auto-post do Instagram já manda direto pra Graph API da Meta — que exige JPEG.
const SHOPEE_JPEG_CDN = /^https?:\/\/([a-z0-9-]+\.)*(shopee\.com\.br|susercontent\.com|shopeemobile\.com)\/file\//i;

// Decide se a imagem pode ir direto pro WhatsApp/Instagram (só JPEG/PNG entregam;
// WebP/AVIF/SVG/GIF quebram). URLs com extensão .jpg/.jpeg/.png e os hosts de CDN
// da Shopee acima são "provavel_jpeg_png". URLs .webp são proibidas. Sem extensão
// clara e fora da CDN Shopee → "validar_antes_de_enviar" (o prompt omite na dúvida).
export function imagemHint(url) {
  if (!url) return 'sem_imagem';
  const u = String(url).toLowerCase();
  if (/\.(jpe?g|png)(\?|$)/.test(u)) return 'provavel_jpeg_png';
  if (/\.webp(\?|$)/.test(u)) return 'formato_proibido_webp';
  if (SHOPEE_JPEG_CDN.test(url)) return 'provavel_jpeg_png';
  return 'validar_antes_de_enviar';
}

// Texto pronto SEM markdown (NexTags renderiza markdown literal — quirk #12).
function readyText(row) {
  const price = Number(row.price);
  const from = row.price_from != null ? Number(row.price_from) : null;
  const disc = row.discount_pct ? ` (-${row.discount_pct}%)` : '';
  const lines = [`🔥 ${row.title}`];
  if (from && from > price) lines.push(`De ${fmtBRL(from)} por ${fmtBRL(price)}${disc}`);
  else lines.push(`${fmtBRL(price)}${disc}`);
  lines.push(`👉 ${row.affiliate_url}`);
  if (config.content.disclosure) lines.push(String(config.content.disclosure).replace(/\*/g, ''));
  return lines.join('\n');
}

// PÚBLICO (NexTags/cliente): SEM comissão e SEM score (campos internos). `link` é
// o link de afiliado (sempre compartilhar). `imagem_hint` para validação.
export function mapPublico(row) {
  return {
    id: Number(row.id),
    titulo: row.title,
    categoria: row.category,
    preco: Number(row.price),
    preco_fmt: fmtBRL(row.price),
    preco_de: row.price_from != null ? Number(row.price_from) : null,
    preco_de_fmt: row.price_from != null ? fmtBRL(row.price_from) : null,
    desconto_pct: row.discount_pct ?? 0,
    vendas: row.sales ?? 0,
    avaliacao: row.rating != null ? Number(row.rating) : null,
    link: row.affiliate_url,
    imagem: row.image_url,
    imagem_hint: imagemHint(row.image_url),
    texto_pronto: readyText(row),
  };
}

// INTERNO (Node /mcp, uso do Gustavo): inclui comissão/score/marketplace.
export function mapInterno(row) {
  return {
    ...mapPublico(row),
    marketplace: row.marketplace,
    comissao_pct: row.commission_rate != null ? Math.round(Number(row.commission_rate) * 1000) / 10 : null,
    score: row.score != null ? Math.round(Number(row.score)) : null,
  };
}
