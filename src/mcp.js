// Servidor MCP (Model Context Protocol) sobre a pool de ofertas — read-only.
// Monta a rota POST /mcp no Express existente (Streamable HTTP, STATELESS:
// um server+transport por request). Auth por bearer token (config.mcp.token).
// Uso interno do Gustavo (devolve comissão/score). O catálogo público pro bot
// NexTags fica em /catalog/* (src/catalog-routes.js). Lógica SQL em catalog.js.
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { qCategorias, qBuscar, qRecomendar, qDetalhe, mapInterno } from './catalog.js';
import { isLocalRequest, tooManyAuthFails, registerAuthFail } from './request-guards.js';

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

function registerTools(server) {
  server.registerTool(
    'categorias',
    {
      title: 'Categorias do catálogo',
      description:
        'Lista as categorias disponíveis com contagem, faixa de preço e desconto médio. ' +
        'Use antes de buscar pra saber o que existe. Sem parâmetros.',
      inputSchema: {},
    },
    async () => {
      const rows = await qCategorias();
      return ok({
        total_pecas: rows.reduce((a, r) => a + r.n, 0),
        categorias: rows.map((r) => ({
          categoria: r.category,
          pecas: r.n,
          preco_min: Number(r.preco_min),
          preco_max: Number(r.preco_max),
          desconto_medio_pct: r.desconto_medio,
        })),
        dica: 'Buckets do mix: vestuario=roupas+calcados, acessorios=equipamentos, suplementos.',
      });
    }
  );

  server.registerTool(
    'buscar_pecas',
    {
      title: 'Buscar peças',
      description:
        'Busca peças no catálogo por texto e filtros. Retorna lista com preço, desconto, ' +
        'comissão, link de afiliado e texto_pronto. SEMPRE compartilhe o campo "link" ao indicar.',
      inputSchema: {
        texto: z.string().optional().describe('palavras no título, ex.: "chuteira society"'),
        categoria: z.string().optional().describe('roupas|calcados|equipamentos|suplementos|geral ou bucket vestuario|acessorios|suplementos'),
        preco_min: z.coerce.number().optional(),
        preco_max: z.coerce.number().optional().describe('teto de preço em BRL'),
        desconto_min: z.coerce.number().optional().describe('desconto mínimo em %'),
        ordenar: z.string().optional().describe('score|desconto|preco_asc|preco_desc|vendas (default score)'),
        limite: z.coerce.number().int().optional().describe('1-30 (default 8)'),
      },
    },
    async (a) => {
      const rows = await qBuscar(a);
      return ok({ total: rows.length, pecas: rows.map(mapInterno) });
    }
  );

  server.registerTool(
    'recomendar',
    {
      title: 'Recomendar peças',
      description:
        'Recebe um objetivo (ex.: "treino de musculação", "chuteira para society até R$200") e ' +
        'devolve as melhores peças por relevância + score, dentro do orçamento. SEMPRE inclua o "link".',
      inputSchema: {
        objetivo: z.string().describe('o que a pessoa quer, em linguagem natural'),
        orcamento: z.coerce.number().optional().describe('teto de preço em BRL'),
        categoria: z.string().optional().describe('opcional: restringe a uma categoria/bucket'),
        limite: z.coerce.number().int().optional().describe('quantas indicar (default 6, máx 15)'),
      },
    },
    async (a) => {
      const rows = await qRecomendar(a);
      return ok({
        objetivo: a.objetivo,
        total: rows.length,
        recomendacoes: rows.map(mapInterno),
        nota: 'Compartilhe o campo "link" (afiliado).',
      });
    }
  );

  server.registerTool(
    'detalhe',
    {
      title: 'Detalhe da peça',
      description: 'Ficha completa de uma peça pelo id (link de afiliado + texto_pronto).',
      inputSchema: { id: z.coerce.number().int().describe('id da peça') },
    },
    async (a) => {
      const row = await qDetalhe(a.id);
      if (!row) return fail(`peça ${a.id} não encontrada`);
      return ok(mapInterno(row));
    }
  );
}

function buildServer() {
  const server = new McpServer(
    { name: 'affiliate-catalog', version: '1.0.0' },
    {
      instructions:
        'Catálogo de afiliados fitness (Shopee). Ferramentas: categorias, buscar_pecas, ' +
        'recomendar, detalhe. Ao indicar qualquer peça, SEMPRE compartilhe o campo "link" ' +
        '(link de afiliado). Preços em BRL.',
    }
  );
  registerTools(server);
  return server;
}

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

function mcpAuth(req, res, next) {
  const token = config.mcp.token;
  if (!token) {
    // Sem token configurado: mesmo fallback do requireAdmin (localhost/LAN
    // real, não tunelado) — nunca "aberto pra internet" por omissão.
    if (isLocalRequest(req)) return next();
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'sem MCP_TOKEN configurado — apenas localhost' }, id: null });
  }
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (tooManyAuthFails('mcp', ip)) {
    return res.status(429).json({ jsonrpc: '2.0', error: { code: -32005, message: 'muitas tentativas — aguarde alguns minutos' }, id: null });
  }
  const auth = String(req.headers['authorization'] || '');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-mcp-token'] || '');
  if (provided && safeEqual(provided, token)) return next();
  registerAuthFail('mcp', ip);
  return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'não autorizado' }, id: null });
}

export function mountMcpRoutes(app) {
  app.post('/mcp', mcpAuth, async (req, res) => {
    let server = null;
    let transport = null;
    try {
      server = buildServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        try { transport && transport.close(); } catch {}
        try { server && server.close(); } catch {}
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.log('[mcp] erro no request:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'erro interno' }, id: null });
      }
    }
  });

  const notAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'método não permitido' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  console.log(`[mcp] rota /mcp montada (Streamable HTTP stateless, auth ${config.mcp.token ? 'por token' : 'LIBERADA (LAN)'})`);
}
