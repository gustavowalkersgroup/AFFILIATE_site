// Nó "Escolher grupo" do workflow "Grupo Fitness — Link Inteligente" (n8n self-hosted).
// Webhook GET → descobre os grupos da instância na Evolution, escolhe o primeiro com
// vaga e devolve { redirect } (ou { message } HTML quando não dá pra redirecionar).
// O placeholder __EVOLUTION_APIKEY__ é substituído na geração do JSON de import.

const CONFIG = {
  evolutionUrl: 'http://10.0.0.254:8080',
  apikey: '__EVOLUTION_APIKEY__',
  instance: 'affiliate-fitness',
  capacity: 1024,
  margin: 8,                       // considera "cheio" em capacity - margin (1016)
  subjectFilter: '',               // se preenchido, só grupos cujo nome contenha isso
  ownerJid: '551930971505@s.whatsapp.net',
  alertCooldownMs: 6 * 3600 * 1000,
  cacheTtlMs: 60 * 1000,
};

const FALLBACK_MSG =
  '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
  '<body style="font-family:sans-serif;text-align:center;padding:48px 16px;background:#111;color:#eee">' +
  '<h2>⏳ Um instante…</h2><p>Estamos preparando seu convite pro grupo.<br>Atualize a página em alguns segundos.</p></body></html>';

const q = ($input.first().json && $input.first().json.query) || {};
const sd = $getWorkflowStaticData('global');
const now = Date.now();
const out = (redirect, message, extra) =>
  [{ json: Object.assign({ redirect: redirect || '', message: message || '' }, extra || {}) }];

const evo = async (path, body) => {
  const opt = {
    url: CONFIG.evolutionUrl + path,
    headers: { apikey: CONFIG.apikey, 'Content-Type': 'application/json' },
    json: true,
    timeout: 15000,
  };
  if (body) { opt.method = 'POST'; opt.body = body; }
  return await this.helpers.httpRequest(opt);
};

// 1. Lista de grupos (cache de 60s; em erro, reusa o último cache conhecido)
let groups = null;
try {
  if (sd.gcache && now - sd.gcache.at < CONFIG.cacheTtlMs) {
    groups = sd.gcache.groups;
  } else {
    const all = await evo(`/group/fetchAllGroups/${CONFIG.instance}?getParticipants=false`);
    if (Array.isArray(all)) {
      groups = all
        .filter((g) => g && g.id)
        .map((g) => ({ jid: g.id, subject: g.subject || '', size: Number(g.size) || 0 }))
        .filter((g) => !CONFIG.subjectFilter || g.subject.toLowerCase().includes(CONFIG.subjectFilter.toLowerCase()))
        .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR', { numeric: true }));
      sd.gcache = { at: now, groups };
    }
  }
} catch (e) {
  groups = (sd.gcache && sd.gcache.groups) || null;
}

if (!groups || !groups.length) {
  if (q.debug === '1') return out('', '<pre>sem grupos / instância indisponível</pre>');
  return out('', FALLBACK_MSG);
}

// 2. Primeiro grupo com vaga (ordem alfabética numérica: #1, #2, ...)
const limit = CONFIG.capacity - CONFIG.margin;
let target = groups.find((g) => g.size < limit);
const allFull = !target;
if (allFull) target = groups.slice().sort((a, b) => a.size - b.size)[0]; // menos cheio

// 3. Link de convite (cache permanente por JID — só muda se for revogado)
sd.invites = sd.invites || {};
let invite = sd.invites[target.jid];
if (!invite) {
  try {
    const r = await evo(`/group/inviteCode/${CONFIG.instance}?groupJid=${encodeURIComponent(target.jid)}`);
    const code = r && (r.inviteCode || (r.inviteUrl ? String(r.inviteUrl).split('/').pop() : null));
    if (code) {
      invite = 'https://chat.whatsapp.com/' + code;
      sd.invites[target.jid] = invite;
    }
  } catch (e) { /* segue pro fallback */ }
}

// 4. Todos cheios → avisa o dono (1x por cooldown) pra criar o próximo grupo
if (allFull && (!sd.lastFullAlert || now - sd.lastFullAlert > CONFIG.alertCooldownMs)) {
  sd.lastFullAlert = now;
  try {
    const sizes = groups.map((g) => `${g.subject}: ${g.size}`).join(' · ');
    await evo(`/message/sendText/${CONFIG.instance}`, {
      number: CONFIG.ownerJid,
      options: { delay: 1200 },
      textMessage: {
        text: `⚠️ GRUPOS LOTADOS no link inteligente (limite ${limit}/grupo).\n${sizes}\n\nCria o próximo grupo no chip que ele entra na rotação automaticamente.`,
      },
    });
  } catch (e) { /* alerta é best-effort */ }
}

if (q.debug === '1') {
  return out('', '<pre>' + JSON.stringify({ groups, escolhido: target, todosCheios: allFull, invite: invite || null }, null, 2) + '</pre>');
}
if (!invite) return out('', FALLBACK_MSG);
return out(invite, '');
