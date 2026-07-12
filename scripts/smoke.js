// scripts/smoke.js — checagens rápidas do sistema, sem efeitos externos destrutivos.
// Roda com: npm run smoke
//
// Imprime PASS/FAIL/WARN por item:
//   PASS/FAIL → DB, assinatura Shopee, score, copy (#publi), parsers de URL
//   WARN      → Ollama e Evolution fora do ar (serviços externos; não derrubam o smoke)
// Exit code 1 se houver algum FAIL. WARNs não falham.

import { config } from '../src/config.js';

const counts = { PASS: 0, FAIL: 0, WARN: 0 };

function report(status, name, detail = '') {
  counts[status]++;
  console.log(`[smoke] ${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`);
}
const pass = (name, detail) => report('PASS', name, detail);
const fail = (name, detail) => report('FAIL', name, detail);
const warn = (name, detail) => report('WARN', name, detail);

// ---------------------------------------------------------------------------
// 1. Banco: SELECT 1 + migrate (schema idempotente — pode rodar sempre)
// ---------------------------------------------------------------------------
let db = null; // guardado para fechar o pool no fim

async function checkDb() {
  try {
    db = await import('../src/db.js');
    await db.query('SELECT 1');
    await db.migrate();
    pass('db', 'SELECT 1 ok + schema aplicado (migrate)');
  } catch (err) {
    fail('db', err.message);
  }
}

// ---------------------------------------------------------------------------
// 2. Assinatura Shopee: exercita a função REAL (shopee.buildSignature) contra
//    um vetor conhecido. Se a implementação regredir (ex.: virar HMAC, mudar a
//    ordem de concatenação), este teste FALHA — não recalculamos inline.
// ---------------------------------------------------------------------------
async function checkShopeeSignature() {
  try {
    const { buildSignature } = await import('../src/shopee.js');

    const appId = '18305620338';
    const ts = 1718000000; // segundos unix
    // payloadString deve ser byte-idêntico ao body enviado (JSON.stringify uma vez)
    const payload = JSON.stringify({ query: '{productOfferV2(){nodes{itemId}}}' });
    const secret = 'SMOKETESTSECRET';

    const sig = buildSignature(appId, ts, payload, secret);

    // sha256_hex('18305620338' + '1718000000' + payload + 'SMOKETESTSECRET')
    // (vetor pré-calculado com SHA256 puro — NÃO HMAC)
    const expected = '750569d28d070d802e064b8b9fa6b8f6682e434b89a24382c45fe96706acaa17';

    if (sig === expected) {
      pass('shopee-signature', 'buildSignature(appId, ts, payload, secret) bate com o vetor conhecido');
    } else {
      fail('shopee-signature', `esperado ${expected}, obtido ${sig}`);
    }

    if (!config.shopee.appId) {
      warn('shopee-credentials', 'SHOPEE_APP_ID vazio no .env — sourcing da Shopee ficará desligado');
    }
  } catch (err) {
    fail('shopee-signature', err.message);
  }
}

// ---------------------------------------------------------------------------
// 3. Score de oferta exemplo (ranking.scoreOffer)
// ---------------------------------------------------------------------------
async function checkScore() {
  try {
    const { scoreOffer } = await import('../src/ranking.js');
    const r = config.ranking;

    // Oferta boa: acima de todos os pisos configurados → score em (0, 100]
    const good = {
      marketplace: 'shopee',
      source: 'api',
      title: 'Oferta exemplo',
      price: 47.9,
      commissionRate: Math.max(r.minCommission, 0.12),
      discountPct: Math.max(r.minDiscount, 35),
      sales: Math.max(r.minSales, 500),
      rating: Math.max(r.minRating, 4.8),
    };
    const score = scoreOffer(good);
    if (Number.isFinite(score) && score > 0 && score <= 100) {
      pass('score', `oferta exemplo pontuou ${score} (0 < score <= 100)`);
    } else {
      fail('score', `oferta acima dos pisos deveria pontuar em (0, 100], obtido: ${score}`);
    }

    // Oferta ruim: desconto abaixo do piso → 0 (só testável se houver piso > 0)
    if (r.minDiscount > 0) {
      const bad = { ...good, discountPct: r.minDiscount - 1 };
      const zero = scoreOffer(bad);
      if (zero === 0) {
        pass('score-floor', `desconto ${r.minDiscount - 1}% (abaixo do piso ${r.minDiscount}%) → score 0`);
      } else {
        fail('score-floor', `oferta abaixo do piso de desconto deveria pontuar 0, obtido: ${zero}`);
      }
    }
  } catch (err) {
    fail('score', err.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Copy: templateCopy + assembleMessage de oferta fake
//    (mensagem final deve conter '#publi', 'R$' e o link de afiliado)
// ---------------------------------------------------------------------------
async function checkCopy() {
  try {
    const { templateCopy, assembleMessage } = await import('../src/copy.js');

    const fakeOffer = {
      marketplace: 'shopee',
      source: 'api',
      title: 'Whey Protein Concentrado 900g',
      price: 47.9,
      price_from: 79.9,
      discount_pct: 40,
      affiliate_url: 'https://s.shopee.com.br/smoketest',
      image_url: null,
    };

    const hook = templateCopy(fakeOffer);
    if (typeof hook !== 'string' || hook.trim().length < 10) {
      fail('copy-template', `templateCopy retornou gancho inválido: ${JSON.stringify(hook)}`);
      return;
    }
    pass('copy-template', `gancho gerado (${hook.length} chars)`);

    const msg = assembleMessage(fakeOffer, hook);
    const problems = [];
    if (!msg.includes('#publi')) problems.push("falta '#publi'");
    if (!msg.includes('R$')) problems.push("falta 'R$'");
    if (!msg.includes('47,90')) problems.push("falta preço formato BR '47,90'");
    if (!msg.includes(fakeOffer.affiliate_url)) problems.push('falta o link de afiliado');

    if (problems.length === 0) {
      pass('copy-message', "mensagem final contém '#publi', 'R$', preço BR e link");
    } else {
      fail('copy-message', problems.join('; '));
    }
  } catch (err) {
    fail('copy', err.message);
  }
}

// ---------------------------------------------------------------------------
// 5. Parsers de URL (3 casos por marketplace)
// ---------------------------------------------------------------------------
async function checkUrlParsers() {
  let links;
  try {
    links = await import('../src/links.js');
  } catch (err) {
    fail('links', `não consegui importar src/links.js: ${err.message}`);
    return;
  }

  // --- Shopee ---
  try {
    const s1 = links.parseShopeeUrl('https://shopee.com.br/Whey-Protein-Concentrado-900g-i.339310585.23816017903');
    if (s1 && String(s1.shopId) === '339310585' && String(s1.itemId) === '23816017903') {
      pass('shopee-url-slug', 'formato <slug>-i.<shopId>.<itemId>');
    } else {
      fail('shopee-url-slug', `esperado shopId=339310585/itemId=23816017903, obtido ${JSON.stringify(s1)}`);
    }

    const s2 = links.parseShopeeUrl('https://shopee.com.br/product/339310585/23816017903');
    if (s2 && String(s2.shopId) === '339310585' && String(s2.itemId) === '23816017903') {
      pass('shopee-url-product', 'formato /product/<shopId>/<itemId>');
    } else {
      fail('shopee-url-product', `obtido ${JSON.stringify(s2)}`);
    }

    if (links.isShopeeUrl('https://shope.ee/4fjqJxPYJN') && !links.isShopeeUrl('https://www.google.com/')) {
      pass('shopee-url-short', 'isShopeeUrl reconhece shope.ee (e rejeita domínio alheio)');
    } else {
      fail('shopee-url-short', 'isShopeeUrl não reconheceu shope.ee ou aceitou domínio alheio');
    }
  } catch (err) {
    fail('shopee-url', err.message);
  }

  // --- Mercado Livre ---
  try {
    const m1 = links.parseMeliUrl('https://www.mercadolivre.com.br/creatina-monohidratada-300g/p/MLB19613679');
    if (m1 && /^MLB-?19613679$/i.test(String(m1.mlbId))) {
      pass('meli-url-produto', 'formato /p/MLB<id>');
    } else {
      fail('meli-url-produto', `esperado mlbId MLB19613679, obtido ${JSON.stringify(m1)}`);
    }

    const m2 = links.parseMeliUrl('https://produto.mercadolivre.com.br/MLB-3633970777-halteres-ajustaveis-_JM');
    if (m2 && /^MLB-?3633970777$/i.test(String(m2.mlbId))) {
      pass('meli-url-anuncio', 'formato MLB-<id> de anúncio');
    } else {
      fail('meli-url-anuncio', `esperado mlbId MLB3633970777, obtido ${JSON.stringify(m2)}`);
    }

    const m3 = links.parseMeliUrl('https://mercadolivre.com/sec/1abcDEF');
    if (m3 && m3.short === true && links.isMeliUrl('https://mercadolivre.com/sec/1abcDEF')) {
      pass('meli-url-sec', 'link curto /sec/ reconhecido como { short: true }');
    } else {
      fail('meli-url-sec', `esperado { short: true }, obtido ${JSON.stringify(m3)}`);
    }
  } catch (err) {
    fail('meli-url', err.message);
  }
}

// ---------------------------------------------------------------------------
// 6. Ollama (/api/version) — WARN se fora do ar (copy cai no template)
// ---------------------------------------------------------------------------
async function checkOllama() {
  try {
    const res = await fetch(`${config.ollama.url}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      pass('ollama', `respondendo em ${config.ollama.url} (versão ${json.version ?? '?'}; modelo configurado: ${config.ollama.model})`);
    } else {
      warn('ollama', `HTTP ${res.status} em ${config.ollama.url}/api/version — copy usará só templates`);
    }
  } catch (err) {
    warn('ollama', `fora do ar em ${config.ollama.url} (${err.message}) — copy usará só templates`);
  }
}

// ---------------------------------------------------------------------------
// 7. Evolution API (GET /) — WARN se fora do ar (sem WhatsApp não há postagem)
// ---------------------------------------------------------------------------
async function checkEvolution() {
  try {
    const res = await fetch(`${config.evolution.url}/`, {
      headers: config.evolution.apikey ? { apikey: config.evolution.apikey } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      pass('evolution', `respondendo em ${config.evolution.url} (versão ${json.version ?? '?'}; instância: ${config.evolution.instance})`);
    } else {
      warn('evolution', `HTTP ${res.status} em ${config.evolution.url}/ — verifique EVOLUTION_URL/EVOLUTION_APIKEY`);
    }
  } catch (err) {
    warn('evolution', `fora do ar em ${config.evolution.url} (${err.message}) — postagem no WhatsApp indisponível`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  console.log('[smoke] iniciando checagens (nada destrutivo)...');

  await checkDb();
  await checkShopeeSignature();
  await checkScore();
  await checkCopy();
  await checkUrlParsers();
  await checkOllama();
  await checkEvolution();

  console.log(`[smoke] resultado: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`);

  if (db?.pool) {
    try { await db.pool.end(); } catch { /* ignore */ }
  }

  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.log(`[smoke] erro inesperado: ${err.message}`);
  process.exit(1);
});
