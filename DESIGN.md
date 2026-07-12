# AFFILIATE — Design do sistema

Sistema simples e cru: 1 processo Node.js (ESM, Node 22), Postgres, Evolution API v1.8.6, Ollama local.
Posta ofertas fitness (Shopee + Mercado Livre) em 5 grupos espelho de WhatsApp, com ramp-up e kill-switch.

## Convenções (OBRIGATÓRIAS para todos os módulos)
- ESM (`import`/`export`), sem TypeScript. `fetch` nativo do Node (sem axios).
- Imports internos sempre com extensão: `import { config } from './config.js'`.
- Dinheiro/taxas: `Number` simples (não há agregação financeira crítica).
- Logs: `console.log('[modulo] mensagem')` — prefixo do módulo entre colchetes.
- Erros de rede: capturar, logar e retornar valor neutro (`null`/`[]`) — o processo NUNCA pode cair por erro de uma fonte.
- Nada de novas dependências além das do package.json (pg, express, node-cron, telegram, dotenv).

## Já implementado (NÃO recriar; importar e usar)
- `src/config.js` → `export const config`, `export function randomBetween([min,max])`. Ver arquivo para o shape exato.
- `src/db.js` → `export const pool`, `query(text, params)`, `migrate()`, `getSetting(key, fallback)`, `setSetting(key, value)`, `isPaused()`.
- `sql/schema.sql` → tabelas: offers, posts, groups, settings, telegram_channels, keywords, slots (ver colunas exatas no arquivo).

## Módulos a construir

### src/shopee.js
API: GraphQL POST único em `config.shopee.endpoint`.
Auth header (exato): `Authorization: SHA256 Credential={appId}, Timestamp={ts}, Signature={sig}` onde
`sig = sha256_hex(appId + ts + payloadString + appSecret)` — SHA256 PURO (crypto.createHash), NÃO HMAC.
`ts` em SEGUNDOS unix. `payloadString` deve ser BYTE-IDÊNTICO ao body enviado (serializar uma vez com JSON.stringify e usar a mesma string nos dois lugares).
Erros vêm com HTTP 200 + `errors[]` no body (`extensions.code`: 10020 assinatura, 10030 rate limit → backoff expon. 3 tentativas, 10035 sem acesso).
Exports:
- `async function searchOffers(keyword, { sortType = 2, limit = 50, page = 1 } = {})` → query `productOfferV2(keyword:..., sortType:..., page:..., limit:...)` pedindo nodes `{ itemId productName priceMin priceMax priceDiscountRate sales ratingStar imageUrl offerLink productLink commissionRate sellerCommissionRate shopeeCommissionRate shopName productCatIds }`. Retorna array de objetos normalizados: `{ externalId, title, price, priceFrom, discountPct, commissionRate, sales, rating, imageUrl, productUrl, affiliateUrl }` (price = Number(priceMin); priceFrom = price/(1-discountPct/100) arredondado quando discountPct>0; affiliateUrl = offerLink; commissionRate = Number(commissionRate)).
- `async function offerByItemId(itemId, shopId)` → mesma query com `itemId:` (e `shopId:` se houver); retorna 1 objeto normalizado ou null. Usado pelo monitor do Telegram.
- `async function generateShortLink(originUrl, subIds = [])` → mutation `generateShortLink(input:{originUrl:..., subIds:[...]}) { shortLink }`; máx 5 subIds; retorna string ou null.
- Se `!config.shopee.appId`, todas as funções retornam neutro e logam aviso uma vez.

### src/links.js
Utilitários de URL puros (sem DB):
- `async function expandUrl(url)` → segue redirects (fetch method HEAD ou GET com redirect:'manual' em loop, máx 5 hops, timeout 10s) e retorna URL final. Necessário p/ shope.ee, amzn.to, mercadolivre.com/sec.
- `function parseShopeeUrl(url)` → extrai `{ shopId, itemId }` dos formatos: `shopee.com.br/<slug>-i.<shopId>.<itemId>`, `shopee.com.br/product/<shopId>/<itemId>`, e querystring. Retorna null se não casar.
- `function parseMeliUrl(url)` → extrai id `MLB-?\d+` de produto/anúncio mercadolivre; retorna `{ mlbId }` ou null; reconhece também `/sec/` (link curto, sem id — retorna `{ short: true }`).
- `function isShopeeUrl(url)` / `function isMeliUrl(url)` — inclui domínios curtos (shope.ee, mercadolivre.com/sec).
- `function extractUrls(text)` → todas as URLs http(s) de um texto.

### src/meli.js
SEM API oficial de afiliados (pesquisado: não existe; search da api.mercadolibre.com retorna 403).
- `function buildAffiliateUrl(productUrl)` → se `config.meli.autoLinks` e mattWord/mattTool definidos: anexa `matt_word=<mattWord>&matt_tool=<mattTool>` preservando query existente; senão retorna null. Comentário no código: viola T&C 1.8 do programa, flag de risco consciente do usuário.
- `async function importManualOffer({ title, affiliateUrl, price, priceFrom = null, imageUrl = null, category = 'geral' })` → INSERT em offers com marketplace='meli', source='manual', external_id = hash curto da URL (crypto), discount calculado se priceFrom, status pending, score calculado por `ranking.scoreOffer` (importar). Retorna a row criada.
- IMPORTANTE (comentário no topo): suplementos são PROIBIDOS no programa de afiliados do ML — ofertas meli de categoria 'suplementos' devem ser rejeitadas no import (throw com mensagem clara).

### src/ranking.js
- `function scoreOffer(o)` → score 0–100: pisos primeiro (commissionRate ≥ minCommission para marketplace shopee; discountPct ≥ minDiscount; sales ≥ minSales quando sales>0 informado; rating ≥ minRating quando rating informado; ofertas source='manual' ou 'telegram' pulam pisos de sales/rating se campos nulos) — se reprovar num piso aplicável retorna 0. Senão: `100 * (w.commission * min(commissionRate/0.20, 1) + w.discount * min(discountPct/60, 1) + w.popularity * min(log10(sales+1)/4, 1))`.
- `async function upsertOffer(o, { marketplace, source, sourceCopy = null, category = null })` → INSERT ... ON CONFLICT (marketplace, external_id) DO UPDATE de price/discount/commission/sales/score (mantém status se já 'posted'). Calcula score com scoreOffer. Retorna row.
- `async function pickNextOffer()` → melhor oferta: `status='pending' AND score >= minScore AND created_at > now() - offerTtlHours` e sem post do mesmo external_id nos últimos dedupDays dias; ordena por score DESC, created_at DESC; retorna row ou null.
- `async function expireOldOffers()` → marca expired ofertas pending velhas; retorna contagem.

### src/copy.js
- `async function generateCopy(offer)` → monta prompt PT-BR pro Ollama (config.ollama: POST {url}/api/generate, model, stream:false, options:{temperature:0.8, num_predict:200}, timeout config.ollama.timeoutMs via AbortController) pedindo SÓ o texto-gancho criativo (2–3 frases, emojis, sem link, sem preço inventado; se offer.source_copy existir, passar como referência de estilo: "reescreva melhor"). Valida: 20–400 chars, sem 'http'. Em qualquer falha → `templateCopy(offer)`.
- `function templateCopy(offer)` → sorteia 1 de ≥5 templates prontos (ganchos variados: 🚨 ACHADINHO, 🔥 RELÂMPAGO, 💪 PREÇO BAIXOU, 😱 CORRE, ⚡ OFERTA) usando título.
- `function assembleMessage(offer, hook)` → mensagem final determinística (o LLM nunca controla preço/link):
  ```
  {hook}

  💪 {title}
  ❌ De: R$ {priceFrom}   (linha omitida se priceFrom nulo/igual)
  ✅ Por: R$ {price} ({discountPct}% OFF)  (desconto omitido se 0)

  🛒 {affiliateUrl}

  ⏰ Preço pode mudar a qualquer momento!
  #publi · link de afiliado
  ```
  Formato moeda BR: `47,90`. Exporta as três funções.

### src/poster.js
Cliente Evolution v1.8.6 (formato v1! wrappers textMessage/mediaMessage):
- `async function evoFetch(path, body)` → POST `${config.evolution.url}${path}` headers `{ apikey: config.evolution.apikey, 'Content-Type': 'application/json' }`; GET se body undefined. Retorna json ou null (logando erro).
- `async function sendText(jid, text, { delay } = {})` → POST `/message/sendText/${instance}` body `{ number: jid, options: { delay: delay ?? randomBetween(config.posting.sendDelayMs), presence: 'composing', linkPreview: true }, textMessage: { text } }`.
- `async function sendImage(jid, imageUrl, caption)` → POST `/message/sendMedia/${instance}` body `{ number: jid, options: { delay: randomBetween(config.posting.sendDelayMs), presence: 'composing' }, mediaMessage: { mediatype: 'image', media: imageUrl, caption } }`.
- `async function postOfferToGroups(offer, message)` → busca groups enabled ORDER BY position; para cada: tenta sendImage (se offer.image_url) senão sendText; grava em posts (ok/error); espera `randomBetween(config.posting.groupSpacingMs)` entre grupos; retorna `{ sent, failed }`.
- `async function notifyOwner(text)` → sendText pro config.evolution.ownerJid (delay fixo 1200); no-op se ownerJid vazio.
- `async function fetchAllGroups()` → GET `/group/fetchAllGroups/${instance}?getParticipants=false` (query param obrigatório); retorna array `{ id, subject }`.

### src/telegram.js
GramJS (`import { TelegramClient } from 'telegram'`, `import { StringSession } from 'telegram/sessions/index.js'`, `import { NewMessage } from 'telegram/events/index.js'`).
- `async function startTelegramMonitor()` → se faltar apiId/apiHash/session: loga '[telegram] não configurado — monitor desligado' e retorna null. Senão conecta, carrega telegram_channels enabled, e em cada NewMessage de um desses canais: extrai URLs do texto (links.extractUrls), expande encurtadas, e:
  - URL Shopee → parseShopeeUrl → `shopee.offerByItemId(itemId, shopId)` → se achou, upsertOffer com source='telegram', sourceCopy = texto da mensagem (até 600 chars). (O offerLink retornado já vem com NOSSA tag — vantagem chave.)
  - URL Meli → se `config.meli.autoLinks`: parseMeliUrl + meli.buildAffiliateUrl → upsertOffer marketplace='meli', source='telegram', commissionRate 0, dados básicos do texto (título = primeira linha sem emojis, preço = regex `R\$\s*([\d.,]+)` menor valor do texto); senão ignora e loga.
  - Adicionar canal: helper `async function addChannel(username)` (INSERT) — usado pelo endpoint admin.
- Resiliente: try/catch por mensagem; reconexão fica por conta do GramJS.

### src/scheduler.js
node-cron, timezone config.tz. Exports `function startScheduler()` que registra:
1. Sourcing: a cada 3h (e uma vez ~30s após boot): para cada keyword enabled → shopee.searchOffers(term) → upsertOffer(source='api', category) com pausa 1-2s entre keywords; depois expireOldOffers(). Pular tudo se isPaused().
2. Plano diário: cron `5 0 * * *` (e no boot se não houver slots pro dia): `plantodaySlots()` — N = config.posting.ramp[min(semanaDesdeStartedAt, len-1)] (started_at de settings; se vazio, setar agora); sorteia N horários únicos dentro da janela, com peso extra nas peakHours, minuto/segundo aleatórios, e grava em slots. Slots no passado (boot tardio) são criados só para horários futuros.
3. Executor: cron a cada minuto: se isPaused() retorna; pega slot pending com scheduled_at <= now(); pickNextOffer(); se null marca slot 'skipped'; senão generateCopy → assembleMessage → postOfferToGroups → marca offer 'posted'+posted_at, slot 'done'+offer_id; se todos os envios falharam: slot 'failed', offer volta a 'pending'. Lock simples: variável módulo `running` para não sobrepor execuções.
4. Resumo diário: cron `30 22 * * *`: conta posts/ofertas do dia e notifyOwner com resuminho (posts ok, falhas, top oferta, slots de amanhã ainda não, pausado ou não).

### src/control.js
- `function parseCommand(text)` → normaliza (lower, trim, sem acento) e mapeia: pausar|pause → 'pause'; retomar|voltar|resume → 'resume'; status → 'status'; pular|skip → 'skip'; ajuda|help|comandos → 'help'. Retorna string ou null.
- `async function handleWebhook(payload)` → payload da Evolution (evento messages.upsert; shape v1.8: `{ event, instance, data }`, data pode ser objeto ou array). Para cada msg: ignorar se `key.fromMe` false?? NÃO — comandos vêm do OWNER: aceitar somente se `key.remoteJid === config.evolution.ownerJid` e a instância for a nossa. Texto em `message.conversation` ou `message.extendedTextMessage.text`. Comandos:
  - pause → setSetting('paused','true') + notifyOwner('⏸️ Sistema pausado')
  - resume → setSetting('paused','false') + notifyOwner('▶️ Sistema retomado')
  - skip → marca a melhor oferta atual (pickNextOffer) como 'rejected' + confirma
  - status → notifyOwner com: pausado?, posts hoje, slots restantes hoje, ofertas pending acima do minScore, grupos ativos
  - help → lista de comandos

### src/index.js
- boot: migrate() → express app → startScheduler() → startTelegramMonitor() (não bloqueante, .catch logado).
- Endpoints (todos JSON):
  - `GET /health` → `{ ok: true, paused, uptime }` (sem auth)
  - middleware auth p/ o resto: header `x-admin-token === config.adminToken` (se adminToken vazio, só aceitar requests de 127.0.0.1).
  - `POST /webhook/evolution` → control.handleWebhook (SEM token — a Evolution chama; validar `instance` no handler)
  - `GET /status` → mesmas infos do comando status
  - `POST /offers/manual` → meli.importManualOffer(body)
  - `POST /groups/sync` → poster.fetchAllGroups() e upsert na tabela groups (enabled=true, position=ordem) APENAS para grupos cujo subject contenha o prefixo passado em `body.prefix` (default: 'Achadinhos'); retorna lista.
  - `POST /telegram/channels` → body `{ username }` → telegram.addChannel
  - `POST /test-post` → gera copy da melhor oferta pending e manda SÓ pro ownerJid (não marca como posted) — pra testar o pipeline.
- `app.listen(config.port)` + log de boot com resumo da config (sem segredos).
- Tratamento global: `process.on('unhandledRejection', ...)` loga e segue.

### scripts/telegram-login.js
Interativo (readline): pede api_id/api_hash se não estiverem no .env, faz login por telefone+código (TelegramClient.start), imprime a StringSession pra colar em TELEGRAM_SESSION no .env.

### scripts/setup-groups.js
CLI: `node scripts/setup-groups.js [prefixo] [n]` (default 'Achadinhos Fitness', 5).
1. Confirma que a instância config.evolution.instance existe (GET /instance/fetchInstances) — se não, cria via POST /instance/create `{ instanceName, token: instanceName + '-' + sufixo aleatório, qrcode: true }` e instrui o usuário a escanear o QR (GET /instance/connect/{instance} retorna base64/code — imprimir o code).
2. Com instância conectada: cria N grupos `${prefixo} #${i}` via POST /group/create `{ subject, participants: [ownerJid sem @s.whatsapp.net] }`, guarda o id retornado na tabela groups, e seta announcement via PUT /group/updateSetting body `{ groupJid, action: 'announcement' }` (só admins postam → menos denúncia).
3. Configura o webhook da instância: POST /webhook/set/{instance} `{ url: 'http://10.0.0.254:' + config.port + '/webhook/evolution', webhook_by_events: false, webhook_base64: false, events: ['MESSAGES_UPSERT'] }`.
4. Imprime resumo (JIDs criados).

### scripts/smoke.js
Roda checagens sem efeitos externos destrutivos e imprime PASS/FAIL por item: conexão DB (SELECT 1 + migrate), assinatura Shopee (função pura — comparar com vetor conhecido calculado inline), score de oferta exemplo, templateCopy + assembleMessage de oferta fake (deve conter '#publi', 'R$'), parse de URLs (3 casos por marketplace), Ollama /api/version (WARN se fora), Evolution GET / (WARN se fora). Exit 1 se algum FAIL (WARNs não falham).

## Fluxo resumido
sourcing (cron 3h: Shopee keywords) + telegram (tempo real) → offers (score, dedup) → slots diários (ramp 4→8→12, janela 8-22h, picos 12-14/19-21) → executor por minuto → copy (Ollama→fallback template; LLM só faz o gancho) → posta nos 5 grupos espelho (imagem+caption; espaçamento 60-180s; delay 3-8s "digitando") → registra posts → resumo diário + comandos do dono via webhook (pausar/retomar/status/pular).
