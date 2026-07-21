// Agendador central: 4 crons (node-cron, timezone config.tz).
// 1. Sourcing Shopee a cada 3h (e ~30s após o boot)
// 2. Plano diário de slots às 00:05 (e no boot se o dia ainda não foi planejado)
// 3. Executor por minuto (com lock simples para não sobrepor execuções)
// 4. Resumo diário às 22:30 para o dono
import cron from 'node-cron';
import { config, randomBetween } from './config.js';
import { query, getSetting, setSetting, isPaused, purgeOldMessages } from './db.js';
import { searchOffers } from './shopee.js';
import { upsertOffer, pickNextOfferByMix, expireOldOffers } from './ranking.js';
import { generateCopy } from './copy.js';
import { postOfferToGroups, notifyOwner, postChannelInvite } from './poster.js';
import { runBroadcast, broadcastStats } from './broadcast.js';
import { runWarmer } from './warmer.js';
import { runInstagramExecutor, runInstagramTokenRefresh, igStatus } from './instagram.js';
import { isMonitorRunning, checkTelegramHealth } from './telegram.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Helpers de timezone (sem dependências: Intl + Date)
// ---------------------------------------------------------------------------

// Offset (ms) do timezone config.tz em relação ao UTC num dado instante.
function tzOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - date.getTime();
}

// Componentes de data/hora "como vistos" no timezone config.tz.
function tzParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
}

// Constrói um Date (instante UTC) a partir de componentes locais do config.tz.
// Overflow de dia (d+1 além do mês) é normalizado pelo Date.UTC.
function tzDate(y, m, d, h, min, s) {
  let ts = Date.UTC(y, m - 1, d, h, min, s);
  ts -= tzOffsetMs(new Date(ts));
  // segunda passada cobre bordas de DST
  ts = Date.UTC(y, m - 1, d, h, min, s) - tzOffsetMs(new Date(ts));
  return new Date(ts);
}

// Hora atual (em config.tz) está dentro da janela de postagem (config.posting.window)?
// A janela é garantida no PLANEJAMENTO e também na EXECUÇÃO: após pausa longa ou
// downtime, o executor não pode disparar fora de 8-22h.
function withinPostingWindow(date = new Date()) {
  const { h, min } = tzParts(date);
  const w = config.posting.window;
  const cur = h * 60 + min;
  return cur >= w.startH * 60 + w.startM && cur < w.endH * 60 + w.endM;
}

function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// 1. Sourcing: keywords → Shopee → upsert + expiração
// ---------------------------------------------------------------------------

let sourcingRunning = false;

// Sourcing Shopee. `force` (botão "Buscar ofertas agora" do painel) ignora o
// pause — sourcing só preenche a fila, não posta. Persiste um resumo da última
// execução (settings last_sourcing_at/last_sourcing_result) p/ o painel exibir
// "último sourcing há Xmin: N ofertas, E erro(s)" e alertar se vier seco.
export async function runSourcing({ force = false } = {}) {
  if (sourcingRunning) return { skipped: 'já rodando' };
  sourcingRunning = true;
  try {
    if (!force && (await isPaused())) {
      console.log('[scheduler] pausado — sourcing pulado');
      return { skipped: 'pausado' };
    }
    const { rows: keywords } = await query(
      'SELECT term, category FROM keywords WHERE enabled = true ORDER BY id'
    );
    let total = 0;
    let errors = 0;
    for (const kw of keywords) {
      try {
        const offers = await searchOffers(kw.term);
        for (const offer of offers) {
          await upsertOffer(offer, { marketplace: 'shopee', source: 'api', category: kw.category });
        }
        total += offers.length;
      } catch (err) {
        errors++;
        console.log(`[scheduler] erro no sourcing de "${kw.term}": ${err.message}`);
      }
      await sleep(randomBetween([1000, 2000]));
    }
    const expired = await expireOldOffers();
    const result = { at: new Date().toISOString(), total, keywords: keywords.length, expired, errors };
    await setSetting('last_sourcing_at', result.at);
    await setSetting('last_sourcing_result', JSON.stringify(result));
    console.log(
      `[scheduler] sourcing concluído: ${total} oferta(s) de ${keywords.length} keyword(s), ${expired} expirada(s), ${errors} erro(s)`
    );
    return result;
  } catch (err) {
    console.log(`[scheduler] erro no sourcing: ${err.message}`);
    return { error: err.message };
  } finally {
    sourcingRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 2. Plano diário: sorteia N horários (ramp + peakHours) e grava em slots
// ---------------------------------------------------------------------------

async function planTodaySlots({ onBoot = false } = {}) {
  try {
    const now = new Date();
    const { y, m, d } = tzParts(now);
    const dayStart = tzDate(y, m, d, 0, 0, 0);
    const dayEnd = tzDate(y, m, d + 1, 0, 0, 0);

    if (onBoot) {
      const { rows } = await query(
        'SELECT count(*)::int AS n FROM slots WHERE scheduled_at >= $1 AND scheduled_at < $2',
        [dayStart, dayEnd]
      );
      if (rows[0].n > 0) {
        console.log(`[scheduler] plano diário já existe (${rows[0].n} slot(s) hoje) — boot não replaneja`);
        return;
      }
    }

    // Pausado não planeja nada — e, crucial, não ancora o started_at. Assim o
    // ramp-up só começa a contar quando o dono despausa de verdade (evita voltar
    // de um aquecimento de 2 semanas já na semana 2, disparando 12/dia de cara).
    if (await isPaused()) {
      console.log('[scheduler] pausado — plano diário adiado (ramp-up só inicia ao despausar)');
      return;
    }

    // Sem grupo habilitado não há o que planejar — e o ramp-up não pode
    // começar a contar antes de o número estar conectado e os grupos criados.
    const { rows: gRows } = await query('SELECT count(*)::int AS n FROM groups WHERE enabled');
    if (gRows[0].n === 0) {
      console.log('[scheduler] nenhum grupo habilitado — plano diário adiado (ramp-up só inicia com grupos)');
      return;
    }

    // âncora do ramp-up: started_at em settings (preenchido na 1ª ativação)
    let startedAt = await getSetting('started_at', '');
    if (!startedAt) {
      startedAt = now.toISOString();
      await setSetting('started_at', startedAt);
      console.log(`[scheduler] started_at vazio — ancorado em ${startedAt}`);
    }
    const weeks = Math.max(
      0,
      Math.floor((now.getTime() - new Date(startedAt).getTime()) / (7 * 24 * 3600 * 1000))
    );
    const ramp = config.posting.ramp;
    const n = ramp[Math.min(weeks, ramp.length - 1)];

    // Horários FIXOS de pico: distribui os N posts entre config.posting.peakHours
    // (round-robin), com jitter de minuto p/ naturalidade — em vez de sortear o dia
    // inteiro. Menos flood, mais previsível. Considera só os picos DENTRO da janela.
    const w = config.posting.window;
    const winStart = w.startH * 60 + w.startM;
    const winEnd = w.endH * 60 + w.endM;                 // exclusivo (executor: cur < winEnd)
    const JITTER = 15;                                   // ±min em torno da hora cheia
    const anchors = (config.posting.peakHours || [])
      .map(Number)
      .filter((h) => Number.isInteger(h) && h * 60 >= winStart && h * 60 < winEnd)
      .sort((a, b) => a - b);
    if (anchors.length === 0) anchors.push(w.startH);    // fallback defensivo

    const chosenMinutes = new Set();
    const times = [];
    let guard = 0;
    let ai = 0;
    while (times.length < n && guard++ < 1000) {
      const h = anchors[ai % anchors.length];
      ai++;
      const base = h * 60;
      const jitter = Math.floor(Math.random() * (2 * JITTER + 1)) - JITTER;  // -J..+J
      const cur = Math.min(Math.max(base + jitter, winStart), winEnd - 1);
      if (chosenMinutes.has(cur)) continue;
      chosenMinutes.add(cur);
      const sec = Math.floor(Math.random() * 60);
      times.push(tzDate(y, m, d, Math.floor(cur / 60), cur % 60, sec));
    }

    // boot tardio: cria slots só para horários futuros
    const future = times.filter((t) => t.getTime() > now.getTime());
    future.sort((a, b) => a - b);
    for (const at of future) {
      await query('INSERT INTO slots (scheduled_at) VALUES ($1)', [at]);
    }
    const dropped = times.length - future.length;
    console.log(
      `[scheduler] plano diário: ${future.length} slot(s) criados (semana ${weeks}, alvo ${n})` +
        (dropped > 0 ? `, ${dropped} no passado descartado(s)` : '')
    );
  } catch (err) {
    console.log(`[scheduler] erro no plano diário: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Executor por minuto: slot vencido → melhor oferta → copy → postar
// ---------------------------------------------------------------------------

// Pipeline de postagem de UMA oferta: generateCopy → assembleMessage →
// postOfferToGroups → atualizar status da oferta. Usado pelo executor (slot)
// e pelo painel (POST /api/offers/:id/post-now em panel.js) — fonte única.
//
// REIVINDICAÇÃO ATÔMICA: antes de qualquer envio, a oferta vira 'posting' com
// UPDATE condicionado ao status que o chamador leu (optimistic lock). Se outro
// envio já a reivindicou (post-now × executor, ou dois post-now em paralelo),
// rowCount=0 → retorna { conflict: true } sem enviar nada. pickNextOffer só
// enxerga 'pending', então o executor ignora ofertas em voo.
//
// sent > 0 → oferta 'posted' + posted_at; nenhum envio ok → RESTAURA o status
// original (pending volta pra fila; rejected/expired/skipped do post-now não
// podem voltar silenciosamente pra fila automática). Retorna { sent, failed }.
export async function postOffer(offer) {
  const claim = await query(
    `UPDATE offers SET status = 'posting' WHERE id = $1 AND status = $2`,
    [offer.id, offer.status]
  );
  if (claim.rowCount === 0) {
    console.log(`[scheduler] oferta ${offer.id} já reivindicada por outro envio — nada feito`);
    return { sent: 0, failed: 0, conflict: true };
  }

  let sent = 0;
  let failed = 0;
  try {
    const hook = await generateCopy(offer);
    // subId por grupo + montagem da mensagem migraram pro postOfferToGroups (passa o hook).
    ({ sent, failed } = await postOfferToGroups(offer, hook));
  } finally {
    if (sent > 0) {
      await query(`UPDATE offers SET status = 'posted', posted_at = now() WHERE id = $1`, [offer.id]);
    } else {
      await query(`UPDATE offers SET status = $2 WHERE id = $1`, [offer.id, offer.status]);
    }
  }
  return { sent, failed };
}

let running = false; // lock simples: não sobrepor execuções

// Tolerância máxima p/ executar um slot vencido. Mais velho que isso (pausa
// longa, downtime do processo) → 'skipped': não drenamos slots acumulados em
// rajada de 1 post/minuto, o que violaria o espaçamento e a janela de postagem.
const MAX_SLOT_AGE_MINUTES = 30;

async function runExecutor() {
  if (running) return;
  running = true;
  try {
    if (await isPaused()) return;

    // Slots vencidos além da tolerância nunca executam: viram 'skipped'.
    const stale = await query(
      `UPDATE slots SET status = 'skipped'
        WHERE status = 'pending'
          AND scheduled_at < now() - make_interval(mins => $1::int)`,
      [MAX_SLOT_AGE_MINUTES]
    );
    if (stale.rowCount > 0) {
      console.log(
        `[scheduler] ${stale.rowCount} slot(s) vencido(s) há mais de ${MAX_SLOT_AGE_MINUTES}min marcados como skipped`
      );
    }

    // Fora da janela 8-22h (em config.tz) não se posta — mesmo com slot vencido.
    if (!withinPostingWindow()) return;

    const { rows } = await query(
      `SELECT id, scheduled_at FROM slots
        WHERE status = 'pending' AND scheduled_at <= now()
        ORDER BY scheduled_at ASC
        LIMIT 1`
    );
    const slot = rows[0];
    if (!slot) return;

    const offer = await pickNextOfferByMix();
    if (!offer) {
      await query(`UPDATE slots SET status = 'skipped' WHERE id = $1`, [slot.id]);
      console.log(`[scheduler] slot ${slot.id} pulado: nenhuma oferta elegível`);
      return;
    }

    const { sent, failed, conflict } = await postOffer(offer);

    if (conflict) {
      // post-now do painel reivindicou a oferta entre o pick e a claim:
      // slot segue pending e tenta outra oferta no próximo minuto.
      console.log(`[scheduler] slot ${slot.id}: oferta ${offer.id} em envio por outro caminho — slot mantido`);
      return;
    }

    if (sent > 0) {
      await query(`UPDATE slots SET status = 'done', offer_id = $2 WHERE id = $1`, [slot.id, offer.id]);
      console.log(
        `[scheduler] slot ${slot.id} feito: oferta ${offer.id} postada (${sent} ok, ${failed} falha(s))`
      );
    } else {
      // todos os envios falharam: slot falha; postOffer já devolveu a oferta a 'pending'
      await query(`UPDATE slots SET status = 'failed', offer_id = $2 WHERE id = $1`, [slot.id, offer.id]);
      console.log(`[scheduler] slot ${slot.id} falhou: nenhum envio ok (oferta ${offer.id} segue pending)`);
    }
  } catch (err) {
    console.log(`[scheduler] erro no executor: ${err.message}`);
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// 3b. Semeadura do canal: divulga o link do canal nos grupos na cadência
//     config.channel.seedEveryHours (só dentro da janela e não-pausado).
// ---------------------------------------------------------------------------

export async function runChannelSeed({ force = false } = {}) {
  try {
    if (!String(config.channel?.url ?? '').trim()) return { skipped: 'sem canal' };
    if (!force) {
      if (await isPaused()) return { skipped: 'pausado' };
      if (!withinPostingWindow()) return { skipped: 'fora da janela' };
      const everyH = Math.max(1, Number(config.channel?.seedEveryHours) || 8);
      const last = await getSetting('channel_last_seed_at', '');
      if (last && Date.now() - new Date(last).getTime() < everyH * 3600 * 1000) {
        return { skipped: 'cadência ainda não venceu' };
      }
    }
    const { rows: gRows } = await query('SELECT count(*)::int AS n FROM groups WHERE enabled');
    if (gRows[0].n === 0) return { skipped: 'sem grupos' };

    const { sent, failed, skipped } = await postChannelInvite();
    if (skipped) return { skipped };
    if (sent > 0) {
      await setSetting('channel_last_seed_at', new Date().toISOString());
      console.log(`[scheduler] semeadura do canal: convite postado em ${sent} grupo(s), ${failed} falha(s)`);
    } else {
      console.log(`[scheduler] semeadura do canal: nenhum envio ok (${failed} falha(s))`);
    }
    return { sent, failed };
  } catch (err) {
    console.log(`[scheduler] erro na semeadura do canal: ${err.message}`);
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 4. Resumo diário às 22:30 → notifyOwner
// ---------------------------------------------------------------------------

async function runDailySummary() {
  try {
    const tz = config.tz;
    const paused = await isPaused();

    const { rows: postRows } = await query(
      `SELECT count(*) FILTER (WHERE ok)::int AS ok,
              count(*) FILTER (WHERE NOT ok)::int AS fail
         FROM posts
        WHERE (posted_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    const { rows: slotRows } = await query(
      `SELECT status, count(*)::int AS n
         FROM slots
        WHERE (scheduled_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        GROUP BY status`,
      [tz]
    );
    const slots = Object.fromEntries(slotRows.map((r) => [r.status, r.n]));
    const { rows: topRows } = await query(
      `SELECT title, score
         FROM offers
        WHERE status = 'posted'
          AND (posted_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        ORDER BY score DESC
        LIMIT 1`,
      [tz]
    );
    const top = topRows[0];

    // saúde das outras frentes (best-effort: nenhuma derruba o resumo)
    let ig = null, bc = null, tgMonitor = null, tgChannels = 0;
    try { ig = await igStatus(); } catch { /* ignora */ }
    try { bc = await broadcastStats(); } catch { /* ignora */ }
    try {
      tgMonitor = isMonitorRunning();
      const { rows } = await query('SELECT count(*)::int AS n FROM telegram_channels WHERE enabled = true');
      tgChannels = rows[0].n;
    } catch { /* ignora */ }

    const lines = [
      '📊 Resumo do dia',
      paused ? '⏸️ Sistema PAUSADO' : '▶️ Sistema ativo',
      `✅ Posts ok: ${postRows[0].ok} | ❌ Falhas: ${postRows[0].fail}`,
      `🗓️ Slots: ${slots.done ?? 0} feitos, ${slots.skipped ?? 0} pulados, ${slots.failed ?? 0} falhos, ${slots.pending ?? 0} pendentes`,
      top
        ? `🏆 Top oferta: ${top.title} (score ${Math.round(Number(top.score))})`
        : '🏆 Top oferta: nenhuma postada hoje',
    ];
    if (ig && ig.configured) {
      lines.push(`📸 Instagram: ${ig.postedToday}/${ig.dailyCap} posts${ig.enabled ? '' : ' (auto-post DESLIGADO)'}`);
    }
    if (bc && bc.configured) {
      lines.push(`📨 Disparos: ${bc.sentToday}/${bc.dailyTarget} enviados, ${bc.failed} falha(s)${bc.paused ? ' (pausado)' : ''}`);
    }
    if (config.telegram.session) {
      lines.push(`📡 Telegram: ${tgMonitor ? 'monitorando' : '⚠️ monitor CAÍDO'} · ${tgChannels} canal(is)`);
    }

    // ----- alertas acionáveis (só aparecem quando há problema) -----
    const alerts = [];
    if (ig && ig.configured && ig.tokenExpiresAt) {
      const days = Math.floor((new Date(ig.tokenExpiresAt).getTime() - Date.now()) / 86_400_000);
      if (days <= 7) alerts.push(`Token do Instagram vence em ${days} dia(s) — reconecte na aba Config.`);
    }
    if (ig && ig.configured && !ig.enabled) {
      alerts.push('Instagram com auto-post desligado (pode ter sido pelas falhas seguidas) — confira na aba Config.');
    }
    if (config.telegram.session && !tgMonitor) {
      alerts.push('Monitor do Telegram caiu (sessão pode ter sido revogada) — reconecte na aba Config → Telegram.');
    }
    try {
      // pausado não roda sourcing (e não atualiza last_sourcing) — não alarmar à toa.
      const raw = paused ? '' : await getSetting('last_sourcing_result', '');
      if (raw) {
        const r = JSON.parse(raw);
        const ageH = (Date.now() - new Date(r.at).getTime()) / 3_600_000;
        if (ageH > 6) alerts.push(`Última busca de ofertas foi há ${Math.round(ageH)}h — o sourcing pode estar travado.`);
        else if (r.total === 0) alerts.push('A última busca de ofertas não trouxe NADA — confira as credenciais da Shopee / keywords.');
        else if (r.errors > 0) alerts.push(`A última busca teve ${r.errors} erro(s) de keyword — confira a aba Fontes.`);
      }
    } catch { /* ignora */ }
    if (alerts.length) {
      lines.push('', '🚨 *Atenção:*');
      for (const a of alerts) lines.push(`• ${a}`);
    }

    lines.push('', '🌙 Slots de amanhã serão sorteados às 00:05');
    await notifyOwner(lines.join('\n'));
    console.log('[scheduler] resumo diário enviado');
  } catch (err) {
    console.log(`[scheduler] erro no resumo diário: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Registro dos crons
// ---------------------------------------------------------------------------

export function startScheduler() {
  const opts = { timezone: config.tz };

  // Recovery: oferta presa em 'posting' (crash/restart no meio de um envio)
  // volta a 'pending' — processo único, então qualquer 'posting' no boot é órfã.
  query(`UPDATE offers SET status = 'pending' WHERE status = 'posting'`)
    .then((r) => {
      if (r.rowCount > 0) console.log(`[scheduler] ${r.rowCount} oferta(s) órfã(s) em 'posting' devolvida(s) a 'pending'`);
    })
    .catch((err) => console.log(`[scheduler] erro no recovery de ofertas 'posting': ${err.message}`));

  // Recovery dos disparos: contato preso em 'sending' (crash no meio) volta a 'pending'.
  query(`UPDATE contacts SET status = 'pending' WHERE status = 'sending'`)
    .then((r) => {
      if (r.rowCount > 0) console.log(`[scheduler] ${r.rowCount} contato(s) órfão(s) em 'sending' devolvido(s) a 'pending'`);
    })
    .catch((err) => console.log(`[scheduler] erro no recovery de contatos 'sending': ${err.message}`));

  // Recovery do Instagram: oferta presa em ig_status='posting' (crash no meio de
  // uma publicação). NÃO volta a NULL — a publicação NÃO é atômica com o DB, o
  // post pode já ter saído no feed; re-postar cegamente duplicaria. Marca como
  // 'error' com attempts no teto (sai do retry automático) p/ conferência manual.
  query(`UPDATE offers SET ig_status = 'error', ig_attempts = GREATEST(ig_attempts, 3),
            ig_error = 'interrompido no envio (reinício) — confira o feed antes de repostar'
          WHERE ig_status = 'posting'`)
    .then((r) => {
      if (r.rowCount > 0) console.log(`[scheduler] ${r.rowCount} oferta(s) órfã(s) em ig_status 'posting' marcada(s) p/ conferência manual`);
    })
    .catch((err) => console.log(`[scheduler] erro no recovery do Instagram: ${err.message}`));

  // 1. sourcing a cada 3h
  cron.schedule('0 */3 * * *', () => { runSourcing(); }, opts);
  // 2. plano diário 00:05
  cron.schedule('5 0 * * *', () => { planTodaySlots(); }, opts);
  // 3. executor por minuto
  cron.schedule('* * * * *', () => { runExecutor(); }, opts);
  // 3b. semeadura do canal: checa de hora em hora (no :07), respeita a cadência
  cron.schedule('7 * * * *', () => { runChannelSeed(); }, opts);
  // 3c. disparos (convite pro grupo): por minuto; o espaçamento/teto/janela
  //     internos controlam a cadência real (anti-ban). Pausado por padrão.
  cron.schedule('* * * * *', () => { runBroadcast(); }, opts);
  // 3d. aquecedor de chips: por minuto; espacamento/janela/teto internos
  //     controlam a cadencia. Roda continuo enquanto warmer_enabled='on'.
  cron.schedule('* * * * *', () => { runWarmer(); }, opts);
  // 5. Instagram: checa a cada 5min; a cadência (postEveryHours), o teto/dia, a
  //    janela e o flag enabled internos controlam quando realmente posta.
  cron.schedule('*/5 * * * *', () => { runInstagramExecutor(); }, opts);
  // 5b. refresh do long-lived token do IG: 1x/dia às 04:20 (renova só quando
  //     falta pouco p/ expirar; roda mesmo pausado p/ não deixar o token morrer).
  cron.schedule('20 4 * * *', () => { runInstagramTokenRefresh(); }, opts);
  // 4. resumo diário 22:30
  cron.schedule('30 22 * * *', () => { runDailySummary(); }, opts);
  // 6. healthcheck do Telegram a cada 10min: detecta sessão revogada DEPOIS do
  //    boot (isMonitorRunning() sozinho não pegaria isso) e avisa o dono.
  cron.schedule('*/10 * * * *', () => { checkTelegramHealth(); }, opts);
  // 7. purga diária de mensagens da IA (aba Conversas) com mais de 30 dias — LGPD.
  cron.schedule('15 3 * * *', () => {
    purgeOldMessages(30)
      .then((n) => { if (n > 0) console.log(`[scheduler] purga de mensagens: ${n} registro(s) com mais de 30 dias removido(s)`); })
      .catch((err) => console.log(`[scheduler] erro na purga de mensagens: ${err.message}`));
  }, opts);

  // boot: sourcing em ~30s; plano do dia se ainda não existir
  setTimeout(() => { runSourcing(); }, 30_000);
  planTodaySlots({ onBoot: true });

  console.log(
    `[scheduler] iniciado (tz ${config.tz}): sourcing a cada 3h, plano 00:05, executor por minuto, resumo 22:30`
  );
}
