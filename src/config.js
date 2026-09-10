import 'dotenv/config';

// Exportados para reutilização pelo settings-store.js (validação de overrides).
export function range(str, fallback) {
  const m = String(str ?? '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return fallback;
  return [Number(m[1]), Number(m[2])];
}

export function window_(str, fallback) {
  const m = String(str ?? '').match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);
  if (!m) return fallback;
  return { startH: +m[1], startM: +m[2], endH: +m[3], endM: +m[4] };
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,

  evolution: {
    url: (process.env.EVOLUTION_URL || 'http://localhost:8080').replace(/\/$/, ''),
    apikey: process.env.EVOLUTION_APIKEY || '',
    instance: process.env.EVOLUTION_INSTANCE || 'affiliate-fitness',
    ownerJid: process.env.OWNER_JID || '',
  },

  // Canal do WhatsApp (broadcast). A Evolution v1.8.x NÃO posta em canal por API;
  // por isso a "semeadura" aqui apenas DIVULGA o link do canal nos grupos (risco
  // zero — são grupos próprios, opt-in). Vazio = semeadura desligada.
  channel: {
    url: process.env.CHANNEL_URL || '',
    // {link} é substituído pela url. Sem #publi: convite de canal não é link de afiliado.
    inviteText:
      process.env.CHANNEL_INVITE_TEXT ||
      '📢 Chegou agora? Entra no nosso *Canal de Ofertas* pra não perder nenhum achado fitness — as promoções relâmpago caem lá PRIMEIRO! 👇\n{link}',
    // Divulga o convite nos grupos a cada N horas (só dentro da janela de postagem
    // e quando não-pausado). Default 8h ≈ 2x/dia.
    seedEveryHours: Number(process.env.CHANNEL_SEED_EVERY_HOURS || 8),
  },

  shopee: {
    appId: process.env.SHOPEE_APP_ID || '',
    appSecret: process.env.SHOPEE_APP_SECRET || '',
    endpoint: 'https://open-api.affiliate.shopee.com.br/graphql',
  },

  meli: {
    autoLinks: process.env.MELI_AUTO_LINKS === 'true',
    mattWord: process.env.MELI_MATT_WORD || '',
    mattTool: process.env.MELI_MATT_TOOL || '',
    // Endpoint INTERNO do portal de afiliados (createLink) — auth por cookie de
    // sessão logada + x-csrf-token. ZONA CINZENTA de T&C (risco de suspensão);
    // gera o link oficial s.click do ML. Usado antes do fallback matt_word/tool.
    cookie: process.env.MELI_COOKIE || '',   // string Cookie: ... colada do navegador logado
    csrf: process.env.MELI_CSRF || '',       // x-csrf-token emparelhado ao cookie
    tag: process.env.MELI_TAG || '',         // canal/tag de divulgação cadastrado no portal
    createLinkEndpoint:
      process.env.MELI_CREATELINK_ENDPOINT ||
      'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',
  },

  // Disparos (convite pro grupo) — envio 1-a-1 NÃO-OFICIAL via Evolution.
  // ⚠️ Viola ToS do WhatsApp, risco de ban. Use uma INSTÂNCIA DEDICADA (chip
  // queimável), NÃO a affiliate-fitness. Anti-ban: spacing grande, teto/dia com
  // ramp, janela, opt-out automático e kill-switch (settings broadcast_paused).
  broadcast: {
    instance: process.env.BROADCAST_INSTANCE || '',        // instância Evolution dedicada (compat)
    instances: (process.env.BROADCAST_INSTANCES || '').split(',').map((s) => s.trim()).filter(Boolean),
    inviteLink: process.env.BROADCAST_INVITE_LINK || '',    // link único (fallback)
    // vários links (ex.: os 5 grupos) — round-robin por envio pra distribuir a galera
    inviteLinks: (process.env.BROADCAST_INVITE_LINKS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // variantes de mensagem; {link} e {nome} são substituídos. Várias = menos cara de spam.
    messages: (process.env.BROADCAST_MESSAGES || '')
      .split('|||').map((s) => s.trim()).filter(Boolean),
    dailyRamp: (process.env.BROADCAST_RAMP || '20,35,50,70').split(',').map(Number), // teto/dia por semana
    spacingMs: range(process.env.BROADCAST_SPACING_MS, [45_000, 150_000]),           // intervalo entre envios
    window: window_(process.env.BROADCAST_WINDOW, { startH: 9, startM: 0, endH: 21, endM: 0 }),
    optOutKeywords: (
      process.env.BROADCAST_OPTOUT ||
      'sair,parar,pare,remover,remove,stop,cancelar,descadastrar,nao quero,não quero,me tira'
    ).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Boas-vindas ao ENTRAR / feedback ao SAIR do grupo, via DM no número pessoal
    // (só p/ quem está em contacts = já opt-in do disparo, conversa aberta).
    // ⚠️ Kill-switch DESLIGADO por padrão: o número teve restrição por disparo em
    // massa; ligue (operation/painel) só quando estiver saudável. Overridável.
    groupDmEnabled: String(process.env.BROADCAST_GROUP_DM || '').toLowerCase() === 'true',
    // Textos das DMs ({nome} vira " Fulano" ou ""). Vazio = usa o padrão embutido.
    welcomeText: process.env.BROADCAST_WELCOME || '',
    exitFeedbackText: process.env.BROADCAST_EXIT_FEEDBACK || '',
  },

  // Amazon Associados: link de afiliado = URL canônica /dp/ASIN + ?tag=<tag>.
  // Sem API, sem segredo — confirmado no Operating Agreement. Só precisa do tag.
  amazon: {
    tag: process.env.AMAZON_TAG || '',       // ex.: axelot-20
  },

  // AliExpress Affiliate (Portals) — API oficial no gateway novo /sync,
  // assinatura HMAC-SHA256 (sign_method=sha256). app_secret NUNCA vai na request.
  aliexpress: {
    appKey: process.env.ALIEXPRESS_APP_KEY || '',
    appSecret: process.env.ALIEXPRESS_APP_SECRET || '',
    trackingId: process.env.ALIEXPRESS_TRACKING_ID || '',
    endpoint: process.env.ALIEXPRESS_ENDPOINT || 'https://api-sg.aliexpress.com/sync',
    timeoutMs: Number(process.env.ALIEXPRESS_TIMEOUT_MS || 30000),
  },

  // Instagram (auto-post das ofertas no feed) — API OFICIAL "Instagram API with
  // Instagram Login" (host graph.instagram.com). Conta Business/Creator, SEM
  // Página do Facebook. accessToken é long-lived (60 dias) renovado por cron; a
  // postagem respeita janela + cadência própria + teto diário (rate-limit ~25/24h).
  // ⚠️ accessToken/appSecret são SEGREDOS (editáveis só pelo painel, nunca logados).
  // A Graph API busca a image_url (precisa ser JPEG numa URL pública): as imagens
  // da Shopee (cf.shopee.com.br/file/<hash>) já são JPEG público → vão DIRETO.
  // publicBaseUrl só é usado no fluxo OAuth (callback) e no proxy de imagem
  // opcional (proxyImages=true, p/ fontes futuras que sirvam WebP).
  instagram: {
    enabled: process.env.IG_ENABLED === 'true',
    igUserId: process.env.IG_USER_ID || '',              // id numérico da conta (de /me?fields=user_id)
    accessToken: process.env.IG_ACCESS_TOKEN || '',      // SEGREDO: long-lived token
    appId: process.env.IG_APP_ID || '',                  // Instagram App ID (Meta app)
    appSecret: process.env.IG_APP_SECRET || '',          // SEGREDO: Instagram App Secret
    graphVersion: process.env.IG_GRAPH_VERSION || 'v23.0',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''), // https público (OAuth/proxy)
    proxyImages: process.env.IG_PROXY_IMAGES === 'true', // forçar /img/ig/<id>.jpg em vez da URL direta
    // template do caption: {titulo} {preco_bloco} {link} {hashtags} são substituídos
    caption:
      process.env.IG_CAPTION ||
      '🔥 {titulo}\n\n💰 {preco_bloco}\n\n🛒 Garanta o seu 👉 {link}\n📲 Mais achados todo dia aqui no perfil!\n\n{hashtags}',
    hashtags:
      process.env.IG_HASHTAGS ||
      '#achadinhos #fitness #academia #treino #promocao #oferta #vidafit #publi',
    postEveryHours: Number(process.env.IG_POST_EVERY_HOURS || 3), // espaçamento mínimo entre posts
    dailyCap: Number(process.env.IG_DAILY_CAP || 8),             // teto/dia (limite oficial é ~25/24h)
    minScore: Number(process.env.IG_MIN_SCORE || 0),            // 0 = usa config.ranking.minScore
    timeoutMs: Number(process.env.IG_TIMEOUT_MS || 30000),
  },

  telegram: {
    apiId: Number(process.env.TELEGRAM_API_ID || 0),
    apiHash: process.env.TELEGRAM_API_HASH || '',
    session: process.env.TELEGRAM_SESSION || '',
  },

  ollama: {
    url: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
    // 7b tem cold-start de ~70s; folga até 120s evita cair no template à toa.
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120_000),
  },

  // Provedor de copy plugável: Ollama local (default, grátis) ou Claude/Anthropic
  // (melhor qualidade, requer chave). DEFAULT 'ollama' — zero mudança de
  // comportamento até o usuário definir uma chave E trocar o provedor.
  copy: {
    provider: process.env.COPY_PROVIDER || 'ollama', // 'ollama' | 'anthropic' | 'openai'
    // Instrução de estilo extra do cliente, anexada ao prompt da IA (vazio = nada).
    // Ex.: "fale de forma mais sóbria" / "use gírias de academia". Editável no painel.
    styleExtra: process.env.COPY_STYLE_EXTRA || '',
    // Persona/tom base do redator (1ª pessoa, curadoria). Vazio = padrão embutido do buildPrompt.
    persona: process.env.COPY_PERSONA || '',
    // Modelo do auto-reply (DM) — desacopla do modelo de copy. Vazio = herda copy.openai.model.
    replyModel: process.env.COPY_REPLY_MODEL || '',
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      timeoutMs: Number(process.env.ANTHROPIC_TIMEOUT_MS || 30000),
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
    },
  },

  // Virtual try-on: veste o avatar-base com a foto do produto via gpt-image-1
  // (reusa config.copy.openai.apiKey). Síncrono no envio, timeout curto + fallback
  // pra offer.image_url original em qualquer falha — nunca trava a fila de posts.
  tryon: {
    enabled: process.env.TRYON_ENABLED !== 'false', // default ligado
    model: process.env.TRYON_MODEL || 'gpt-image-1',
    quality: process.env.TRYON_QUALITY || 'medium',
    timeoutMs: Number(process.env.TRYON_TIMEOUT_MS || 55000),
    avatarPath: process.env.TRYON_AVATAR_PATH || 'assets/avatar-base.png',
    avatarPathMasculino: process.env.TRYON_AVATAR_PATH_MASCULINO || 'assets/avatar-base-masculino.png',
    // Fotos extras da mesma modelo (poses/ângulos diferentes) — sorteia 1 por
    // chamada além do avatar-base, melhora fidelidade sem inflar cada request.
    avatarRefPaths: (process.env.TRYON_AVATAR_REF_PATHS || 'assets/avatar-refs/ref1-frontal.png,assets/avatar-refs/ref2-correndo.png,assets/avatar-refs/ref3-costas.png,assets/avatar-refs/ref4-yoga.png')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  },

  port: Number(process.env.PORT || 3210),
  adminToken: process.env.ADMIN_TOKEN || '',
  // Token do MCP (rota /mcp). Default = ADMIN_TOKEN. Vazio = rota liberada (LAN).
  mcp: { token: process.env.MCP_TOKEN || process.env.ADMIN_TOKEN || '' },
  // Segredo no path do webhook (/webhook/evolution/<token>): os campos do
  // payload (instance/remoteJid) são forjáveis por qualquer host com acesso à
  // porta. Configurado aqui E na URL registrada via scripts/setup-groups.js.
  webhookToken: process.env.WEBHOOK_TOKEN || '',
  tz: process.env.TZ || 'America/Sao_Paulo',

  posting: {
    window: window_(process.env.POSTING_WINDOW, { startH: 8, startM: 0, endH: 22, endM: 0 }),
    // posts/dia por semana de operação: [semana1, semana2, semana3+]
    ramp: (process.env.RAMP_SCHEDULE || '3,4,5').split(',').map(Number),
    groupSpacingMs: range(process.env.GROUP_SPACING_MS, [60_000, 180_000]),
    sendDelayMs: range(process.env.SEND_DELAY_MS, [3000, 8000]),
    dedupDays: Number(process.env.DEDUP_DAYS || 7),
    offerTtlHours: Number(process.env.OFFER_TTL_HOURS || 24),
    // horários FIXOS de pico (hora cheia; o plano diário adiciona jitter de minuto).
    // Os N posts do dia são distribuídos round-robin entre estas horas — menos flood,
    // mais previsível ("chegou a oferta das 19h"). Overridável em operation.peakHours.
    peakHours: (process.env.PEAK_HOURS || '12,19,21')
      .split(',').map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23),
  },

  ranking: {
    minCommission: Number(process.env.MIN_COMMISSION || 0.05),
    minDiscount: Number(process.env.MIN_DISCOUNT || 10),
    minSales: Number(process.env.MIN_SALES || 30),
    minRating: Number(process.env.MIN_RATING || 4.3),
    minScore: Number(process.env.MIN_SCORE || 30),
    weights: { commission: 0.45, discount: 0.35, popularity: 0.2 },
    // Multiplicador aplicado ao score quando o título casa content.penaltylist
    // (soft-penalty; 1 = desligado, 0.4 afunda ~60% e some da fila via minScore). Editável no painel.
    penaltyMult: Number(process.env.PENALTY_MULT || 0.4),
    // Penalidade p/ falta de prova social (1 = desligado). Ex.: 0.6 afunda quem não tem avaliação/vendas.
    noReviewMult: Number(process.env.NO_REVIEW_MULT || 1),
    noSalesMult: Number(process.env.NO_SALES_MULT || 1),
    // Fração-alvo de cada bucket na rotação de postagem (a seleção por slot
    // escolhe o bucket com maior déficit vs estes alvos, depois a melhor oferta
    // dele). Buckets: vestuario = roupas+calcados (Copa/futebol entram aqui);
    // acessorios = equipamentos/garrafa/óculos/etc; suplementos = só os seguros.
    categoryMix: {
      vestuario: Number(process.env.MIX_VESTUARIO || 0.70),
      acessorios: Number(process.env.MIX_ACESSORIOS || 0.20),
      suplementos: Number(process.env.MIX_SUPLEMENTOS || 0.10),
    },
  },

  content: {
    // Linha de identificação de publicidade (CONAR/CDC exigem identificar link
    // de afiliado como anúncio). Vazio desliga a linha. ?? preserva '' do env.
    disclosure: process.env.DISCLOSURE ?? '*Publi*',
    // Rodapé da mensagem de grupo (antes do disclosure). Vazio remove a linha.
    footer: process.env.MSG_FOOTER ?? '⏰ Preço pode mudar a qualquer momento!',
    // Templates de copy de fallback (1 por linha, com {titulo}). Vazio = usa os
    // 6 embutidos. Usado só quando a IA falha (ou como gerador sem IA).
    templates: (process.env.MSG_TEMPLATES || '')
      .split('\n').map((s) => s.trim()).filter(Boolean),
    // Chamadas de ação (CTA) rotacionadas na linha acima do link (1 por linha).
    // Vazio = usa as embutidas em copy.js (CTA_DEFAULTS).
    ctas: (process.env.MSG_CTAS || '')
      .split('\n').map((s) => s.trim()).filter(Boolean),
    // Termos "soft": NÃO excluem a oferta; multiplicam o score por ranking.penaltyMult
    // (< 1) pra afundá-la na fila. Genéricos de dropship que não convertem no público
    // feminino fitness. Comparação sem acento/caixa. Editável no painel.
    penaltylist: (
      process.env.PENALTYLIST ||
      [
        'corda de pular', 'pular corda', 'mochila', 'bolsa de academia',
        'sacola', 'saco de academia', 'necessaire', 'porta suplemento',
        'coqueteleira', 'luva de academia', 'luva musculacao', 'strap',
        'pulseira magnetica', 'roda abdominal', 'extensor elastico',
        'faixa de resistencia', 'mini band', 'massageador', 'rolo de massagem',
        'kit acessorios', 'kit fitness', 'universal', 'unissex',
      ].join(',')
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Títulos contendo qualquer um destes termos (comparação sem acento, em
    // minúsculas) são DESCARTADOS no sourcing: remédios de emagrecimento,
    // anabolizantes e "palhaçadas". Ajustável via env DENYLIST (CSV).
    denylist: (
      process.env.DENYLIST ||
      [
        // emagrecedores / remédios / "palhaçada"
        'emagrec', 'queima gordura', 'queimador de gordura', 'seca barriga',
        'inibidor de apetite', 'inibe apetite', 'redutor de medida', 'gel redutor',
        'detox', 'diuretico', 'termogenico', 'shake emagrecedor', 'cha emagrecedor',
        'sibutramina', 'anabolizante', 'oxandrolona', 'stanozolol', 'hemogenin',
        'lipo 6', 'lipo6', 'sustanon', 'durateston', 'estimulante sexual',
        'libido', 'viagra', 'tadalafila', 'sildenafila', 'cinta modeladora',
        // fora do nicho fitness (vazam de buscas largas)
        'pneu', 'inflador', 'compressor', 'bomba de ar', 'bomba de encher',
        'bomba para encher', 'mini trave', 'golzinho', 'motoqueiro', 'motocicleta',
        'guarda chuva', 'guarda-chuva', 'caneca', 'panela', 'cozinha', 'frigideira',
        'patrulha', 'pelicula', 'smartphone', 'capa de celular', 'automotivo',
        'carregador', 'fone de ouvido',
      ].join(',')
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
};

export function randomBetween([min, max]) {
  return Math.floor(min + Math.random() * (max - min));
}
