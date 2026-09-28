// Setup dos grupos espelho na Evolution API v1.8.6.
// Uso: node scripts/setup-groups.js [prefixo] [n]   (default: 'Achadinhos Fitness', 5)
// 1) confirma/cria a instância (QR p/ conectar)  2) cria N grupos announcement
// 3) configura o webhook MESSAGES_UPSERT  4) salva os JIDs na tabela groups.
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { query, pool } from '../src/db.js';

const prefix = process.argv[2] || 'Achadinhos Fitness';
const n = Number(process.argv[3] || 5);
const instance = config.evolution.instance;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cliente HTTP local (precisa de PUT, que o poster.evoFetch não expõe).
async function evo(method, path, body) {
  const url = config.evolution.url + path;
  try {
    const res = await fetch(url, {
      method,
      headers: { apikey: config.evolution.apikey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.log('[setup-groups] HTTP ' + res.status + ' em ' + method + ' ' + path + ': ' + JSON.stringify(json));
      return null;
    }
    return json;
  } catch (err) {
    console.log('[setup-groups] erro de rede em ' + method + ' ' + path + ': ' + err.message);
    return null;
  }
}

async function instanceExists() {
  const list = await evo('GET', '/instance/fetchInstances');
  if (!Array.isArray(list)) return false;
  return list.some((it) => (it.instance?.instanceName ?? it.instanceName) === instance);
}

async function connectionState() {
  const res = await evo('GET', '/instance/connectionState/' + instance);
  return res?.instance?.state ?? res?.state ?? null;
}

async function ensureConnected() {
  const state = await connectionState();
  if (state === 'open') {
    console.log('[setup-groups] instância "' + instance + '" conectada.');
    return true;
  }

  const conn = await evo('GET', '/instance/connect/' + instance);
  console.log('[setup-groups] instância ainda não conectada (state=' + state + ').');
  console.log('[setup-groups] Escaneie o QR no app Evolution/Manager ou gere um QR com o code abaixo:');
  console.log('[setup-groups] code: ' + (conn?.code ?? '(indisponível)'));

  // Aguarda até 2 minutos pela leitura do QR.
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const s = await connectionState();
    if (s === 'open') {
      console.log('[setup-groups] conectado!');
      return true;
    }
    console.log('[setup-groups] aguardando conexão... (state=' + (s ?? '?') + ')');
  }
  console.log('[setup-groups] tempo esgotado. Escaneie o QR e rode o script de novo.');
  return false;
}

async function ensureInstance() {
  if (await instanceExists()) {
    console.log('[setup-groups] instância "' + instance + '" já existe.');
  } else {
    const token = instance + '-' + crypto.randomBytes(4).toString('hex');
    console.log('[setup-groups] criando instância "' + instance + '"...');
    const created = await evo('POST', '/instance/create', {
      instanceName: instance,
      token,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });
    if (!created) {
      console.log('[setup-groups] falha ao criar a instância — verifique EVOLUTION_URL/EVOLUTION_APIKEY.');
      return false;
    }
    console.log('[setup-groups] instância criada (token: ' + token + ').');
  }
  return ensureConnected();
}

async function createGroups() {
  if (!config.evolution.ownerJid) {
    console.log('[setup-groups] OWNER_JID vazio no .env — necessário p/ participar dos grupos.');
    return [];
  }
  const ownerNumber = config.evolution.ownerJid.replace(/@s\.whatsapp\.net$/, '');
  const created = [];

  for (let i = 1; i <= n; i++) {
    const subject = prefix + ' #' + i;

    // Idempotência: se já existe grupo com esse nome no banco, não cria de novo.
    const existing = await query('SELECT jid FROM groups WHERE name = $1', [subject]);
    if (existing.rows.length) {
      console.log('[setup-groups] "' + subject + '" já existe no banco (' + existing.rows[0].jid + ') — pulando.');
      created.push({ subject, jid: existing.rows[0].jid });
      continue;
    }

    const res = await evo('POST', '/group/create/' + instance, {
      subject,
      participants: [ownerNumber],
    });
    const jid = res?.id ?? res?.groupJid ?? res?.group?.id ?? null;
    if (!jid) {
      console.log('[setup-groups] falha ao criar "' + subject + '" — resposta: ' + JSON.stringify(res));
      continue;
    }
    console.log('[setup-groups] grupo criado: "' + subject + '" → ' + jid);

    await query(
      `INSERT INTO groups (jid, name, enabled, position)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name, enabled = true, position = EXCLUDED.position`,
      [jid, subject, i - 1]
    );

    // Só admins postam (announcement) → menos denúncia de membros.
    const setRes = await evo(
      'PUT',
      '/group/updateSetting/' + instance + '?groupJid=' + encodeURIComponent(jid),
      { groupJid: jid, action: 'announcement' }
    );
    console.log('[setup-groups] announcement ' + (setRes ? 'ok' : 'FALHOU') + ' em ' + jid);

    created.push({ subject, jid });
    await sleep(3000); // espaçamento entre criações
  }
  return created;
}

async function setupWebhook() {
  // Com WEBHOOK_TOKEN no .env o path leva o segredo — sem ele, qualquer host
  // com acesso à porta consegue forjar comandos do dono (instance/remoteJid
  // do payload são adivinháveis).
  if (!config.webhookToken) {
    console.log('[setup-groups] AVISO: WEBHOOK_TOKEN vazio no .env — webhook sem segredo na URL (payload forjável). Defina WEBHOOK_TOKEN e rode este script de novo.');
  }
  const path = '/webhook/evolution' + (config.webhookToken ? '/' + config.webhookToken : '');
  const url = 'http://10.0.0.254:' + config.port + path;
  const res = await evo('POST', '/webhook/set/' + instance, {
    webhook: {
      url,
      enabled: true,
      byEvents: false,
      base64: false,
      events: ['MESSAGES_UPSERT', 'GROUP_PARTICIPANTS_UPDATE'],
    },
  });
  // NUNCA loga a URL completa — o path carrega o WEBHOOK_TOKEN (segredo).
  console.log('[setup-groups] webhook ' + (res ? 'configurado' : 'FALHOU') + ' (instância ' + instance + ')');
}

async function main() {
  console.log('[setup-groups] prefixo="' + prefix + '" n=' + n + ' instância="' + instance + '"');

  if (!(await ensureInstance())) {
    process.exit(1);
  }

  const groups = await createGroups();
  await setupWebhook();

  console.log('[setup-groups] resumo — ' + groups.length + ' grupo(s):');
  for (const g of groups) {
    console.log('[setup-groups]   ' + g.subject + ' → ' + g.jid);
  }

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.log('[setup-groups] erro fatal:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
