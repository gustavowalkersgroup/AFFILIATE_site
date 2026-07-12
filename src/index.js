// Entrypoint: boot (migrate → express → scheduler → telegram) + endpoints admin.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import {
  registerPanelRoutes,
  syncGroupsRoute,
  manualOfferRoute,
  testPostRoute,
} from './panel.js';
import { migrate, isPaused } from './db.js';
import { loadOverrides } from './settings-store.js';
import { startScheduler } from './scheduler.js';
import { startTelegramMonitor, addChannel } from './telegram.js';
import { handleWebhook, statusData } from './control.js';
import { mountMcpRoutes } from './mcp.js';
import { mountCatalogRoutes } from './catalog-routes.js';
import { mountInstagramImageRoute, mountInstagramOAuthRoutes } from './instagram.js';
import { isLocalRequest, tooManyAuthFails, registerAuthFail } from './request-guards.js';

const startedAt = Date.now();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// Wrapper p/ handlers async: erro vira 500 JSON, nunca derruba o processo.
function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.log('[index] erro no endpoint', req.path, '-', err.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    });
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '12mb' })); // 12mb p/ upload de base grande de disparos (40k+ contatos)

// Sem auth: healthcheck.
app.get('/health', asyncRoute(async (_req, res) => {
  res.json({ ok: true, paused: await isPaused(), uptime: Math.floor((Date.now() - startedAt) / 1000) });
}));

// Sem x-admin-token (a Evolution chama este endpoint), mas instance/remoteJid
// do payload são forjáveis por qualquer host com acesso à porta. Com
// WEBHOOK_TOKEN configurado, o path precisa do segredo
// (/webhook/evolution/<token> — registrado na Evolution pelo setup-groups.js).
// A validação de instância/owner segue dentro do handleWebhook.
// Responde 200 sempre que autorizado p/ evitar retries.
app.post(['/webhook/evolution', '/webhook/evolution/:token'], asyncRoute(async (req, res) => {
  if (config.webhookToken && req.params.token !== config.webhookToken) {
    console.log('[index] webhook rejeitado: token do path ausente/inválido');
    return res.status(401).json({ ok: false, error: 'token do webhook inválido' });
  }
  try {
    await handleWebhook(req.body);
  } catch (err) {
    console.log('[index] erro no webhook:', err.message);
  }
  res.json({ ok: true });
}));

// Comparação constant-time do token (anti side-channel de timing): sha256 dos
// dois valores iguala os tamanhos exigidos pelo timingSafeEqual.
function tokenMatches(provided) {
  const a = createHash('sha256').update(String(provided ?? '')).digest();
  const b = createHash('sha256').update(config.adminToken).digest();
  return timingSafeEqual(a, b);
}

// Auth: x-admin-token; com adminToken vazio, só localhost. Usado como
// middleware global (todo o resto abaixo) e por rota nas /api/* do painel.
function requireAdmin(req, res, next) {
  if (config.adminToken) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (tooManyAuthFails('admin', ip)) {
      return res.status(429).json({ ok: false, error: 'muitas tentativas — aguarde alguns minutos' });
    }
    if (tokenMatches(req.headers['x-admin-token'])) return next();
    registerAuthFail('admin', ip);
    return res.status(401).json({ ok: false, error: 'token inválido' });
  }
  if (isLocalRequest(req)) return next();
  return res.status(401).json({ ok: false, error: 'sem ADMIN_TOKEN configurado — apenas localhost' });
}

// Painel admin: o HTML é servido SEM token (a página pede o token ao usuário);
// as rotas /api/* registradas pelo panel.js usam requireAdmin por rota.
app.get('/painel', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'painel.html'), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'painel.html não encontrado' });
  });
});

// Download da extensão de Chrome (captura de sessão do portal de afiliados ML).
// Pública (sem segredo no .zip — o token é configurado pelo usuário no popup).
app.get('/ext/ml-session.zip', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ml-session.zip'), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'extensão não gerada ainda' });
  });
});
registerPanelRoutes(app, requireAdmin);

// MCP (catálogo de ofertas pra IA recomendar): auth PRÓPRIA (bearer token),
// por isso montado ANTES do requireAdmin global — o n8n não manda x-admin-token.
mountMcpRoutes(app);
// REST /catalog/* (slim, voltado ao cliente) consumido pelo MCP do n8n/NexTags.
mountCatalogRoutes(app);
// Instagram: proxy de imagem (a Meta busca a image_url) e callback do OAuth —
// ambos PÚBLICOS (sem x-admin-token), por isso montados ANTES do requireAdmin.
mountInstagramImageRoute(app);
mountInstagramOAuthRoutes(app);

app.use(requireAdmin);

// Mesmas infos do comando "status" do WhatsApp — fonte única: control.statusData
// (queries tz-aware com config.tz; "hoje" não diverge do comando entre 21h e 00h).
app.get('/status', asyncRoute(async (_req, res) => {
  res.json({ ok: true, ...(await statusData()) });
}));

// Rotas legadas: MESMOS handlers das /api/* do painel (panel.js) — sem duplicar
// a lógica de fetchAllGroups+upsert, import manual e test-post.
app.post('/offers/manual', manualOfferRoute);
app.post('/groups/sync', syncGroupsRoute);

app.post('/telegram/channels', asyncRoute(async (req, res) => {
  const username = req.body && req.body.username;
  if (!username) return res.status(400).json({ ok: false, error: 'username obrigatório' });
  const channel = await addChannel(username);
  res.json({ ok: true, channel });
}));

// Testa o pipeline copy → mensagem mandando SÓ pro owner (oferta segue pending).
app.post('/test-post', testPostRoute);

// Middleware de erro (depois de TODAS as rotas): garante o contrato "erros
// sempre JSON { error }" — sem ele, body JSON malformado faz o express.json()
// lançar SyntaxError e o handler padrão do Express responde 400 em text/html.
app.use((err, _req, res, _next) => {
  console.log('[index] erro de request:', err.message);
  if (!res.headersSent) {
    res.status(err.status || 400).json({
      ok: false,
      error: err.type === 'entity.parse.failed' ? 'JSON inválido no body' : err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (err) => {
  console.log('[index] unhandledRejection:', err && err.message ? err.message : err);
});

async function main() {
  await migrate();
  console.log('[index] schema ok');

  // Overrides do banco (settings cfg.%) aplicados ANTES do scheduler/telegram:
  // precedência DB > .env > default, mutando o objeto config em memória.
  await loadOverrides();

  startScheduler();

  startTelegramMonitor().catch((err) => {
    console.log('[index] telegram monitor falhou:', err.message);
  });

  app.listen(config.port, () => {
    console.log('[index] AFFILIATE no ar — resumo da config:', JSON.stringify({
      port: config.port,
      tz: config.tz,
      evolution: {
        url: config.evolution.url,
        instance: config.evolution.instance,
        ownerConfigurado: Boolean(config.evolution.ownerJid),
      },
      shopeeConfigurada: Boolean(config.shopee.appId),
      meliAutoLinks: config.meli.autoLinks,
      telegramConfigurado: Boolean(config.telegram.apiId && config.telegram.apiHash && config.telegram.session),
      ollama: { url: config.ollama.url, model: config.ollama.model },
      ramp: config.posting.ramp,
      adminToken: config.adminToken ? 'definido' : 'vazio (apenas localhost)',
      webhookToken: config.webhookToken ? 'definido' : 'vazio (webhook sem segredo na URL)',
    }));
  });
}

main().catch((err) => {
  console.log('[index] erro fatal no boot:', err.message);
  process.exit(1);
});
