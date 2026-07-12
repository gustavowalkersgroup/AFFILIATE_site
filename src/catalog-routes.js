// Endpoints REST do catálogo (slim, voltados ao cliente) consumidos pelo MCP do
// n8n via httpRequestTool. Auth por bearer token (config.mcp.token) — mesmo token
// do /mcp. Montado ANTES do requireAdmin global (n8n não manda x-admin-token).
// Lógica SQL em catalog.js; aqui só HTTP + mapeamento PÚBLICO (sem comissão/score).
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { qCategorias, qBuscar, qRecomendar, qDetalhe, mapPublico } from './catalog.js';
import { isLocalRequest, tooManyAuthFails, registerAuthFail } from './request-guards.js';

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

function auth(req, res, next) {
  const token = config.mcp.token;
  if (!token) {
    if (isLocalRequest(req)) return next();
    return res.status(401).json({ error: 'sem MCP_TOKEN configurado — apenas localhost', code: 401 });
  }
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (tooManyAuthFails('catalog', ip)) {
    return res.status(429).json({ error: 'muitas tentativas — aguarde alguns minutos', code: 429 });
  }
  const h = String(req.headers['authorization'] || '');
  const provided = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-catalog-token'] || '');
  if (provided && safeEqual(provided, token)) return next();
  registerAuthFail('catalog', ip);
  return res.status(401).json({ error: 'não autorizado', code: 401 });
}

const wrap = (fn) => (req, res) => {
  console.log(`[catalog] GET ${req.path} ${JSON.stringify(req.query)}`);
  return Promise.resolve(fn(req, res)).catch((err) => {
    console.log('[catalog] erro', req.path, '-', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'erro interno', code: 500 });
  });
};

export function mountCatalogRoutes(app) {
  app.get('/catalog/categorias', auth, wrap(async (_req, res) => {
    const rows = await qCategorias();
    res.json({
      total_pecas: rows.reduce((a, r) => a + r.n, 0),
      categorias: rows.map((r) => ({
        categoria: r.category,
        pecas: r.n,
        preco_min: Number(r.preco_min),
        preco_max: Number(r.preco_max),
        desconto_medio_pct: r.desconto_medio,
      })),
    });
  }));

  app.get('/catalog/buscar', auth, wrap(async (req, res) => {
    const rows = await qBuscar(req.query);
    res.json({ total: rows.length, pecas: rows.map(mapPublico) });
  }));

  app.get('/catalog/recomendar', auth, wrap(async (req, res) => {
    const rows = await qRecomendar(req.query);
    res.json({ objetivo: req.query.objetivo || '', total: rows.length, recomendacoes: rows.map(mapPublico) });
  }));

  app.get('/catalog/detalhe', auth, wrap(async (req, res) => {
    const id = Number(req.query.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido', code: 400 });
    const row = await qDetalhe(id);
    if (!row) return res.status(404).json({ error: `peça ${id} não encontrada`, code: 404 });
    res.json(mapPublico(row));
  }));

  console.log(`[catalog] rotas /catalog/* montadas (auth ${config.mcp.token ? 'por token' : 'LIBERADA (LAN)'})`);
}
