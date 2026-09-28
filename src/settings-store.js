// [settings] Overrides de configuração persistidos no banco (tabela settings,
// uma row por chave com prefixo 'cfg.'). Precedência: DB override > .env > default.
// Aplicação em RUNTIME: muta as propriedades do objeto `config` (ESM live object)
// — todos os módulos leem config.X.Y na hora da chamada, então nada reinicia.
// NUNCA logar valores: segredos (appSecret, session, apiHash) passam por aqui.

import { config, range, window_ } from './config.js';
import { pool, query } from './db.js';
import { isMonitorRunning } from './telegram.js';

const PREFIX = 'cfg.';

/* ------------------------------ parsers/validators ------------------------ */
// Cada parser recebe o valor cru (do PUT ou da row do banco) e retorna
// { value, stored }: `value` é o que vai pro objeto config em memória,
// `stored` é a string normalizada gravada em settings. Inválido → throw com
// mensagem clara (saveOverrides valida TUDO antes de gravar qualquer coisa).

function asString(raw, label) {
  if (raw == null) return '';
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error(`${label}: valor deve ser texto`);
  }
  return String(raw).trim();
}

function parseString(label, { allowEmpty = true, re = null, reMsg = '' } = {}) {
  return (raw) => {
    const s = asString(raw, label);
    if (!s && !allowEmpty) throw new Error(`${label}: não pode ser vazio`);
    if (s && re && !re.test(s)) throw new Error(`${label}: ${reMsg}`);
    return { value: s, stored: s };
  };
}

function parseBool(label) {
  return (raw) => {
    const v = typeof raw === 'boolean' ? raw : asString(raw, label).toLowerCase();
    if (v === true || v === 'true') return { value: true, stored: 'true' };
    if (v === false || v === 'false' || v === '') return { value: false, stored: 'false' };
    throw new Error(`${label}: use true ou false`);
  };
}

function parseUrl(label) {
  return (raw) => {
    const s = asString(raw, label).replace(/\/$/, '');
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`${label}: URL inválida`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`${label}: a URL deve ser http(s)`);
    }
    return { value: s, stored: s };
  };
}

function parseEnum(label, allowed) {
  return (raw) => {
    const s = asString(raw, label);
    if (!allowed.includes(s)) throw new Error(`${label}: use um de ${allowed.join(', ')}`);
    return { value: s, stored: s };
  };
}

function parseNumber(label, { integer = false, min = 0, max = null } = {}) {
  return (raw) => {
    const s = typeof raw === 'number' ? raw : asString(raw, label);
    if (s === '') throw new Error(`${label}: número obrigatório`);
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`${label}: número inválido`);
    if (integer && !Number.isInteger(n)) throw new Error(`${label}: deve ser inteiro`);
    if (n < min) throw new Error(`${label}: deve ser >= ${min}`);
    if (max != null && n > max) throw new Error(`${label}: deve ser <= ${max}`);
    return { value: n, stored: String(n) };
  };
}

// 'HH:MM-HH:MM' → objeto window {startH,startM,endH,endM} (reusa o parser do
// config.js). Factory: usado tanto pela janela de postagem quanto pela de disparos.
function windowParser(label) {
  return (raw) => {
    const s = asString(raw, label);
    const w = window_(s, null);
    if (!w) throw new Error(`${label}: formato HH:MM-HH:MM (ex.: 08:00-22:00)`);
    if (w.startH > 23 || w.endH > 23 || w.startM > 59 || w.endM > 59) {
      throw new Error(`${label}: hora/minuto fora do intervalo (00:00-23:59)`);
    }
    if (w.startH * 60 + w.startM >= w.endH * 60 + w.endM) {
      throw new Error(`${label}: o início deve ser antes do fim`);
    }
    const pad = (n) => String(n).padStart(2, '0');
    return { value: w, stored: `${pad(w.startH)}:${pad(w.startM)}-${pad(w.endH)}:${pad(w.endM)}` };
  };
}

// CSV de 1+ inteiros > 0 → array. Factory: ramp de posts/dia (grupos) E o
// teto/dia dos disparos (broadcast.dailyRamp). 1 valor = fixo; vários = aquece.
function rampParser(label) {
  return (raw) => {
    const s = asString(raw, label);
    const parts = s.split(',').map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length === 0) throw new Error(`${label}: informe 1+ inteiros separados por vírgula (ex.: 4,8,12)`);
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(`${label}: todos os valores devem ser inteiros > 0`);
    }
    return { value: nums, stored: nums.join(',') };
  };
}

// CSV de horas inteiras 0-23 → array ordenado/dedup (horários fixos de pico).
function parseHourList(label) {
  return (raw) => {
    const s = asString(raw, label);
    const parts = s.split(',').map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length === 0) throw new Error(`${label}: informe 1+ horas (0-23) por vírgula (ex.: 12,19,21)`);
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 23)) {
      throw new Error(`${label}: horas devem ser inteiros entre 0 e 23`);
    }
    const uniq = [...new Set(nums)].sort((a, b) => a - b);
    return { value: uniq, stored: uniq.join(',') };
  };
}

// 'min-max' inteiros → par [min, max] (groupSpacingMs/sendDelayMs)
function parseMsRange(label) {
  return (raw) => {
    const s = asString(raw, label);
    const pair = range(s, null);
    if (!pair) throw new Error(`${label}: formato min-max em ms (ex.: 60000-180000)`);
    const [min, max] = pair;
    if (min > max) throw new Error(`${label}: min não pode ser maior que max`);
    return { value: [min, max], stored: `${min}-${max}` };
  };
}

// link do canal: vazio é VÁLIDO (desliga a semeadura); se preenchido, http(s)
function parseChannelUrl(raw) {
  const s = asString(raw, 'channel.url').replace(/\/$/, '');
  if (!s) return { value: '', stored: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('channel.url: URL inválida (ex.: https://whatsapp.com/channel/XXXX)');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('channel.url: a URL deve ser http(s)');
  }
  return { value: s, stored: s };
}

// variantes de mensagem do broadcast: aceita array (do painel) ou string
// separada por '|||'. Armazena unido por '|||'.
function parseMessages(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw.map((x) => String(x).trim()).filter(Boolean);
  else arr = asString(raw, 'broadcast.messages').split(/\|\|\|/).map((x) => x.trim()).filter(Boolean);
  return { value: arr, stored: arr.join('|||') };
}

// vários links de convite (vírgula ou quebra de linha) → array. Armazena por vírgula.
function parseLinks(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw.map((x) => String(x).trim()).filter(Boolean);
  else arr = asString(raw, 'broadcast.inviteLinks').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return { value: arr, stored: arr.join(',') };
}

// denylist: 1 termo por linha (ou vírgula) → array minúsculo deduplicado.
function parseDenylist(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else arr = asString(raw, 'content.denylist').split(/[\n,]+/);
  const norm = [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  return { value: norm, stored: norm.join('\n') };
}

// templates de copy: 1 por linha (com {titulo}) → array. Vazio = usa os embutidos.
function parseTemplates(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw.map((x) => String(x).trim()).filter(Boolean);
  else arr = asString(raw, 'content.templates').split('\n').map((x) => x.trim()).filter(Boolean);
  return { value: arr, stored: arr.join('\n') };
}

// CTAs: 1 por linha → array. Vazio = usa as embutidas (CTA_DEFAULTS em copy.js).
function parseCtas(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw.map((x) => String(x).trim()).filter(Boolean);
  else arr = asString(raw, 'content.ctas').split('\n').map((x) => x.trim()).filter(Boolean);
  return { value: arr, stored: arr.join('\n') };
}

// número puro → acrescenta @s.whatsapp.net; valida o formato final
function parseOwnerJid(raw) {
  let s = asString(raw, 'evolution.ownerJid');
  if (/^\d+$/.test(s)) s = `${s}@s.whatsapp.net`;
  if (s && !/^\d{8,15}@s\.whatsapp\.net$/.test(s)) {
    throw new Error('evolution.ownerJid: use DDI+DDD+número (ex.: 5519999999999) ou jid terminando em @s.whatsapp.net');
  }
  return { value: s, stored: s };
}

/* -------------------------- mapa de chaves overridáveis ------------------- */
// chave pontuada (igual ao contrato do PUT /api/config) → { path no objeto
// config, parse }. operation.* mapeia para config.posting/config.ranking.

export const OVERRIDABLE = {
  'shopee.appId': { path: ['shopee', 'appId'], parse: parseString('shopee.appId') },
  'shopee.appSecret': { path: ['shopee', 'appSecret'], parse: parseString('shopee.appSecret') },

  'meli.autoLinks': { path: ['meli', 'autoLinks'], parse: parseBool('meli.autoLinks') },
  'meli.mattWord': { path: ['meli', 'mattWord'], parse: parseString('meli.mattWord') },
  'meli.mattTool': { path: ['meli', 'mattTool'], parse: parseString('meli.mattTool') },
  // sessão do portal de afiliados ML (createLink). cookie é SEGREDO (guard de
  // vazio no PUT, igual aos outros); aceita '' aqui só pra permitir "desconectar".
  'meli.cookie': { path: ['meli', 'cookie'], parse: parseString('meli.cookie') },
  'meli.csrf': { path: ['meli', 'csrf'], parse: parseString('meli.csrf') },
  'meli.tag': { path: ['meli', 'tag'], parse: parseString('meli.tag') },

  'amazon.tag': { path: ['amazon', 'tag'], parse: parseString('amazon.tag') },

  'aliexpress.appKey': { path: ['aliexpress', 'appKey'], parse: parseString('aliexpress.appKey') },
  'aliexpress.appSecret': { path: ['aliexpress', 'appSecret'], parse: parseString('aliexpress.appSecret', { allowEmpty: false }) },
  'aliexpress.trackingId': { path: ['aliexpress', 'trackingId'], parse: parseString('aliexpress.trackingId') },

  'evolution.instance': {
    path: ['evolution', 'instance'],
    parse: parseString('evolution.instance', {
      allowEmpty: false,
      re: /^[a-zA-Z0-9_-]+$/,
      reMsg: 'use apenas letras, números, hífen e underscore (slug)',
    }),
  },
  'evolution.ownerJid': { path: ['evolution', 'ownerJid'], parse: parseOwnerJid },

  'channel.url': { path: ['channel', 'url'], parse: parseChannelUrl },
  'channel.inviteText': { path: ['channel', 'inviteText'], parse: parseString('channel.inviteText') },
  'channel.seedEveryHours': { path: ['channel', 'seedEveryHours'], parse: parseNumber('channel.seedEveryHours', { integer: true, min: 1 }) },

  'broadcast.instance': { path: ['broadcast', 'instance'], parse: parseString('broadcast.instance', { re: /^[a-zA-Z0-9_-]*$/, reMsg: 'slug (letras/números/hífen/underscore) ou vazio' }) },
  'broadcast.instances': { path: ['broadcast', 'instances'], parse: (v) => {
    const arr = Array.isArray(v) ? v : [];
    const slugs = arr.map(s => String(s).trim()).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));
    return { ok: true, value: slugs };
  } },
  'broadcast.inviteLink': { path: ['broadcast', 'inviteLink'], parse: parseString('broadcast.inviteLink') },
  'broadcast.inviteLinks': { path: ['broadcast', 'inviteLinks'], parse: parseLinks },
  'broadcast.messages': { path: ['broadcast', 'messages'], parse: parseMessages },
  // teto de disparos/dia (1 valor = fixo; vários = aquecimento por semana),
  // espaçamento anti-ban (min-max em ms) e janela de horário — editáveis no painel.
  'broadcast.dailyRamp': { path: ['broadcast', 'dailyRamp'], parse: rampParser('broadcast.dailyRamp') },
  'broadcast.spacingMs': { path: ['broadcast', 'spacingMs'], parse: parseMsRange('broadcast.spacingMs') },
  'broadcast.window': { path: ['broadcast', 'window'], parse: windowParser('broadcast.window') },
  // boas-vindas ao entrar / feedback ao sair do grupo via DM (kill-switch + textos).
  'broadcast.groupDmEnabled': { path: ['broadcast', 'groupDmEnabled'], parse: parseBool('broadcast.groupDmEnabled') },
  'broadcast.welcomeText': { path: ['broadcast', 'welcomeText'], parse: parseString('broadcast.welcomeText') },
  'broadcast.exitFeedbackText': { path: ['broadcast', 'exitFeedbackText'], parse: parseString('broadcast.exitFeedbackText') },

  'telegram.apiId': { path: ['telegram', 'apiId'], parse: parseNumber('telegram.apiId', { integer: true, min: 1 }) },
  // allowEmpty:false — apiHash '' nunca é um override útil (sombrearia um
  // TELEGRAM_API_HASH válido do .env). session aceita '' de propósito
  // (é como o "desconectar" do painel persiste o logout).
  'telegram.apiHash': { path: ['telegram', 'apiHash'], parse: parseString('telegram.apiHash', { allowEmpty: false }) },
  'telegram.session': { path: ['telegram', 'session'], parse: parseString('telegram.session') },

  'ollama.url': { path: ['ollama', 'url'], parse: parseUrl('ollama.url') },
  'ollama.model': { path: ['ollama', 'model'], parse: parseString('ollama.model', { allowEmpty: false }) },

  'copy.provider': { path: ['copy', 'provider'], parse: parseEnum('copy.provider', ['ollama', 'anthropic', 'openai']) },
  // SEGREDO: allowEmpty:false — string vazia/só-espaços NÃO sobrescreve a chave
  // existente (mesmo tratamento do shopee.appSecret no guard do PUT). Nunca exposto.
  'copy.anthropicApiKey': { path: ['copy', 'anthropic', 'apiKey'], parse: parseString('copy.anthropicApiKey', { allowEmpty: false }) },
  'copy.anthropicModel': { path: ['copy', 'anthropic', 'model'], parse: parseString('copy.anthropicModel', { allowEmpty: false }) },
  'copy.openaiApiKey': { path: ['copy', 'openai', 'apiKey'], parse: parseString('copy.openaiApiKey', { allowEmpty: false }) },
  'copy.openaiModel': { path: ['copy', 'openai', 'model'], parse: parseString('copy.openaiModel', { allowEmpty: false }) },
  // instrução de estilo extra anexada ao prompt da IA (vazio = nada)
  'copy.styleExtra': { path: ['copy', 'styleExtra'], parse: parseString('copy.styleExtra') },
  // persona/tom base do redator (vazio = padrão embutido) e modelo do auto-reply
  // (vazio = herda copy.openai.model). Nenhum é segredo.
  'copy.persona': { path: ['copy', 'persona'], parse: parseString('copy.persona') },
  'copy.replyModel': { path: ['copy', 'replyModel'], parse: parseString('copy.replyModel') },

  // conteúdo: termos bloqueados no sourcing, rodapé e linha de publicidade da
  // mensagem de grupo, e templates de copy de fallback — tudo editável no painel.
  'content.denylist': { path: ['content', 'denylist'], parse: parseDenylist },
  'content.disclosure': { path: ['content', 'disclosure'], parse: parseString('content.disclosure') },
  'content.footer': { path: ['content', 'footer'], parse: parseString('content.footer') },
  'content.templates': { path: ['content', 'templates'], parse: parseTemplates },
  // penaltylist (afunda no score, não exclui) e CTAs rotacionadas — editáveis no painel.
  'content.penaltylist': { path: ['content', 'penaltylist'], parse: parseDenylist },
  'content.ctas': { path: ['content', 'ctas'], parse: parseCtas },

  // Instagram (auto-post das ofertas). accessToken/appSecret são SEGREDOS
  // (allowEmpty:false — '' não sobrescreve o valor do .env). igUserId é numérico
  // (guarda como string p/ não perder precisão). publicBaseUrl valida http(s).
  'instagram.enabled': { path: ['instagram', 'enabled'], parse: parseBool('instagram.enabled') },
  'instagram.igUserId': { path: ['instagram', 'igUserId'], parse: parseString('instagram.igUserId', { re: /^\d*$/, reMsg: 'use apenas dígitos (IG User ID)' }) },
  'instagram.accessToken': { path: ['instagram', 'accessToken'], parse: parseString('instagram.accessToken', { allowEmpty: false }) },
  'instagram.appId': { path: ['instagram', 'appId'], parse: parseString('instagram.appId') },
  'instagram.appSecret': { path: ['instagram', 'appSecret'], parse: parseString('instagram.appSecret', { allowEmpty: false }) },
  'instagram.publicBaseUrl': { path: ['instagram', 'publicBaseUrl'], parse: parseUrl('instagram.publicBaseUrl') },
  'instagram.proxyImages': { path: ['instagram', 'proxyImages'], parse: parseBool('instagram.proxyImages') },
  'instagram.caption': { path: ['instagram', 'caption'], parse: parseString('instagram.caption') },
  'instagram.hashtags': { path: ['instagram', 'hashtags'], parse: parseString('instagram.hashtags') },
  'instagram.postEveryHours': { path: ['instagram', 'postEveryHours'], parse: parseNumber('instagram.postEveryHours', { integer: true, min: 1 }) },
  // teto oficial da Content Publishing API do Instagram: 25 posts/24h por conta
  // (janela corrente da Meta). Acima disso a API rejeita com "(#4) Application
  // request limit reached" — trava aqui pra nunca deixar configurar acima.
  'instagram.dailyCap': { path: ['instagram', 'dailyCap'], parse: parseNumber('instagram.dailyCap', { integer: true, min: 1, max: 25 }) },
  'instagram.minScore': { path: ['instagram', 'minScore'], parse: parseNumber('instagram.minScore') },

  // Try-on: gera a foto do produto vestida no avatar via IA (OpenAI). Toggle liga/desliga sem reiniciar.
  'tryon.enabled': { path: ['tryon', 'enabled'], parse: parseBool('tryon.enabled') },

  'operation.postingWindow': { path: ['posting', 'window'], parse: windowParser('operation.postingWindow') },
  'operation.ramp': { path: ['posting', 'ramp'], parse: rampParser('operation.ramp') },
  'operation.peakHours': { path: ['posting', 'peakHours'], parse: parseHourList('operation.peakHours') },
  'operation.groupSpacingMs': { path: ['posting', 'groupSpacingMs'], parse: parseMsRange('operation.groupSpacingMs') },
  'operation.sendDelayMs': { path: ['posting', 'sendDelayMs'], parse: parseMsRange('operation.sendDelayMs') },
  'operation.dedupDays': { path: ['posting', 'dedupDays'], parse: parseNumber('operation.dedupDays', { integer: true }) },
  'operation.offerTtlHours': { path: ['posting', 'offerTtlHours'], parse: parseNumber('operation.offerTtlHours', { integer: true }) },

  // minRating/minScore têm teto real (escala 0-5 e 0-100 do score) — acima disso
  // TODA oferta reprova no filtro pra sempre, esvaziando a fila em silêncio.
  'operation.minCommission': { path: ['ranking', 'minCommission'], parse: parseNumber('operation.minCommission', { max: 1 }) },
  'operation.minDiscount': { path: ['ranking', 'minDiscount'], parse: parseNumber('operation.minDiscount', { max: 100 }) },
  'operation.minSales': { path: ['ranking', 'minSales'], parse: parseNumber('operation.minSales') },
  'operation.minRating': { path: ['ranking', 'minRating'], parse: parseNumber('operation.minRating', { max: 5 }) },
  'operation.minScore': { path: ['ranking', 'minScore'], parse: parseNumber('operation.minScore', { max: 100 }) },

  // mix de categorias (frações-alvo da rotação) e pesos do score — editáveis no
  // painel. Todos são frações 0-1 (o painel já trava em max=1); sem o teto aqui,
  // um PUT direto (ou bug futuro na UI) inverte a lógica (ex.: penaltyMult > 1
  // PROMOVE em vez de afundar produto denylistado).
  'operation.mixVestuario': { path: ['ranking', 'categoryMix', 'vestuario'], parse: parseNumber('operation.mixVestuario', { max: 1 }) },
  'operation.mixAcessorios': { path: ['ranking', 'categoryMix', 'acessorios'], parse: parseNumber('operation.mixAcessorios', { max: 1 }) },
  'operation.mixSuplementos': { path: ['ranking', 'categoryMix', 'suplementos'], parse: parseNumber('operation.mixSuplementos', { max: 1 }) },
  'operation.weightCommission': { path: ['ranking', 'weights', 'commission'], parse: parseNumber('operation.weightCommission', { max: 1 }) },
  'operation.weightDiscount': { path: ['ranking', 'weights', 'discount'], parse: parseNumber('operation.weightDiscount', { max: 1 }) },
  'operation.weightPopularity': { path: ['ranking', 'weights', 'popularity'], parse: parseNumber('operation.weightPopularity', { max: 1 }) },
  // penalidade de produto genérico (penaltylist) e de falta de prova social.
  'operation.penaltyMult': { path: ['ranking', 'penaltyMult'], parse: parseNumber('operation.penaltyMult', { max: 1 }) },
  'operation.noReviewMult': { path: ['ranking', 'noReviewMult'], parse: parseNumber('operation.noReviewMult', { max: 1 }) },
  'operation.noSalesMult': { path: ['ranking', 'noSalesMult'], parse: parseNumber('operation.noSalesMult', { max: 1 }) },
};

function applyToConfig(path, value) {
  let target = config;
  for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
  target[path[path.length - 1]] = value;
}

/* --------------------------------- exports -------------------------------- */

/**
 * Lê os overrides (settings WHERE key LIKE 'cfg.%') e aplica mutando o objeto
 * config. Chamado no boot, logo após migrate(). Row inválida/desconhecida é
 * ignorada com log (nunca derruba o boot). Retorna o nº de overrides aplicados.
 */
export async function loadOverrides() {
  let rows;
  try {
    ({ rows } = await query(`SELECT key, value FROM settings WHERE key LIKE 'cfg.%'`));
  } catch (err) {
    console.log(`[settings] erro ao carregar overrides: ${err.message}`);
    return 0;
  }
  let applied = 0;
  for (const row of rows) {
    const key = row.key.slice(PREFIX.length);
    const def = OVERRIDABLE[key];
    if (!def) {
      console.log(`[settings] override desconhecido ignorado: ${row.key}`);
      continue;
    }
    try {
      const { value } = def.parse(row.value ?? '');
      applyToConfig(def.path, value);
      applied++;
    } catch (err) {
      console.log(`[settings] override inválido ignorado (${row.key}): ${err.message}`);
    }
  }
  if (applied > 0) console.log(`[settings] ${applied} override(s) carregado(s) do banco`);
  return applied;
}

/**
 * Valida e persiste overrides. `flat` = objeto { 'shopee.appId': '...', ... }
 * com chaves pontuadas do mapa OVERRIDABLE. Validação TUDO-OU-NADA: qualquer
 * valor inválido → throw com mensagem clara e NADA é salvo. Grava em transação
 * (BEGIN/COMMIT no mesmo client do pool) e só então aplica em memória.
 * Retorna a lista de chaves aplicadas.
 */
export async function saveOverrides(flat) {
  const entries = Object.entries(flat ?? {});
  if (entries.length === 0) return [];

  // 1. valida tudo antes de tocar no banco
  const prepared = [];
  for (const [key, raw] of entries) {
    const def = OVERRIDABLE[key];
    if (!def) throw new Error(`chave de configuração desconhecida: ${key}`);
    const { value, stored } = def.parse(raw); // throw → nada salvo
    prepared.push({ key, def, value, stored });
  }

  // 2. grava em transação (mesmo client do pool)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of prepared) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [PREFIX + p.key, p.stored]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 3. aplica em memória (config é live object — módulos leem na hora da chamada)
  for (const p of prepared) applyToConfig(p.def.path, p.value);
  console.log(`[settings] override(s) salvos e aplicados: ${prepared.map((p) => p.key).join(', ')}`);
  return prepared.map((p) => p.key);
}

/**
 * Shape do GET /api/config — segredos NUNCA inteiros: só *Set boolean e, no
 * appSecret, os últimos 4 caracteres. `channels` (contagem async) vem do caller.
 */
export function maskedConfig({ channels = 0 } = {}) {
  const w = config.posting.window;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    shopee: {
      appId: config.shopee.appId,
      appSecretSet: Boolean(config.shopee.appSecret),
      appSecretLast4: config.shopee.appSecret ? String(config.shopee.appSecret).slice(-4) : null,
    },
    meli: {
      autoLinks: config.meli.autoLinks,
      mattWord: config.meli.mattWord,
      mattTool: config.meli.mattTool,
      tag: config.meli.tag,
      cookieSet: Boolean(config.meli.cookie),
      csrfSet: Boolean(config.meli.csrf),
    },
    amazon: {
      tag: config.amazon.tag,
    },
    aliexpress: {
      appKey: config.aliexpress.appKey,
      trackingId: config.aliexpress.trackingId,
      appSecretSet: Boolean(config.aliexpress.appSecret),
      appSecretLast4: config.aliexpress.appSecret ? String(config.aliexpress.appSecret).slice(-4) : null,
    },
    evolution: {
      url: config.evolution.url, // só leitura (vem do .env)
      instance: config.evolution.instance,
      ownerJid: config.evolution.ownerJid,
      apikeySet: Boolean(config.evolution.apikey),
    },
    channel: {
      url: config.channel.url,
      inviteText: config.channel.inviteText,
      seedEveryHours: config.channel.seedEveryHours,
    },
    broadcast: {
      instance: config.broadcast.instance,
      instances: config.broadcast.instances,
      inviteLink: config.broadcast.inviteLink,
      inviteLinks: config.broadcast.inviteLinks,
      messages: config.broadcast.messages,
      dailyRamp: config.broadcast.dailyRamp.join(','),
      spacingMs: config.broadcast.spacingMs.join('-'),
      window: (() => { const b = config.broadcast.window; return `${pad(b.startH)}:${pad(b.startM)}-${pad(b.endH)}:${pad(b.endM)}`; })(),
      groupDmEnabled: config.broadcast.groupDmEnabled,
      welcomeText: config.broadcast.welcomeText,
      exitFeedbackText: config.broadcast.exitFeedbackText,
    },
    telegram: {
      apiIdSet: Boolean(config.telegram.apiId),
      apiHashSet: Boolean(config.telegram.apiHash),
      sessionSet: Boolean(config.telegram.session),
      monitorRunning: isMonitorRunning(),
      channels,
    },
    ollama: {
      url: config.ollama.url,
      model: config.ollama.model,
    },
    copy: {
      provider: config.copy.provider,
      styleExtra: config.copy.styleExtra,
      persona: config.copy.persona,
      replyModel: config.copy.replyModel,
      anthropicModel: config.copy.anthropic.model,
      anthropicKeySet: Boolean(config.copy.anthropic.apiKey),
      anthropicKeyLast4: config.copy.anthropic.apiKey ? String(config.copy.anthropic.apiKey).slice(-4) : null,
      openaiModel: config.copy.openai.model,
      openaiKeySet: Boolean(config.copy.openai.apiKey),
      openaiKeyLast4: config.copy.openai.apiKey ? String(config.copy.openai.apiKey).slice(-4) : null,
    },
    content: {
      disclosure: config.content.disclosure,
      footer: config.content.footer,
      denylist: config.content.denylist.join('\n'),
      templates: config.content.templates.join('\n'),
      penaltylist: config.content.penaltylist.join('\n'),
      ctas: config.content.ctas.join('\n'),
    },
    instagram: {
      enabled: config.instagram.enabled,
      igUserId: config.instagram.igUserId,
      appId: config.instagram.appId,
      publicBaseUrl: config.instagram.publicBaseUrl,
      proxyImages: config.instagram.proxyImages,
      caption: config.instagram.caption,
      hashtags: config.instagram.hashtags,
      postEveryHours: config.instagram.postEveryHours,
      dailyCap: config.instagram.dailyCap,
      minScore: config.instagram.minScore,
      accessTokenSet: Boolean(config.instagram.accessToken),
      accessTokenLast4: config.instagram.accessToken ? String(config.instagram.accessToken).slice(-4) : null,
      appSecretSet: Boolean(config.instagram.appSecret),
    },
    tryon: {
      enabled: config.tryon.enabled,
    },
    operation: {
      postingWindow: `${pad(w.startH)}:${pad(w.startM)}-${pad(w.endH)}:${pad(w.endM)}`,
      ramp: config.posting.ramp.join(','),
      peakHours: config.posting.peakHours.join(','),
      groupSpacingMs: config.posting.groupSpacingMs.join('-'),
      sendDelayMs: config.posting.sendDelayMs.join('-'),
      dedupDays: config.posting.dedupDays,
      offerTtlHours: config.posting.offerTtlHours,
      minCommission: config.ranking.minCommission,
      minDiscount: config.ranking.minDiscount,
      minSales: config.ranking.minSales,
      minRating: config.ranking.minRating,
      minScore: config.ranking.minScore,
      mixVestuario: config.ranking.categoryMix.vestuario,
      mixAcessorios: config.ranking.categoryMix.acessorios,
      mixSuplementos: config.ranking.categoryMix.suplementos,
      weightCommission: config.ranking.weights.commission,
      weightDiscount: config.ranking.weights.discount,
      weightPopularity: config.ranking.weights.popularity,
      penaltyMult: config.ranking.penaltyMult,
      noReviewMult: config.ranking.noReviewMult,
      noSalesMult: config.ranking.noSalesMult,
    },
  };
}
