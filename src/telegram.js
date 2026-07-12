// [telegram] Monitor GramJS de canais públicos de ofertas.
// Escuta NewMessage dos canais cadastrados em telegram_channels (enabled),
// extrai URLs das mensagens e converte em ofertas:
//   - Shopee: parseShopeeUrl → shopee.offerByItemId → upsertOffer(source='telegram').
//     O offerLink retornado pela API já vem com a NOSSA tag de afiliado — vantagem chave.
//   - Mercado Livre: só se config.meli.autoLinks; dados básicos extraídos do texto
//     (título = primeira linha sem emojis; preço = menor valor "R$ ..." do texto).
// Resiliente: try/catch por mensagem; reconexão fica por conta do GramJS.
// Paths de import verificados no pacote instalado (telegram@2.26.x, CJS sem "exports"):
//   telegram (index.js), telegram/sessions/index.js, telegram/events/index.js.

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { computeCheck } from 'telegram/Password.js';

import { config } from './config.js';
import { query } from './db.js';
import { offerByItemId } from './shopee.js';
import { resolveAffiliateUrl } from './meli.js';
import { buildAffiliateUrl as buildAmazonUrl } from './amazon.js';
import { generateAffiliateLink as generateAliexpressLink } from './aliexpress.js';
import { upsertOffer } from './ranking.js';
import {
  extractUrls,
  expandUrl,
  parseShopeeUrl,
  parseMeliUrl,
  parseAmazonUrl,
  parseAliexpressUrl,
  isShopeeUrl,
  isMeliUrl,
  isAmazonUrl,
  isAliexpressUrl,
} from './links.js';
import { notifyOwnerOnce } from './poster.js';

const SOURCE_COPY_MAX = 600;

let client = null;
// Usernames (lowercase, sem @) dos canais monitorados — atualizado em runtime por addChannel().
const watched = new Set();

// Login guiado (painel): estado do login pendente em memória do processo
// (single-process). { client, apiId, apiHash, phone, phoneCodeHash } ou null.
let pendingLogin = null;

/* ----------------------------- helpers puros ----------------------------- */

function cleanUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

// Primeira linha não-vazia do texto, sem emojis/variation selectors.
function titleFromText(text) {
  const firstLine = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  const title = firstLine
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title || null;
}

// '1.299,90' → 1299.9 · '47,90' → 47.9 · '47.90' → 47.9 · '1.299' → 1299
function parseBrNumber(raw) {
  let s = String(raw).trim().replace(/[.,]+$/, '');
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) {
    s = s.replace(/\./g, ''); // pontos de milhar
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Todos os valores "R$ ..." encontrados no texto (em Number).
function pricesFromText(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/R\$\s*([\d.,]+)/gi)) {
    const v = parseBrNumber(m[1]);
    if (v > 0) out.push(v);
  }
  return out;
}

/* --------------------------- handlers por URL ---------------------------- */

async function handleShopeeUrl(url, text) {
  let finalUrl = url;
  let parsed = parseShopeeUrl(finalUrl);
  if (!parsed) {
    // encurtador (shope.ee etc.) → expande e tenta de novo
    finalUrl = await expandUrl(finalUrl);
    parsed = parseShopeeUrl(finalUrl);
  }
  if (!parsed) {
    console.log(`[telegram] URL Shopee sem itemId reconhecível: ${url}`);
    return;
  }

  const offer = await offerByItemId(parsed.itemId, parsed.shopId);
  if (!offer) {
    console.log(`[telegram] oferta Shopee não encontrada na API (itemId=${parsed.itemId})`);
    return;
  }

  const row = await upsertOffer(offer, {
    marketplace: 'shopee',
    source: 'telegram',
    sourceCopy: String(text || '').slice(0, SOURCE_COPY_MAX),
  });
  if (row) {
    console.log(`[telegram] oferta shopee capturada: #${row.id} "${row.title}" score=${row.score}`);
  }
}

async function handleMeliUrl(url, text) {
  let finalUrl = url;
  let parsed = parseMeliUrl(finalUrl);
  if (!parsed || parsed.short) {
    // link curto /sec/ (ou irreconhecível) → expande e tenta de novo
    finalUrl = await expandUrl(finalUrl);
    parsed = parseMeliUrl(finalUrl);
  }
  if (!parsed?.mlbId) {
    console.log(`[telegram] URL Meli sem id MLB reconhecível: ${url}`);
    return;
  }

  // createLink oficial (cookie de sessão) primeiro; fallback matt_word/tool.
  const affiliateUrl = await resolveAffiliateUrl(finalUrl);
  if (!affiliateUrl) {
    console.log(`[telegram] ML sem caminho de afiliado (sem sessão e sem matt_word/tool) — ignorado: ${url}`);
    return;
  }

  const title = titleFromText(text);
  const prices = pricesFromText(text);
  if (!title || prices.length === 0) {
    console.log(`[telegram] mensagem Meli sem título/preço extraível — ignorada (${parsed.mlbId})`);
    return;
  }

  const price = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceFrom = maxPrice > price ? maxPrice : null;
  const discountPct = priceFrom ? Math.round((1 - price / priceFrom) * 100) : 0;

  const row = await upsertOffer(
    {
      externalId: parsed.mlbId,
      title,
      price,
      priceFrom,
      discountPct,
      commissionRate: 0,
      sales: null,
      rating: null,
      imageUrl: null,
      productUrl: finalUrl,
      affiliateUrl,
    },
    {
      marketplace: 'meli',
      source: 'telegram',
      sourceCopy: String(text || '').slice(0, SOURCE_COPY_MAX),
    }
  );
  if (row) {
    console.log(`[telegram] oferta meli capturada: #${row.id} "${row.title}" score=${row.score}`);
  }
}

async function handleAmazonUrl(url, text) {
  let finalUrl = url;
  let parsed = parseAmazonUrl(finalUrl);
  if (!parsed?.asin) {
    finalUrl = await expandUrl(finalUrl); // amzn.to / a.co
    parsed = parseAmazonUrl(finalUrl);
  }
  if (!parsed?.asin) {
    console.log(`[telegram] URL Amazon sem ASIN reconhecível: ${url}`);
    return;
  }

  const affiliateUrl = buildAmazonUrl(finalUrl);
  if (!affiliateUrl) {
    console.log(`[telegram] Amazon sem tag configurado — link ignorado: ${url}`);
    return;
  }

  const title = titleFromText(text);
  const prices = pricesFromText(text);
  if (!title || prices.length === 0) {
    console.log(`[telegram] mensagem Amazon sem título/preço extraível — ignorada (ASIN ${parsed.asin})`);
    return;
  }

  const price = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceFrom = maxPrice > price ? maxPrice : null;
  const discountPct = priceFrom ? Math.round((1 - price / priceFrom) * 100) : 0;

  const row = await upsertOffer(
    {
      externalId: parsed.asin,
      title,
      price,
      priceFrom,
      discountPct,
      commissionRate: 0,
      sales: null,
      rating: null,
      imageUrl: null,
      productUrl: finalUrl,
      affiliateUrl,
    },
    { marketplace: 'amazon', source: 'telegram', sourceCopy: String(text || '').slice(0, SOURCE_COPY_MAX) }
  );
  if (row) console.log(`[telegram] oferta amazon capturada: #${row.id} "${row.title}" score=${row.score}`);
}

async function handleAliexpressUrl(url, text) {
  let finalUrl = url;
  let parsed = parseAliexpressUrl(finalUrl);
  if (!parsed?.productId) {
    finalUrl = await expandUrl(finalUrl); // s.click / a.aliexpress → URL de produto
    parsed = parseAliexpressUrl(finalUrl);
  }
  if (!parsed?.productId) {
    console.log(`[telegram] URL AliExpress sem productId reconhecível: ${url}`);
    return;
  }

  // gera o NOSSO link de afiliado via API oficial a partir da URL de produto
  const affiliateUrl = await generateAliexpressLink(finalUrl);
  if (!affiliateUrl) {
    console.log(`[telegram] AliExpress sem link de afiliado (API não configurada/falhou) — ignorado: ${url}`);
    return;
  }

  const title = titleFromText(text);
  const prices = pricesFromText(text);
  if (!title || prices.length === 0) {
    console.log(`[telegram] mensagem AliExpress sem título/preço extraível — ignorada (id ${parsed.productId})`);
    return;
  }

  const price = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceFrom = maxPrice > price ? maxPrice : null;
  const discountPct = priceFrom ? Math.round((1 - price / priceFrom) * 100) : 0;

  const row = await upsertOffer(
    {
      externalId: parsed.productId,
      title,
      price,
      priceFrom,
      discountPct,
      commissionRate: 0,
      sales: null,
      rating: null,
      imageUrl: null,
      productUrl: finalUrl,
      affiliateUrl,
    },
    { marketplace: 'aliexpress', source: 'telegram', sourceCopy: String(text || '').slice(0, SOURCE_COPY_MAX) }
  );
  if (row) console.log(`[telegram] oferta aliexpress capturada: #${row.id} "${row.title}" score=${row.score}`);
}

// Join best-effort num canal público: sem estar no canal, o Telegram NÃO
// entrega NewMessage. Idempotente (entrar de novo em canal já ingressado é
// no-op do lado do Telegram). Falha (canal privado, flood wait...) só loga.
async function joinChannel(clean) {
  if (!client?.connected) return;
  try {
    const entity = await client.getEntity(clean);
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
    console.log(`[telegram] entrou no canal @${clean}`);
  } catch (err) {
    console.log(`[telegram] não foi possível entrar em @${clean} automaticamente: ${err.message} — entre manualmente com a conta da sessão`);
  }
}

/* --------------------------- handler de evento --------------------------- */

async function onNewMessage(event) {
  try {
    const chat = await event.getChat();
    const names = [];
    if (chat?.username) names.push(String(chat.username).toLowerCase());
    // canais podem ter múltiplos usernames (colecionáveis)
    if (Array.isArray(chat?.usernames)) {
      for (const u of chat.usernames) {
        if (u?.username) names.push(String(u.username).toLowerCase());
      }
    }
    if (!names.some((n) => watched.has(n))) return;

    const text = event.message?.message || '';
    if (!text) return;

    const urls = extractUrls(text);
    if (urls.length === 0) return;

    const seen = new Set();
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        if (isShopeeUrl(url)) await handleShopeeUrl(url, text);
        else if (isMeliUrl(url)) await handleMeliUrl(url, text);
        else if (isAmazonUrl(url)) await handleAmazonUrl(url, text);
        else if (isAliexpressUrl(url)) await handleAliexpressUrl(url, text);
      } catch (err) {
        console.log(`[telegram] erro ao processar URL ${url}: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`[telegram] erro ao processar mensagem: ${err.message}`);
  }
}

/* ------------------------------- exports --------------------------------- */

/** true se o monitor está ativo (client criado e autorizado). */
export function isMonitorRunning() {
  return client !== null;
}

// true enquanto startTelegramMonitor() está no meio de connect()/checkAuthorization().
// Sem isso, o healthcheck (cron de 10min) pode enxergar o client recém-criado
// AINDA conectando, achar que falhou, e derrubar (client=null) uma conexão que
// na verdade ia dar certo — deixando startTelegramMonitor() ler `client` já nulo
// e reportar "falha ao conectar" numa conexão que teria funcionado.
let connecting = false;

/**
 * Healthcheck periódico (chamado pelo scheduler): `client` só é zerado no
 * boot (falha de auth) ou por stopTelegramMonitor() — se a sessão for
 * revogada DEPOIS de conectado, isMonitorRunning() continuaria true pra
 * sempre sem isso. Reusa checkAuthorization (mesma chamada do startup) pra
 * confirmar que a conexão ainda está viva; se não, derruba e avisa o dono.
 */
export async function checkTelegramHealth() {
  if (!client || connecting) return;
  try {
    const ok = await client.checkAuthorization();
    if (!ok) throw new Error('sessão não autorizada');
  } catch (err) {
    console.log(`[telegram] healthcheck falhou (${err.message}) — monitor considerado morto`);
    await stopTelegramMonitor();
    await notifyOwnerOnce(
      'tg-session-dead',
      '📡⚠️ Telegram: o monitor caiu (conexão perdida ou sessão revogada) — paramos de captar ofertas do Telegram. Reconecte na aba Config → Telegram.',
      { everyHours: 24 }
    ).catch(() => {});
  }
}

/**
 * Para o monitor: destrói o client (destroy desarma o autoReconnect; um
 * disconnect simples deixaria o GramJS reviver a conexão). Idempotente.
 * Os handlers morrem junto com o client — um start posterior cria client
 * novo com UM handler (sem duplicação).
 */
export async function stopTelegramMonitor() {
  if (!client) return false;
  const old = client;
  client = null; // isMonitorRunning() = false imediatamente
  try {
    await old.destroy();
    console.log('[telegram] monitor parado');
  } catch (err) {
    console.log(`[telegram] erro ao parar o monitor (ignorado): ${err.message}`);
  }
  return true;
}

/**
 * Conecta no Telegram (GramJS, StringSession de config.telegram — .env ou
 * override do banco) e monitora os canais de telegram_channels (enabled).
 * Pode ser chamado DEPOIS do boot (ex.: após o login guiado do painel) e
 * de novo após stopTelegramMonitor() — cada start cria um client novo com
 * um único handler. Retorna o client, ou null se não configurado ou se a
 * conexão falhar (nunca lança — não pode derrubar o boot).
 */
export async function startTelegramMonitor() {
  const { apiId, apiHash, session } = config.telegram;
  if (!apiId || !apiHash || !session) {
    console.log('[telegram] não configurado — monitor desligado');
    return null;
  }

  // Já rodando (ex.: novo login com sessão nova) → reinicia sem duplicar handlers.
  if (client) {
    console.log('[telegram] monitor já ativo — reiniciando com a configuração atual');
    await stopTelegramMonitor();
  }

  connecting = true;
  try {
    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: Number.MAX_SAFE_INTEGER, // reconexão por conta do GramJS
      autoReconnect: true,
    });
    await client.connect();

    if (!(await client.checkAuthorization())) {
      console.log('[telegram] sessão inválida/expirada — refaça o login (painel ou `npm run telegram:login`)');
      await client.destroy().catch(() => {});
      client = null;
      await notifyOwnerOnce(
        'tg-session-dead',
        '📡⚠️ Telegram: a sessão do monitor expirou/foi revogada — paramos de captar ofertas do Telegram. Reconecte na aba Config → Telegram.',
        { everyHours: 24 }
      ).catch(() => {});
      return null;
    }
  } catch (err) {
    console.log(`[telegram] falha ao conectar: ${err.message} — monitor desligado`);
    if (client) await client.destroy().catch(() => {});
    client = null;
    return null;
  } finally {
    connecting = false;
  }

  // Carrega canais monitorados do banco.
  try {
    const { rows } = await query('SELECT username FROM telegram_channels WHERE enabled = true');
    watched.clear();
    for (const r of rows) {
      const u = cleanUsername(r.username);
      if (u) watched.add(u);
    }
  } catch (err) {
    console.log(`[telegram] erro ao carregar canais: ${err.message}`);
  }

  client.addEventHandler(onNewMessage, new NewMessage({}));

  if (watched.size === 0) {
    console.log('[telegram] conectado, mas nenhum canal cadastrado — use POST /telegram/channels');
  } else {
    console.log(`[telegram] monitor ativo em ${watched.size} canal(is): ${[...watched].join(', ')}`);
    // Join best-effort em TODOS os canais: canal cadastrado antes desta conta
    // conectar (ou após login com outra conta) não entregaria updates sem o
    // join — sem isso o monitor subiria "ativo" mas nunca capturaria nada.
    for (const u of watched) await joinChannel(u);
  }
  return client;
}

/**
 * Cadastra (ou reativa) um canal público em telegram_channels e passa a
 * monitorá-lo imediatamente. Best-effort: se o client estiver conectado,
 * tenta entrar no canal (sem join o Telegram não entrega as mensagens).
 * Retorna a row do banco, ou null em erro de DB.
 */
export async function addChannel(username) {
  const clean = cleanUsername(username);
  if (!clean) {
    console.log('[telegram] addChannel: username vazio/inválido');
    return null;
  }

  let row = null;
  try {
    const { rows } = await query(
      `INSERT INTO telegram_channels (username) VALUES ($1)
       ON CONFLICT (username) DO UPDATE SET enabled = true
       RETURNING *`,
      [clean]
    );
    row = rows[0] ?? null;
  } catch (err) {
    console.log(`[telegram] erro ao cadastrar canal @${clean}: ${err.message}`);
    return null;
  }

  watched.add(clean);
  console.log(`[telegram] canal @${clean} cadastrado e monitorado`);

  // Join best-effort (canal público): sem estar no canal, não chegam updates.
  await joinChannel(clean);

  return row;
}

/**
 * Tira o canal do set monitorado EM MEMÓRIA — efeito imediato no runtime
 * (o monitor para de capturar na hora, sem esperar restart). Não mexe no
 * banco (o caller já persistiu enabled=false) nem sai do canal no Telegram.
 */
export function removeChannel(username) {
  const clean = cleanUsername(username);
  if (clean && watched.delete(clean)) {
    console.log(`[telegram] canal @${clean} removido do monitor (runtime)`);
  }
}

/* --------------------------- login guiado (painel) ------------------------ */
// API real do GramJS instalado (telegram@2.26): client.sendCode({apiId,apiHash},
// phone) → { phoneCodeHash }; confirmação via client.invoke(Api.auth.SignIn);
// 2FA via Api.account.GetPassword + computeCheck + Api.auth.CheckPassword.

// Mensagem de erro do GramJS: RPCError traz errorMessage (ex.: PHONE_CODE_INVALID).
function rpcMessage(err) {
  return String(err?.errorMessage || err?.message || 'erro desconhecido');
}

/**
 * Inicia o login guiado: cria um TelegramClient com StringSession vazia,
 * conecta e envia o código pro app do Telegram do usuário. Guarda
 * client/phoneCodeHash em estado módulo-level; um login pendente anterior é
 * descartado (client antigo desconectado). Lança erro com mensagem clara.
 */
export async function beginLogin({ apiId, apiHash, phone } = {}) {
  const id = Number(apiId);
  const hash = String(apiHash ?? '').trim();
  const phoneNumber = String(phone ?? '').trim().replace(/[\s()-]/g, '');
  if (!Number.isInteger(id) || id <= 0) throw new Error('apiId inválido (inteiro positivo de my.telegram.org)');
  if (!hash) throw new Error('apiHash obrigatório');
  if (!/^\+?\d{8,15}$/.test(phoneNumber)) {
    throw new Error('phone inválido — use DDI+DDD+número (ex.: +5511999999999)');
  }

  // Sobrescreve login pendente anterior, desconectando o client antigo.
  if (pendingLogin) {
    const old = pendingLogin;
    pendingLogin = null;
    await old.client.destroy().catch(() => {});
    console.log('[telegram] login pendente anterior descartado');
  }

  const loginClient = new TelegramClient(new StringSession(''), id, hash, {
    connectionRetries: 3,
  });
  try {
    await loginClient.connect();
    const { phoneCodeHash } = await loginClient.sendCode({ apiId: id, apiHash: hash }, phoneNumber);
    pendingLogin = { client: loginClient, apiId: id, apiHash: hash, phone: phoneNumber, phoneCodeHash };
    console.log('[telegram] login iniciado — código enviado pro app do Telegram');
    return { needCode: true };
  } catch (err) {
    await loginClient.destroy().catch(() => {});
    throw new Error(`falha ao enviar o código: ${rpcMessage(err)}`);
  }
}

/**
 * Completa o login pendente com o código (e senha 2FA, se houver).
 * - conta com 2FA e password ausente → { needPassword: true } (login segue pendente)
 * - sucesso → { session } (StringSession de client.session.save(); pendente limpo)
 * - código/senha errados → throw com mensagem clara (login segue pendente p/ retry)
 */
export async function confirmLogin({ code, password } = {}) {
  if (!pendingLogin) throw new Error('nenhum login pendente — chame start-login primeiro');
  const { client: loginClient, phone, phoneCodeHash } = pendingLogin;
  const phoneCode = String(code ?? '').trim();
  if (!phoneCode) throw new Error('code obrigatório');

  try {
    await loginClient.invoke(
      new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode })
    );
  } catch (err) {
    const msg = rpcMessage(err);
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      // conta com 2FA
      if (!password) return { needPassword: true };
      try {
        const pwdInfo = await loginClient.invoke(new Api.account.GetPassword());
        const check = await computeCheck(pwdInfo, String(password));
        await loginClient.invoke(new Api.auth.CheckPassword({ password: check }));
      } catch (err2) {
        throw new Error(`senha 2FA incorreta: ${rpcMessage(err2)}`);
      }
    } else {
      throw new Error(`código inválido: ${msg}`);
    }
  }

  const session = loginClient.session.save(); // string ANTES de destruir o client
  pendingLogin = null;
  await loginClient.destroy().catch(() => {});
  console.log('[telegram] login concluído — sessão gerada');
  return { session };
}
