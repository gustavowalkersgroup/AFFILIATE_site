// Login interativo no Telegram (GramJS): gera a StringSession p/ o .env.
// Uso: npm run telegram:login  (ou node scripts/telegram-login.js)
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../src/config.js';

const rl = readline.createInterface({ input, output });

async function ask(label) {
  return (await rl.question(label)).trim();
}

async function main() {
  let apiId = config.telegram.apiId;
  let apiHash = config.telegram.apiHash;

  if (!apiId) {
    apiId = Number(await ask('api_id (https://my.telegram.org/apps): '));
  }
  if (!apiHash) {
    apiHash = await ask('api_hash: ');
  }
  if (!apiId || !apiHash) {
    console.log('[telegram-login] api_id/api_hash inválidos — abortando.');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => ask('Telefone (com DDI, ex.: +5511999999999): '),
    password: async () => ask('Senha 2FA (Enter se não tiver): '),
    phoneCode: async () => ask('Código recebido no Telegram: '),
    onError: (err) => console.log('[telegram-login] erro:', err.message),
  });

  console.log('[telegram-login] Login OK!');
  console.log('[telegram-login] Cole a linha abaixo no .env:');
  console.log('');
  console.log('TELEGRAM_SESSION=' + client.session.save());
  console.log('');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.log('[telegram-login] falhou:', err.message);
  process.exit(1);
});
