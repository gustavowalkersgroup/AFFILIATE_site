// src/panel.js — backend do painel admin (/api/*).
// registerPanelRoutes(app, requireAdmin): todas as rotas /api/* exigem o header
// x-admin-token (mesmo middleware requireAdmin do index.js, passado por
// parâmetro). O HTML do painel (GET /painel, sem token) é servido pelo index.js.
// Erros: sempre JSON { error: 'mensagem' } com status HTTP adequado.
import crypto from 'node:crypto';
import { config } from './config.js';
import { query, pool, getSetting, setSetting } from './db.js';
import { statusData, listConversations, getConversationThread } from './control.js';
import { postOffer, runChannelSeed, runSourcing } from './scheduler.js';
import { importContacts, broadcastStats, sendTestInvite, normalizePhone } from './broadcast.js';
import { warmerStats, blastWarmerTarget } from './warmer.js';
import { importManualOffer as meliImport, resolveAffiliateUrl as resolveMeli, generateAffiliateLink as meliGenerate } from './meli.js';
import { buildAffiliateUrl as buildAmazonUrl, importManualOffer as amazonImport } from './amazon.js';
import { generateAffiliateLink as generateAliexpressLink, importManualOffer as aliexpressImport, testCredentials as aliexpressTest } from './aliexpress.js';
import { evoFetch, fetchAllGroups, notifyOwner } from './poster.js';
import { pickNextOffer, previewNextOffers } from './ranking.js';
import { generateCopy, assembleMessage } from './copy.js';
import {
  addChannel,
  removeChannel,
  startTelegramMonitor,
  stopTelegramMonitor,
  beginLogin,
  confirmLogin,
} from './telegram.js';
import { saveOverrides, maskedConfig } from './settings-store.js';
import { testToken as igTestToken, saveTokenManual as igSaveToken, disconnectInstagram, buildAuthorizeUrl as igAuthorizeUrl, igStatus, postOfferNow as igPostOfferNow, runInstagramExecutor } from './instagram.js';
import { fbStatus, runFacebookExecutor, postOfferNow as fbPostOfferNow } from './facebook.js';
import { searchOffers } from './shopee.js';
import {
  expandUrl,
  isAmazonUrl,
  isAliexpressUrl,
  isMeliUrl,
  parseAmazonUrl,
  parseAliexpressUrl,
} from './links.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Wrapper p/ handlers async: erro vira 500 JSON, nunca derruba o processo.
function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.log('[panel] erro no endpoint', req.path, '-', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  };
}

function toIso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function intParam(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Mesma lógica do plano diário do scheduler: semana 0-based desde started_at;
// startedAt vazio → week null e alvo = ramp[0] (semana 1 do ramp-up).
function rampInfo(startedAt) {
  const ramp = config.posting.ramp;
  if (!startedAt) return { week: null, targetPerDay: ramp[0] };
  const week = Math.max(
    0,
    Math.floor((Date.now() - new Date(startedAt).getTime()) / (7 * 24 * 3600 * 1000))
  );
  return { week, targetPerDay: ramp[Math.min(week, ramp.length - 1)] };
}

const OFFER_STATUSES = ['pending', 'posted', 'rejected', 'expired', 'skipped', 'all'];

// ---------------------------------------------------------------------------
// Helpers Evolution (aba Configuração) — shapes verificados no código v1.8.6
// do container: fetchInstances → [{ instance: { instanceName, status, owner? } }];
// connectionState → { instance: { state } }; connect → { pairingCode, code,
// base64, count } (qr) ou { instance: { state: 'open' } } (já conectada).
// ---------------------------------------------------------------------------

async function evoInstanceInfo() {
  const list = await evoFetch('/instance/fetchInstances');
  if (list === null) {
    // Evolution fora do ar/erro HTTP ≠ "instância não existe" — o front mostra
    // 'Evolution indisponível' em vez de oferecer criar instância (que daria 502).
    return { reachable: false, exists: false, owner: null };
  }
  const arr = Array.isArray(list) ? list : [list];
  const item = arr.find(
    (it) => (it.name ?? it.instance?.instanceName ?? it.instanceName) === config.evolution.instance
  );
  return {
    reachable: true,
    exists: Boolean(item),
    owner: item?.ownerJid ?? item?.instance?.owner ?? null,
  };
}

async function evoConnectionState() {
  const res = await evoFetch(`/instance/connectionState/${config.evolution.instance}`);
  return res?.instance?.state ?? res?.state ?? null;
}

// Mesma lógica do scripts/setup-groups.js (incluindo o webhookToken no path).
async function setEvolutionWebhook() {
  if (!config.webhookToken) {
    console.log('[panel] AVISO: WEBHOOK_TOKEN vazio — webhook sem segredo na URL (payload forjável)');
  }
  const path = '/webhook/evolution' + (config.webhookToken ? '/' + config.webhookToken : '');
  const url = 'http://10.0.0.254:' + config.port + path;
  const res = await evoFetch('/webhook/set/' + config.evolution.instance, {
    webhook: {
      url,
      enabled: true,
      byEvents: false,
      base64: false,
      events: ['MESSAGES_UPSERT', 'GROUP_PARTICIPANTS_UPDATE'],
    },
  });
  // NUNCA loga a URL completa — o path carrega o WEBHOOK_TOKEN (segredo que
  // autentica o webhook); vazaria pro log/journal a cada (re)configuração.
  if (res) console.log('[panel] webhook configurado (instância ' + config.evolution.instance + ')');
  return Boolean(res);
}

async function telegramStatus() {
  let channels = 0;
  try {
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM telegram_channels WHERE enabled = true'
    );
    channels = rows[0].n;
  } catch (err) {
    console.log(`[panel] erro ao contar canais: ${err.message}`);
  }
  return maskedConfig({ channels }).telegram;
}

// PUT /api/config: seções/campos aceitos → chaves do settings-store.
const CONFIG_SECTIONS = {
  shopee: ['appId', 'appSecret'],
  meli: ['autoLinks', 'mattWord', 'mattTool', 'cookie', 'csrf', 'tag'],
  amazon: ['tag'],
  aliexpress: ['appKey', 'appSecret', 'trackingId'],
  evolution: ['instance', 'ownerJid'],
  channel: ['url', 'inviteText', 'seedEveryHours'],
  broadcast: ['instance', 'instances', 'inviteLink', 'inviteLinks', 'messages', 'dailyRamp', 'spacingMs', 'window', 'groupDmEnabled', 'welcomeText', 'exitFeedbackText'],
  instagram: [
    'enabled', 'igUserId', 'accessToken', 'appId', 'appSecret', 'publicBaseUrl',
    'proxyImages', 'caption', 'hashtags', 'postEveryHours', 'dailyCap', 'minScore',
  ],
  tryon: ['enabled'],
  ollama: ['url', 'model'],
  copy: ['provider', 'anthropicApiKey', 'anthropicModel', 'openaiApiKey', 'openaiModel', 'styleExtra', 'persona', 'replyModel'],
  content: ['denylist', 'disclosure', 'footer', 'templates', 'penaltylist', 'ctas'],
  operation: [
    'postingWindow', 'ramp', 'peakHours', 'groupSpacingMs', 'sendDelayMs', 'dedupDays', 'offerTtlHours',
    'minCommission', 'minDiscount', 'minSales', 'minRating', 'minScore',
    'mixVestuario', 'mixAcessorios', 'mixSuplementos',
    'weightCommission', 'weightDiscount', 'weightPopularity',
    'penaltyMult', 'noReviewMult', 'noSalesMult',
  ],
};
// Campos de segredo: string vazia ou ausente = NÃO altera o valor atual.
const CONFIG_SECRETS = new Set([
  'shopee.appSecret', 'copy.anthropicApiKey', 'copy.openaiApiKey',
  'meli.cookie', 'aliexpress.appSecret',
  'instagram.accessToken', 'instagram.appSecret',
]);

// ---------------------------------------------------------------------------
// Handlers compartilhados (registrados em /api/* aqui e nas rotas legadas do
// index.js — MESMO handler, sem duplicação de lógica)
// ---------------------------------------------------------------------------

// POST /groups/sync e POST /api/groups/sync: fetchAllGroups + upsert dos
// grupos cujo subject contém o prefixo (default 'Achadinhos').
export const syncGroupsRoute = asyncRoute(async (req, res) => {
  const prefix = (req.body && req.body.prefix) || 'Achadinhos';
  const all = await fetchAllGroups();
  const matched = (all || []).filter((g) => g.subject && g.subject.includes(prefix));

  const saved = [];
  for (let i = 0; i < matched.length; i++) {
    const g = matched[i];
    const { rows } = await query(
      `INSERT INTO groups (jid, name, enabled, position)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (jid) DO UPDATE
         SET name = EXCLUDED.name, enabled = true, position = EXCLUDED.position
       RETURNING jid, name, enabled, position`,
      [g.id, g.subject, i]
    );
    saved.push(rows[0]);
  }
  console.log('[panel] groups/sync: ' + saved.length + ' grupo(s) com prefixo "' + prefix + '"');
  res.json({ ok: true, groups: saved });
});

// POST /offers/manual e POST /api/offers/manual: import de oferta do ML.
// Import manual ciente do marketplace: detecta a plataforma pela URL (ou campo
// body.marketplace), GERA o link de afiliado correto (Amazon ?tag / AliExpress
// API / ML createLink→matt) e importa. Sem URL reconhecível, cai no comportamento
// antigo (assume affiliateUrl pronto, importer do ML).
export const manualOfferRoute = asyncRoute(async (req, res) => {
  try {
    const body = req.body || {};
    const srcUrl = String(body.url || body.affiliateUrl || '').trim();
    let mk = String(body.marketplace || '').trim().toLowerCase();
    if (!mk && srcUrl) {
      if (isAmazonUrl(srcUrl)) mk = 'amazon';
      else if (isAliexpressUrl(srcUrl)) mk = 'aliexpress';
      else if (isMeliUrl(srcUrl)) mk = 'meli';
    }

    if (mk === 'amazon') {
      let u = srcUrl;
      if (!parseAmazonUrl(u)?.asin) u = await expandUrl(u);
      const affiliateUrl = buildAmazonUrl(u);
      if (!affiliateUrl) {
        throw new Error('Amazon: configure o tag de associado e use uma URL de produto válida (/dp/ASIN)');
      }
      const offer = await amazonImport({ ...body, affiliateUrl });
      return res.json({ ok: true, offer, marketplace: 'amazon', affiliateUrl });
    }
    if (mk === 'aliexpress') {
      let u = srcUrl;
      if (!parseAliexpressUrl(u)?.productId) u = await expandUrl(u);
      const affiliateUrl = await generateAliexpressLink(u);
      if (!affiliateUrl) {
        throw new Error('AliExpress: não gerou link (confira app_key/app_secret/tracking_id e a permissão Affiliate)');
      }
      const offer = await aliexpressImport({ ...body, affiliateUrl, productUrl: u });
      return res.json({ ok: true, offer, marketplace: 'aliexpress', affiliateUrl });
    }
    if (mk === 'meli') {
      const affiliateUrl = (await resolveMeli(srcUrl)) || body.affiliateUrl;
      if (!affiliateUrl) {
        throw new Error('Mercado Livre: sem sessão (cookie) nem matt_word/tool — não dá pra gerar link');
      }
      const offer = await meliImport({ ...body, affiliateUrl });
      return res.json({ ok: true, offer, marketplace: 'meli', affiliateUrl });
    }

    const offer = await meliImport(body);
    res.json({ ok: true, offer });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /test-post e POST /api/test-post: copy da melhor oferta SÓ pro dono
// (oferta segue pending) — mesmas funções do pipeline.
export const testPostRoute = asyncRoute(async (_req, res) => {
  const offer = await pickNextOffer();
  if (!offer) return res.status(404).json({ ok: false, error: 'nenhuma oferta pending elegível' });
  const hook = await generateCopy(offer);
  const message = assembleMessage(offer, hook);
  await notifyOwner(message);
  res.json({ ok: true, offerId: offer.id, message });
});

// ---------------------------------------------------------------------------
// Registro das rotas
// ---------------------------------------------------------------------------

// Serializa add/remove de warmer_targets: os dois endpoints fazem
// getSetting → muta em JS → setSetting (read-modify-write não-atômico); sem
// isso, dois requests próximos (duplo clique, duas abas) leem o mesmo CSV de
// partida e um `setSetting` sobrescreve silenciosamente o outro.
let warmerTargetsLock = Promise.resolve();
function withWarmerTargetsLock(fn) {
  const run = warmerTargetsLock.then(fn, fn);
  warmerTargetsLock = run.then(() => {}, () => {});
  return run;
}

export function registerPanelRoutes(app, requireAdmin) {
  // ------------------------------------------------------------------ overview
  app.get('/api/overview', requireAdmin, asyncRoute(async (_req, res) => {
    const tz = config.tz;
    const status = await statusData(); // fonte única (tz-aware) de paused/postsToday/pending

    const startedAtRaw = await getSetting('started_at', '');
    const startedAt = startedAtRaw ? toIso(startedAtRaw) : null;
    const { week, targetPerDay } = rampInfo(startedAt);

    const { rows: slotRows } = await query(
      `SELECT id, scheduled_at, status, offer_id
         FROM slots
        WHERE (scheduled_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        ORDER BY scheduled_at ASC`,
      [tz]
    );
    const { rows: countRows } = await query(
      `SELECT status, count(*)::int AS n FROM offers GROUP BY status`
    );
    const byStatus = Object.fromEntries(countRows.map((r) => [r.status, r.n]));
    const { rows: groupRows } = await query(
      'SELECT jid, name, enabled, position FROM groups ORDER BY position, jid'
    );

    let lastSourcing = null;
    try {
      const raw = await getSetting('last_sourcing_result', '');
      if (raw) lastSourcing = JSON.parse(raw);
    } catch { /* ignora JSON malformado */ }

    res.json({
      paused: status.paused,
      startedAt,
      week,
      targetPerDay,
      lastSourcing,
      postsToday: status.postsToday,
      slotsToday: slotRows.map((s) => ({
        id: s.id,
        scheduled_at: toIso(s.scheduled_at),
        status: s.status,
        offer_id: s.offer_id,
      })),
      counts: {
        pending: byStatus.pending ?? 0,
        posted: byStatus.posted ?? 0,
        rejected: byStatus.rejected ?? 0,
        expired: byStatus.expired ?? 0,
      },
      pendingAboveMinScore: status.pendingOffersAboveMinScore,
      groups: groupRows,
      telegramConfigured: Boolean(
        config.telegram.apiId && config.telegram.apiHash && config.telegram.session
      ),
      shopeeConfigured: Boolean(config.shopee.appId),
    });
  }));

  // -------------------------------------------------------------------- health
  // Semáforos de saúde de todas as frentes num lugar só (cabeçalho do painel).
  // level: 'ok'(verde) | 'warn'(amarelo) | 'err'(vermelho) | 'off'(cinza, não-em-uso).
  app.get('/api/health', requireAdmin, asyncRoute(async (_req, res) => {
    const items = [];

    try {
      const { reachable, exists } = await evoInstanceInfo();
      const state = exists ? await evoConnectionState() : null;
      if (!reachable) items.push({ area: 'WhatsApp', level: 'err', label: 'Evolution fora do ar' });
      else if (!exists) items.push({ area: 'WhatsApp', level: 'err', label: 'instância não criada' });
      else if (state === 'open') items.push({ area: 'WhatsApp', level: 'ok', label: 'conectado' });
      else items.push({ area: 'WhatsApp', level: 'err', label: `desconectado (${state || '?'})` });
    } catch { items.push({ area: 'WhatsApp', level: 'warn', label: 'não verificado' }); }

    try {
      const ig = await igStatus();
      if (!ig.configured) items.push({ area: 'Instagram', level: 'off', label: 'não conectado' });
      else if (!ig.enabled) items.push({ area: 'Instagram', level: 'warn', label: 'auto-post desligado' });
      else {
        let level = 'ok';
        let label = `${ig.postedToday}/${ig.dailyCap} hoje`;
        if (ig.tokenExpiresAt) {
          const d = Math.floor((new Date(ig.tokenExpiresAt).getTime() - Date.now()) / 86_400_000);
          if (d <= 7) { level = 'warn'; label += ` · token vence em ${d}d`; }
        }
        items.push({ area: 'Instagram', level, label });
      }
    } catch { items.push({ area: 'Instagram', level: 'warn', label: 'não verificado' }); }

    try {
      const tg = await telegramStatus();
      if (!tg.sessionSet) items.push({ area: 'Telegram', level: 'off', label: 'não conectado' });
      else if (!tg.monitorRunning) items.push({ area: 'Telegram', level: 'err', label: 'monitor caído' });
      else items.push({ area: 'Telegram', level: 'ok', label: `${tg.channels} canal(is)` });
    } catch { items.push({ area: 'Telegram', level: 'warn', label: 'não verificado' }); }

    try {
      const bc = await broadcastStats();
      if (!bc.configured) items.push({ area: 'Disparos', level: 'off', label: 'não configurado' });
      else if (bc.paused) items.push({ area: 'Disparos', level: 'off', label: 'pausado' });
      else items.push({ area: 'Disparos', level: 'ok', label: `${bc.sentToday}/${bc.dailyTarget} · ${bc.reason}` });
    } catch { items.push({ area: 'Disparos', level: 'warn', label: 'não verificado' }); }

    try {
      const raw = await getSetting('last_sourcing_result', '');
      if (!raw) items.push({ area: 'Ofertas', level: 'warn', label: 'busca ainda não rodou' });
      else {
        const r = JSON.parse(raw);
        const ageH = (Date.now() - new Date(r.at).getTime()) / 3_600_000;
        if (ageH > 6) items.push({ area: 'Ofertas', level: 'warn', label: `última busca há ${Math.round(ageH)}h` });
        else if (r.total === 0) items.push({ area: 'Ofertas', level: 'warn', label: 'última busca: 0 ofertas' });
        else items.push({ area: 'Ofertas', level: 'ok', label: `${r.total} na última busca` });
      }
    } catch { /* ignora */ }

    items.push({ area: 'Copy', level: 'ok', label: config.copy.provider });

    res.json({ items });
  }));

  // -------------------------------------------------------------------- offers
  app.get('/api/warmer/status', requireAdmin, asyncRoute(async (_req, res) => {
    const stats = await warmerStats();
    res.json({
      ...stats,
      spacingMs: await getSetting('warmer_spacing_ms', '20000-120000'),
      window: await getSetting('warmer_window', '07:00-23:00'),
      dailyCap: Number(await getSetting('warmer_daily_cap', '0')) || 0,
      rampDays: Number(await getSetting('warmer_ramp_days', '0')) || 0,
    });
  }));

  app.post('/api/warmer/toggle', requireAdmin, asyncRoute(async (req, res) => {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    await setSetting('warmer_enabled', enabled ? 'on' : 'off');
    if (enabled) await setSetting('warmer_next_at', '');
    res.json({ ok: true, enabled });
  }));

  app.post('/api/warmer/settings', requireAdmin, asyncRoute(async (req, res) => {
    const b = req.body || {};
    if (b.spacingMin != null && b.spacingMax != null) {
      const min = Math.max(1, Math.round(Number(b.spacingMin) * 1000));
      const max = Math.max(min, Math.round(Number(b.spacingMax) * 1000));
      await setSetting('warmer_spacing_ms', `${min}-${max}`);
    }
    if (typeof b.window === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(b.window)) {
      await setSetting('warmer_window', b.window);
    }
    if (b.dailyCap != null) await setSetting('warmer_daily_cap', String(Math.max(0, Math.floor(Number(b.dailyCap)) || 0)));
    if (b.rampDays != null) await setSetting('warmer_ramp_days', String(Math.max(0, Math.floor(Number(b.rampDays)) || 0)));
    if (Array.isArray(b.instances)) {
      const csv = b.instances.map((s) => String(s).trim()).filter(Boolean).join(',');
      await setSetting('warmer_instances', csv);
    }
    res.json({ ok: true });
  }));

  // Números de fora do mesh (ex.: API oficial) que entram no ciclo do aquecedor.
  app.post('/api/warmer/targets/add', requireAdmin, asyncRoute(async (req, res) => {
    const norm = normalizePhone(req.body?.number);
    if (!norm) return res.status(400).json({ ok: false, error: 'número inválido' });
    const targets = await withWarmerTargetsLock(async () => {
      const current = new Set(String(await getSetting('warmer_targets', '')).split(',').map((s) => s.trim()).filter(Boolean));
      current.add(norm.phone);
      const arr = Array.from(current);
      await setSetting('warmer_targets', arr.join(','));
      return arr;
    });
    res.json({ ok: true, targets });
  }));

  app.post('/api/warmer/targets/remove', requireAdmin, asyncRoute(async (req, res) => {
    const norm = normalizePhone(req.body?.number);
    const wanted = norm ? norm.phone : String(req.body?.number ?? '').trim();
    const targets = await withWarmerTargetsLock(async () => {
      const raw = String(await getSetting('warmer_targets', '')).split(',').map((s) => s.trim()).filter(Boolean);
      const arr = raw.filter((p) => p !== wanted);
      await setSetting('warmer_targets', arr.join(','));
      return arr;
    });
    res.json({ ok: true, targets });
  }));

  // Disparo imediato: todos os chips do allowlist mandam 1 mensagem agora pro número.
  app.post('/api/warmer/blast', requireAdmin, asyncRoute(async (req, res) => {
    const result = await blastWarmerTarget(req.body?.number);
    res.json(result);
  }));

  app.get('/api/offers', requireAdmin, asyncRoute(async (req, res) => {
    const status = String(req.query.status ?? 'pending');
    if (!OFFER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status inválido (use ${OFFER_STATUSES.join('|')})` });
    }
    const limit = Math.min(intParam(req.query.limit) ?? 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = status === 'all' ? '' : 'WHERE status = $3';
    // pending: fila real (score DESC); demais: mais recentes primeiro
    const order = status === 'pending'
      ? 'ORDER BY score DESC, created_at DESC'
      : 'ORDER BY created_at DESC';
    const params = status === 'all' ? [limit, offset] : [limit, offset, status];

    const { rows: offers } = await query(
      `SELECT * FROM offers ${where} ${order} LIMIT $1 OFFSET $2`,
      params
    );
    const { rows: totalRows } = await query(
      `SELECT count(*)::int AS n FROM offers ${status === 'all' ? '' : 'WHERE status = $1'}`,
      status === 'all' ? [] : [status]
    );

    res.json({
      offers: offers.map((o) => ({ ...o, created_at: toIso(o.created_at), posted_at: toIso(o.posted_at) })),
      total: totalRows[0].n,
    });
  }));

  // Preview READ-ONLY da sequência REAL de postagem (mix 70/20/10): a aba Fila
  // lista por score, mas o que vai pros grupos segue o mix. previewNextOffers
  // NÃO escreve no banco.
  app.get('/api/offers/next', requireAdmin, asyncRoute(async (req, res) => {
    const limit = Math.min(intParam(req.query.limit) ?? 12, 30);
    const sequence = await previewNextOffers(limit);
    res.json({ sequence });
  }));

  app.post('/api/offers/:id/reject', requireAdmin, asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const result = await query(
      `UPDATE offers SET status = 'rejected' WHERE id = $1 AND status NOT IN ('posted', 'posting')`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'oferta não encontrada, em envio ou já postada' });
    }
    console.log(`[panel] oferta ${id} rejeitada`);
    res.json({ ok: true });
  }));

  app.post('/api/offers/:id/restore', requireAdmin, asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    // created_at = now() renova o TTL — senão a oferta restaurada já nasce expirável
    const result = await query(
      `UPDATE offers SET status = 'pending', created_at = now() WHERE id = $1 AND status NOT IN ('posted', 'posting')`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'oferta não encontrada, em envio ou já postada' });
    }
    console.log(`[panel] oferta ${id} restaurada para pending`);
    res.json({ ok: true });
  }));

  // Posta AGORA a oferta nos grupos habilitados — ação explícita do dono:
  // ignora slots e o paused. Responde só DEPOIS de terminar os envios (com o
  // espaçamento de 60-180s entre grupos pode levar vários minutos).
  app.post('/api/offers/:id/post-now', requireAdmin, asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });

    const { rows } = await query('SELECT * FROM offers WHERE id = $1', [id]);
    const offer = rows[0];
    if (!offer) return res.status(404).json({ error: 'oferta não encontrada' });
    if (offer.status === 'posted') return res.status(409).json({ error: 'oferta já postada' });

    const { rows: gRows } = await query('SELECT count(*)::int AS n FROM groups WHERE enabled');
    if (gRows[0].n === 0) return res.status(422).json({ error: 'nenhum grupo habilitado' });

    console.log(`[panel] post-now da oferta ${id} (${gRows[0].n} grupo(s))`);
    const { sent, failed, conflict } = await postOffer(offer); // fonte única com o executor
    if (conflict) {
      // outro envio (executor ou outro post-now) reivindicou a oferta primeiro
      return res.status(409).json({ error: 'oferta já está sendo postada por outro envio' });
    }
    res.json({ ok: sent > 0, sent, failed });
  }));

  app.post('/api/offers/manual', requireAdmin, manualOfferRoute);

  // --------------------------------------------------------------------- posts
  app.get('/api/posts', requireAdmin, asyncRoute(async (req, res) => {
    const limit = Math.min(intParam(req.query.limit) ?? 50, 200);
    const onlyFailed = String(req.query.onlyFailed ?? '') === '1' || req.query.onlyFailed === 'true';
    const where = onlyFailed ? 'WHERE NOT p.ok' : '';
    const { rows } = await query(
      `SELECT p.id, p.offer_id, p.group_jid, g.name AS group_name, p.ok, p.error, p.posted_at,
              o.title, o.price, o.affiliate_url
         FROM posts p
         JOIN offers o ON o.id = p.offer_id
         LEFT JOIN groups g ON g.jid = p.group_jid
        ${where}
        ORDER BY p.posted_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ posts: rows.map((p) => ({ ...p, posted_at: toIso(p.posted_at) })) });
  }));

  // -------------------------------------------------------------------- groups
  app.patch('/api/groups/:jid', requireAdmin, asyncRoute(async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) obrigatório' });
    }
    const result = await query('UPDATE groups SET enabled = $2 WHERE jid = $1', [
      req.params.jid,
      enabled,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'grupo não encontrado' });
    console.log(`[panel] grupo ${req.params.jid} ${enabled ? 'habilitado' : 'desabilitado'}`);
    res.json({ ok: true });
  }));

  // Alias do POST /groups/sync do index.js — MESMO handler (syncGroupsRoute).
  app.post('/api/groups/sync', requireAdmin, syncGroupsRoute);

  // ------------------------------------------------------------------ keywords
  app.get('/api/keywords', requireAdmin, asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT id, term, category, enabled FROM keywords ORDER BY id');
    res.json({ keywords: rows });
  }));

  app.post('/api/keywords', requireAdmin, asyncRoute(async (req, res) => {
    const term = String(req.body?.term ?? '').trim().toLowerCase();
    if (!term) return res.status(400).json({ error: 'term obrigatório' });
    const category = String(req.body?.category ?? '').trim() || 'geral';
    const { rows } = await query(
      `INSERT INTO keywords (term, category) VALUES ($1, $2)
       ON CONFLICT (term) DO UPDATE SET enabled = true, category = EXCLUDED.category
       RETURNING id, term, category, enabled`,
      [term, category]
    );
    console.log(`[panel] keyword "${term}" cadastrada/reativada`);
    res.json({ ok: true, keyword: rows[0] });
  }));

  app.patch('/api/keywords/:id', requireAdmin, asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) obrigatório' });
    }
    const result = await query('UPDATE keywords SET enabled = $2 WHERE id = $1', [id, enabled]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'keyword não encontrada' });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ channels
  app.get('/api/channels', requireAdmin, asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT id, username, enabled FROM telegram_channels ORDER BY id');
    res.json({ channels: rows });
  }));

  app.post('/api/channels', requireAdmin, asyncRoute(async (req, res) => {
    const username = req.body?.username;
    if (!username) return res.status(400).json({ error: 'username obrigatório' });
    const channel = await addChannel(username); // strip de @ e t.me/ feito no addChannel
    if (!channel) return res.status(400).json({ error: 'username inválido ou erro ao cadastrar' });
    res.json({ ok: true, channel });
  }));

  app.patch('/api/channels/:id', requireAdmin, asyncRoute(async (req, res) => {
    const id = intParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) obrigatório' });
    }
    const { rows } = await query(
      'UPDATE telegram_channels SET enabled = $2 WHERE id = $1 RETURNING username',
      [id, enabled]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'canal não encontrado' });
    if (enabled) {
      // reativa o monitor em runtime (addChannel adiciona ao set watched e faz join)
      addChannel(rows[0].username).catch((err) =>
        console.log(`[panel] erro ao re-monitorar canal: ${err.message}`)
      );
    } else {
      removeChannel(rows[0].username); // efeito imediato: monitor para de capturar já
      console.log(`[panel] canal ${rows[0].username} desabilitado`);
    }
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------- pause/resume
  app.post('/api/pause', requireAdmin, asyncRoute(async (_req, res) => {
    await setSetting('paused', 'true');
    console.log('[panel] sistema pausado via painel');
    res.json({ ok: true, paused: true });
  }));

  app.post('/api/resume', requireAdmin, asyncRoute(async (_req, res) => {
    await setSetting('paused', 'false');
    console.log('[panel] sistema retomado via painel');
    res.json({ ok: true, paused: false });
  }));

  // ----------------------------------------------------------------- test-post
  // Alias do POST /test-post do index.js — MESMO handler (testPostRoute).
  app.post('/api/test-post', requireAdmin, testPostRoute);

  // ------------------------------------------------------------------ sourcing
  // Força uma busca de ofertas AGORA (ignora o pause — sourcing só preenche a
  // fila, não posta). Bloqueia até terminar; devolve o resumo do que entrou.
  app.post('/api/sourcing/run-now', requireAdmin, asyncRoute(async (_req, res) => {
    if (!config.shopee.appId || !config.shopee.appSecret) {
      return res.status(422).json({ ok: false, error: 'configure as credenciais da Shopee antes de buscar ofertas' });
    }
    const result = await runSourcing({ force: true });
    if (result.error) return res.json({ ok: false, error: result.error });
    if (result.skipped) return res.json({ ok: false, error: `não rodou: ${result.skipped}` });
    res.json({ ok: true, ...result });
  }));

  // ----------------------------------------------------------- aquecimento (ramp)
  // Datas/semana atuais do ramp-up (posts e disparos) p/ a aba Operação exibir e
  // permitir reiniciar. week = semanas inteiras desde a âncora; null se não iniciado.
  app.get('/api/operation/warmup', requireAdmin, asyncRoute(async (_req, res) => {
    const postsStarted = (await getSetting('started_at', '')) || null;
    const bcStarted = (await getSetting('broadcast_started_at', '')) || null;
    const weekOf = (startedAt) =>
      startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / (7 * 24 * 3600 * 1000))) : null;
    const targetOf = (ramp, wk) => ramp[Math.min(wk ?? 0, ramp.length - 1)];
    res.json({
      posts: { startedAt: toIso(postsStarted), week: weekOf(postsStarted), ramp: config.posting.ramp, target: targetOf(config.posting.ramp, weekOf(postsStarted)) },
      broadcast: { startedAt: toIso(bcStarted), week: weekOf(bcStarted), ramp: config.broadcast.dailyRamp, target: targetOf(config.broadcast.dailyRamp, weekOf(bcStarted)) },
    });
  }));

  // Reinicia o aquecimento: zera a âncora (started_at) — re-ancora na próxima
  // ativação, recomeçando o ramp da semana 1. which: 'posts' | 'broadcast' | 'both'.
  app.post('/api/operation/reset-warmup', requireAdmin, asyncRoute(async (req, res) => {
    const which = String(req.body?.which ?? 'both');
    if (!['posts', 'broadcast', 'both'].includes(which)) {
      return res.status(400).json({ error: "which deve ser 'posts', 'broadcast' ou 'both'" });
    }
    if (which === 'posts' || which === 'both') await setSetting('started_at', '');
    if (which === 'broadcast' || which === 'both') await setSetting('broadcast_started_at', '');
    console.log(`[panel] aquecimento reiniciado (${which})`);
    res.json({ ok: true, which });
  }));

  // -------------------------------------------------------------- canal (seed)
  // Divulga o link do canal nos grupos AGORA (ignora cadência/janela/pausa).
  app.post('/api/channel/seed-now', requireAdmin, asyncRoute(async (_req, res) => {
    if (!String(config.channel.url ?? '').trim()) {
      return res.status(400).json({ error: 'configure o link do canal antes de divulgar' });
    }
    const result = await runChannelSeed({ force: true });
    res.json({ ok: !result.error && !result.skipped, ...result });
  }));

  // ----------------------------------------------------------------- disparos
  app.get('/api/broadcast', requireAdmin, asyncRoute(async (_req, res) => {
    res.json(await broadcastStats());
  }));

  app.post('/api/broadcast/contacts', requireAdmin, asyncRoute(async (req, res) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'cole a lista de números' });
    const result = await importContacts(text);
    res.json({ ok: true, ...result });
  }));

  app.post('/api/broadcast/pause', requireAdmin, asyncRoute(async (_req, res) => {
    await setSetting('broadcast_paused', 'true');
    console.log('[panel] disparos pausados');
    res.json({ ok: true, paused: true });
  }));

  app.post('/api/broadcast/resume', requireAdmin, asyncRoute(async (_req, res) => {
    const hasLink = Boolean(config.broadcast.inviteLink || config.broadcast.inviteLinks.length);
    if (!config.broadcast.instance || !hasLink) {
      return res.status(400).json({ ok: false, error: 'configure a instância e ao menos um link de convite antes de iniciar' });
    }
    await setSetting('broadcast_paused', 'false');
    console.log('[panel] disparos retomados');
    res.json({ ok: true, paused: false });
  }));

  app.post('/api/broadcast/test', requireAdmin, asyncRoute(async (req, res) => {
    const number = String(req.body?.number ?? '').trim();
    if (!number) return res.status(400).json({ ok: false, error: 'informe um número pra teste' });
    res.json(await sendTestInvite(number));
  }));

  // Limpa a fila (pending/failed) — NÃO apaga 'sent' nem 'optout' (dedup/respeito).
  app.post('/api/broadcast/clear', requireAdmin, asyncRoute(async (_req, res) => {
    const { rowCount } = await query(`DELETE FROM contacts WHERE status IN ('pending','failed')`);
    res.json({ ok: true, removed: rowCount });
  }));

  // Motivos agregados das falhas de disparo ("180 sem whatsapp, 20 envio falhou").
  app.get('/api/broadcast/failures', requireAdmin, asyncRoute(async (_req, res) => {
    const { rows } = await query(
      `SELECT COALESCE(NULLIF(last_error, ''), 'desconhecido') AS reason, count(*)::int AS n
         FROM contacts WHERE status = 'failed' GROUP BY reason ORDER BY n DESC`
    );
    res.json({ failures: rows });
  }));

  // Aba Conversas: DMs que a IA assume (aiReply) — somente leitura.
  app.get('/api/conversations', requireAdmin, asyncRoute(async (req, res) => {
    const status = ['optin', 'optout'].includes(req.query.status) ? req.query.status : undefined;
    res.json({ conversations: await listConversations({ status }) });
  }));

  app.get('/api/conversations/:jid', requireAdmin, asyncRoute(async (req, res) => {
    res.json(await getConversationThread(req.params.jid));
  }));

  // ------------------------------------------------------------------- config
  // Aba Configuração: overrides em runtime (settings cfg.% > .env > default).
  app.get('/api/config', requireAdmin, asyncRoute(async (_req, res) => {
    const telegram = await telegramStatus();
    res.json({ ...maskedConfig(), telegram });
  }));

  app.put('/api/config', requireAdmin, asyncRoute(async (req, res) => {
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body deve ser um objeto com seções (shopee/meli/evolution/ollama/copy/operation)' });
    }

    const flat = {};
    for (const [section, fields] of Object.entries(body)) {
      const allowed = CONFIG_SECTIONS[section];
      if (!allowed) return res.status(400).json({ error: `seção desconhecida: ${section}` });
      if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
        return res.status(400).json({ error: `seção ${section} deve ser um objeto` });
      }
      for (const [field, value] of Object.entries(fields)) {
        if (!allowed.includes(field)) {
          return res.status(400).json({ error: `campo desconhecido: ${section}.${field}` });
        }
        const key = `${section}.${field}`;
        // segredo vazio/ausente = não altera (trim ANTES do guard: o parser do
        // settings-store trima depois, e ' ' viraria '' sobrescrevendo o segredo)
        if (CONFIG_SECRETS.has(key) && (value == null || String(value).trim() === '')) continue;
        flat[key] = value;
      }
    }

    try {
      // valida TUDO antes; transação tudo-ou-nada; aplica em memória (live config)
      const applied = await saveOverrides(flat);
      res.json({ ok: true, applied });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  // Testa as credenciais Shopee EFETIVAS atuais com uma busca real.
  app.post('/api/config/shopee/test', requireAdmin, asyncRoute(async (_req, res) => {
    if (!config.shopee.appId || !config.shopee.appSecret) {
      return res.json({ ok: false, error: 'credenciais não configuradas' });
    }
    const offers = await searchOffers('whey protein', { limit: 1 });
    if (!offers.length) {
      return res.json({ ok: false, error: 'sem resultados — verifique AppID/AppSecret (veja o log do serviço)' });
    }
    const o = offers[0];
    res.json({ ok: true, sample: { title: o.title, price: o.price, commissionRate: o.commissionRate } });
  }));

  // Testa as credenciais AliExpress gerando um link de afiliado real.
  app.post('/api/config/aliexpress/test', requireAdmin, asyncRoute(async (req, res) => {
    const sample = String(req.body?.url ?? '').trim();
    const result = sample ? await aliexpressTest(sample) : await aliexpressTest();
    res.json(result);
  }));

  // Valida o tag de associado da Amazon e devolve um link de exemplo pronto.
  // (Amazon não tem API/segredo: o link de afiliado é só a URL /dp/ASIN + ?tag.)
  app.post('/api/config/amazon/test', requireAdmin, asyncRoute(async (_req, res) => {
    const tag = String(config.amazon.tag || '').trim();
    if (!tag) {
      return res.json({ ok: false, error: 'defina o seu tag de associado (ex.: axelot-20) e salve antes de testar' });
    }
    const example = buildAmazonUrl('https://www.amazon.com.br/dp/B08N5WRWNW');
    if (!example) {
      return res.json({ ok: false, error: 'não consegui montar o link — confira o tag de associado' });
    }
    const formatoOk = /^[\w-]{2,}-\d{2}$/.test(tag);
    res.json({
      ok: true,
      tag,
      example,
      warn: formatoOk ? null : `o tag "${tag}" tem um formato incomum (o normal é algo como "nome-20") — confira se está certo`,
    });
  }));

  // Testa a sessão do portal de afiliados ML (createLink) com uma URL de produto.
  app.post('/api/config/meli/test-link', requireAdmin, asyncRoute(async (req, res) => {
    const raw = String(req.body?.url ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return res.json({ ok: false, error: 'cole a URL de um produto do Mercado Livre' });
    }
    const link = await meliGenerate(raw);
    if (link) return res.json({ ok: true, link });
    res.json({ ok: false, error: 'não gerou link — cookie/csrf ausente ou sessão expirada (re-logar no portal e colar o cookie)' });
  }));

  // Recebe a sessão do portal de afiliados ML capturada pela extensão de Chrome
  // (cookie + x-csrf-token + tag) e persiste em settings. Mesmo guard de segredo.
  app.post('/api/config/meli/session', requireAdmin, asyncRoute(async (req, res) => {
    const b = req.body || {};
    const flat = {};
    if (b.cookie && String(b.cookie).trim()) flat['meli.cookie'] = String(b.cookie).trim();
    if (b.csrf && String(b.csrf).trim()) flat['meli.csrf'] = String(b.csrf).trim();
    if (b.tag && String(b.tag).trim()) flat['meli.tag'] = String(b.tag).trim();
    if (!flat['meli.cookie']) {
      return res.status(400).json({ ok: false, error: 'cookie ausente — gere 1 link no portal e tente de novo' });
    }
    try {
      await saveOverrides(flat);
      console.log('[panel] sessão ML recebida da extensão (cookie+csrf salvos)');
      res.json({
        ok: true,
        cookieLen: flat['meli.cookie'].length,
        csrfSet: Boolean(flat['meli.csrf']),
        tagSet: Boolean(flat['meli.tag']),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }));

  // Gera um gancho de exemplo com o PROVEDOR EFETIVO atual (Ollama ou Anthropic)
  // para um produto fixo — valida a copy de ponta a ponta sem postar nada.
  app.post('/api/config/copy/test', requireAdmin, asyncRoute(async (_req, res) => {
    const provider = config.copy?.provider || 'ollama';
    if (provider === 'anthropic' && !config.copy?.anthropic?.apiKey) {
      return res.json({ ok: false, error: 'defina a chave da Anthropic primeiro' });
    }
    try {
      const hook = await generateCopy({ title: 'Camiseta Dry Fit Masculina Academia', category: 'roupas' });
      res.json({ ok: true, provider, hook });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  }));

  // Extrai matt_word/matt_tool de um link de afiliado do ML (não salva nada —
  // o front pré-preenche o form e salva via PUT /api/config).
  app.post('/api/config/meli/extract', requireAdmin, asyncRoute(async (req, res) => {
    const raw = String(req.body?.url ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return res.status(400).json({ error: 'url obrigatória (http/https)' });
    }
    // expandUrl segue redirects (mercadolivre.com/sec/...); se a URL já é final
    // (ou a expansão falha), retorna a própria URL — tratada direto abaixo.
    const finalUrl = await expandUrl(raw);
    let mattWord = null;
    let mattTool = null;
    try {
      const u = new URL(finalUrl);
      mattWord = u.searchParams.get('matt_word');
      mattTool = u.searchParams.get('matt_tool');
    } catch {
      return res.status(400).json({ error: 'URL final inválida' });
    }
    if (!mattWord || !mattTool) {
      return res.json({
        ok: false,
        error: 'link sem parâmetros de afiliado — gere o link no portal do ML e cole aqui',
      });
    }
    res.json({ ok: true, mattWord, mattTool });
  }));

  // ---------------------------------------------------------------- instagram
  // Estado da integração (configurado? token expira quando? postados hoje?).
  app.get('/api/instagram/status', requireAdmin, asyncRoute(async (_req, res) => {
    res.json(await igStatus());
  }));

  // Valida o token (o do body, se vier, senão o efetivo) e descobre o ig-user-id.
  // Token novo válido → persiste token + igUserId + expiração estimada (saveTokenManual).
  app.post('/api/instagram/test', requireAdmin, asyncRoute(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    if (token) {
      const result = await igSaveToken(token); // valida via /me e salva token+igUserId+expiry
      if (!result.ok) return res.json(result);
      return res.json(result);
    }
    const result = await igTestToken(); // testa o token efetivo atual
    if (result.ok && result.igUserId && result.igUserId !== config.instagram.igUserId) {
      try { await saveOverrides({ 'instagram.igUserId': result.igUserId }); } catch { /* ignora */ }
    }
    res.json(result);
  }));

  // Desconecta a conta (limpa token/igUserId e desliga o auto-post).
  app.post('/api/instagram/disconnect', requireAdmin, asyncRoute(async (_req, res) => {
    await disconnectInstagram();
    res.json({ ok: true });
  }));

  // Devolve a URL de autorização do OAuth (o front abre numa nova aba). Requer
  // appId + publicBaseUrl configurados; o callback público finaliza a conexão.
  app.get('/api/instagram/oauth/start', requireAdmin, asyncRoute(async (_req, res) => {
    try {
      const url = await igAuthorizeUrl();
      res.json({ ok: true, url });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  }));

  // Posta AGORA uma oferta no feed do IG — ação explícita do dono (ignora
  // cadência/janela/teto via force). Bloqueia até terminar a publicação.
  app.post('/api/instagram/post-now/:offerId', requireAdmin, asyncRoute(async (req, res) => {
    const id = intParam(req.params.offerId);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    if (!config.instagram.accessToken || !config.instagram.igUserId) {
      return res.status(422).json({ error: 'Instagram não conectado — configure token e igUserId' });
    }
    const { rows } = await query('SELECT * FROM offers WHERE id = $1', [id]);
    const offer = rows[0];
    if (!offer) return res.status(404).json({ error: 'oferta não encontrada' });
    if (offer.ig_status === 'posted') return res.status(409).json({ error: 'oferta já postada no Instagram' });

    console.log(`[panel] post-now Instagram da oferta ${id}`);
    const r = await igPostOfferNow(offer); // fonte única c/ o executor (cadência + breaker)
    if (r.conflict) return res.status(409).json({ error: 'oferta já está em voo ou já postada' });
    if (!r.ok) return res.json({ ok: false, error: r.error });
    res.json({ ok: true, mediaId: r.mediaId });
  }));

  // Dispara o executor do IG AGORA (force: ignora cadência/janela/teto) — pega a
  // próxima oferta elegível e publica. Útil pra testar o pipeline pelo painel.
  app.post('/api/instagram/run-now', requireAdmin, asyncRoute(async (_req, res) => {
    if (!config.instagram.accessToken || !config.instagram.igUserId) {
      return res.status(422).json({ error: 'Instagram não conectado — configure token e igUserId' });
    }
    const r = await runInstagramExecutor({ force: true });
    res.json({ ok: Boolean(r.ok), ...r });
  }));

  // ----------------------------------------------------- whatsapp (Evolution)
  app.get('/api/whatsapp/status', requireAdmin, asyncRoute(async (_req, res) => {
    const { reachable, exists, owner } = await evoInstanceInfo();
    const state = exists ? await evoConnectionState() : null;
    res.json({ instance: config.evolution.instance, reachable, exists, state, owner });
  }));

  app.get('/api/whatsapp/instances', requireAdmin, asyncRoute(async (_req, res) => {
    const list = await evoFetch('/instance/fetchInstances');
    if (!list) return res.json({ instances: [] });
    const arr = Array.isArray(list) ? list : [list];
    const instances = arr
      .map(it => ({
        name: it.name ?? it.instance?.instanceName ?? it.instanceName ?? null,
        state: it.connectionStatus ?? it.instance?.status ?? it.instance?.state ?? 'close',
      }))
      .filter(i => i.name);
    res.json({ instances });
  }));

  // Cria a instância se não existe (mesmo body do setup-groups.js) e (re)configura
  // o webhook em ambos os casos.
  app.post('/api/whatsapp/instance', requireAdmin, asyncRoute(async (_req, res) => {
    const { reachable, exists } = await evoInstanceInfo();
    if (!reachable) {
      return res.status(502).json({ error: 'Evolution indisponível — verifique EVOLUTION_URL/EVOLUTION_APIKEY e se o serviço está no ar' });
    }
    let created = false;
    if (!exists) {
      const token = config.evolution.instance + '-' + crypto.randomBytes(4).toString('hex');
      const result = await evoFetch('/instance/create', {
        instanceName: config.evolution.instance,
        token,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      });
      if (!result) {
        return res.status(502).json({ error: 'falha ao criar a instância na Evolution — verifique EVOLUTION_URL/EVOLUTION_APIKEY' });
      }
      created = true;
      console.log(`[panel] instância "${config.evolution.instance}" criada na Evolution`);
    }
    const webhookOk = await setEvolutionWebhook();
    if (!webhookOk) {
      return res.status(502).json({ error: 'instância ok, mas falha ao configurar o webhook na Evolution' });
    }
    res.json({ ok: true, created });
  }));

  // Proxy do GET /instance/connect: devolve o QR (base64 = data URI) ou o estado.
  app.get('/api/whatsapp/qr', requireAdmin, asyncRoute(async (_req, res) => {
    const state = await evoConnectionState();
    if (state === 'open') {
      return res.json({ state: 'open', base64: null, pairingCode: null });
    }
    const conn = await evoFetch(`/instance/connect/${config.evolution.instance}`);
    if (!conn) {
      return res.status(502).json({ error: 'Evolution indisponível ou instância inexistente — crie a instância primeiro' });
    }
    // shapes v1.8.6: { pairingCode, code, base64, count } | { instance: { state } }
    res.json({
      state: conn.instance?.state ?? state ?? 'connecting',
      base64: typeof conn.base64 === 'string' ? conn.base64 : null,
      pairingCode: conn.pairingCode ?? null,
    });
  }));

  // Todos os grupos do número conectado + seleção atual (tabela groups).
  app.get('/api/whatsapp/groups', requireAdmin, asyncRoute(async (_req, res) => {
    const state = await evoConnectionState();
    if (state !== 'open') {
      return res.status(409).json({ error: `instância desconectada (state=${state ?? 'desconhecido'})` });
    }
    const all = await fetchAllGroups();
    const { rows } = await query('SELECT jid FROM groups WHERE enabled = true');
    const selected = new Set(rows.map((r) => r.jid));
    res.json({
      ok: true,
      groups: all.map((g) => ({
        jid: g.id,
        subject: g.subject,
        size: g.size,
        selected: selected.has(g.id),
      })),
    });
  }));

  // Define a seleção EXATA de grupos: upsert dos jids (enabled=true, name=subject
  // da Evolution, position=ordem) e enabled=false pros demais (sem deletar —
  // preserva o histórico de posts).
  app.post('/api/whatsapp/groups', requireAdmin, asyncRoute(async (req, res) => {
    const jids = req.body?.jids;
    if (!Array.isArray(jids) || jids.some((j) => typeof j !== 'string' || !j.trim())) {
      return res.status(400).json({ error: 'jids (array de strings) obrigatório' });
    }
    const state = await evoConnectionState();
    if (state !== 'open') {
      return res.status(409).json({ error: `instância desconectada (state=${state ?? 'desconhecido'})` });
    }
    const all = await fetchAllGroups();
    const subjects = new Map(all.map((g) => [g.id, g.subject]));

    const client = await pool.connect();
    let enabled = 0;
    let disabled = 0;
    try {
      await client.query('BEGIN');
      for (let i = 0; i < jids.length; i++) {
        const jid = jids[i].trim();
        await client.query(
          `INSERT INTO groups (jid, name, enabled, position) VALUES ($1, $2, true, $3)
           ON CONFLICT (jid) DO UPDATE
             SET name = COALESCE($2, groups.name), enabled = true, position = $3`,
          [jid, subjects.get(jid) ?? null, i]
        );
        enabled++;
      }
      const off = await client.query(
        `UPDATE groups SET enabled = false WHERE enabled = true AND NOT (jid = ANY($1::text[]))`,
        [jids.map((j) => j.trim())]
      );
      disabled = off.rowCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    console.log(`[panel] seleção de grupos: ${enabled} habilitado(s), ${disabled} desabilitado(s)`);
    res.json({ ok: true, enabled, disabled });
  }));

  // Cria N grupos espelho (announcement = só admins postam) — porta o
  // scripts/setup-groups.js pro painel. Requer número do dono + instância conectada.
  app.post('/api/whatsapp/groups/create', requireAdmin, asyncRoute(async (req, res) => {
    const prefix = String(req.body?.prefix || 'Achadinhos Fitness').trim() || 'Achadinhos Fitness';
    const n = Math.min(Math.max(intParam(req.body?.n) ?? 5, 1), 20);
    if (!config.evolution.ownerJid) {
      return res.status(422).json({ error: 'salve o número do dono (card WhatsApp) antes de criar grupos — ele entra nos grupos' });
    }
    const state = await evoConnectionState();
    if (state !== 'open') {
      return res.status(409).json({ error: `instância desconectada (state=${state ?? '?'}) — conecte o WhatsApp primeiro` });
    }
    const ownerNumber = config.evolution.ownerJid.replace(/@s\.whatsapp\.net$/, '');
    const created = [];
    for (let i = 1; i <= n; i++) {
      const subject = `${prefix} #${i}`;
      const existing = await query('SELECT jid FROM groups WHERE name = $1', [subject]);
      if (existing.rows.length) { created.push({ subject, jid: existing.rows[0].jid, skipped: true }); continue; }

      const r = await evoFetch(`/group/create/${config.evolution.instance}`, { subject, participants: [ownerNumber] });
      const jid = r?.id ?? r?.groupJid ?? r?.group?.id ?? null;
      if (!jid) { created.push({ subject, error: true }); continue; }

      await query(
        `INSERT INTO groups (jid, name, enabled, position) VALUES ($1, $2, true, $3)
         ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name, enabled = true, position = EXCLUDED.position`,
        [jid, subject, i - 1]
      );
      // announcement (só admins postam → menos denúncia). PUT direto (evoFetch não faz PUT).
      try {
        await fetch(`${config.evolution.url}/group/updateSetting/${config.evolution.instance}?groupJid=${encodeURIComponent(jid)}`, {
          method: 'PUT',
          headers: { apikey: config.evolution.apikey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupJid: jid, action: 'announcement' }),
        });
      } catch { /* não-fatal: grupo já criado */ }
      created.push({ subject, jid });
      await new Promise((r2) => setTimeout(r2, 1500)); // espaçamento entre criações
    }
    const novos = created.filter((g) => g.jid && !g.skipped).length;
    console.log(`[panel] criar grupos via painel: ${novos} novo(s), ${created.filter((g) => g.skipped).length} já existiam`);
    res.json({ ok: true, created, novos });
  }));

  // -------------------------------------------------- telegram (login guiado)
  app.get('/api/telegram/status', requireAdmin, asyncRoute(async (_req, res) => {
    res.json(await telegramStatus());
  }));

  app.post('/api/telegram/start-login', requireAdmin, asyncRoute(async (req, res) => {
    const { apiId, apiHash, phone } = req.body ?? {};
    try {
      // beginLogin valida apiId/apiHash/phone ANTES de qualquer persistência:
      // requisição que falha com 400 não pode deixar override no banco (um
      // apiHash vazio sombrearia o TELEGRAM_API_HASH do .env no próximo boot).
      await beginLogin({ apiId, apiHash, phone });
      // apiId/apiHash viram override já aqui (antes do confirm-code) —
      // necessários p/ retomar o monitor depois.
      await saveOverrides({ 'telegram.apiId': apiId, 'telegram.apiHash': apiHash });
      res.json({ ok: true, needCode: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  app.post('/api/telegram/confirm-code', requireAdmin, asyncRoute(async (req, res) => {
    const { code, password } = req.body ?? {};
    let result;
    try {
      result = await confirmLogin({ code, password });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (result.needPassword) {
      return res.json({ ok: false, needPassword: true });
    }
    // sessão vira override e o monitor sobe em runtime (sem restart)
    await saveOverrides({ 'telegram.session': result.session });
    await startTelegramMonitor(); // nunca lança; loga falhas
    res.json({ ok: true, connected: true });
  }));

  app.post('/api/telegram/disconnect', requireAdmin, asyncRoute(async (_req, res) => {
    await stopTelegramMonitor();
    // override vazio (e não DELETE): com TELEGRAM_SESSION ainda no .env, apagar
    // a row faria o .env reconectar no próximo boot — '' persiste o desconectar.
    await saveOverrides({ 'telegram.session': '' });
    console.log('[panel] telegram desconectado e sessão limpa');
    res.json({ ok: true });
  }));

  console.log('[panel] rotas /api/* do painel registradas');
}
