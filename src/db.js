import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 10_000, // sem isso, connectionTimeoutMillis=0 (espera pra sempre) trava tudo se o Postgres cair/atrasar
});

// Sem listener, um erro num client OCIOSO do pool (restart do Postgres, blip de
// rede, firewall derrubando conexão parada) sobe como 'error' não-tratado no
// EventEmitter e derruba o processo Node INTEIRO (default do Node). Loga e
// segue — o pool descarta o client morto e abre outro na próxima query.
pool.on('error', (err) => {
  console.log(`[db] erro em client ocioso do pool (ignorado, processo segue): ${err.message}`);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

export async function getSetting(key, fallback = null) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}

export async function isPaused() {
  return (await getSetting('paused', 'false')) === 'true';
}

// Executado direto: `npm run migrate` (node src/db.js --migrate). Confere o
// ENTRYPOINT real (argv[1]), não só a presença da flag em algum lugar do argv —
// senão um --migrate que chegue por qualquer outro motivo (wrapper, process
// manager) derruba o pool compartilhado (pool.end()) do processo principal já
// rodando, já que TODO módulo importa este arquivo.
const isEntrypoint = (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || ''); }
  catch { return false; }
})();
if (isEntrypoint && process.argv.includes('--migrate')) {
  migrate()
    .then(() => { console.log('Schema aplicado com sucesso.'); return pool.end(); })
    .catch((err) => { console.error('Erro na migração:', err.message); process.exit(1); });
}
