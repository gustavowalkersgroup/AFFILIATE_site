// Virtual try-on: veste o avatar-base com a foto do produto via OpenAI gpt-image-1
// (POST /v1/images/edits, multi-image input). Reusa config.copy.openai.apiKey —
// mesma chave já usada em copy.js, sem infra/conta nova.
//
// Erros de rede/API NUNCA derrubam o processo: sempre retorna null em falha,
// o caller (poster.js) cai no offer.image_url original.
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { isMasculineTitle } from './ranking.js';

let avatarBuffer = null;
function loadAvatar() {
  if (avatarBuffer) return avatarBuffer;
  try {
    avatarBuffer = readFileSync(config.tryon.avatarPath);
    return avatarBuffer;
  } catch (err) {
    console.log(`[tryon] avatar-base não encontrado em ${config.tryon.avatarPath}: ${err.message}`);
    return null;
  }
}

// Cenário + pose sorteados por chamada — evita feed repetitivo. Sempre reforça
// "mantenha rosto/cabelo/identidade da modelo" pra preservar consistência do avatar.
const CENARIOS = [
  'em uma academia moderna ao fundo, aparelhos desfocados, iluminação quente',
  'em uma cozinha clara e moderna, bancada branca ao fundo',
  'ao ar livre em um parque ensolarado, árvores desfocadas ao fundo',
  'em um quarto/closet minimalista, luz natural de janela',
  'na rua, ambiente urbano desfocado ao fundo, luz de tarde',
  'em um estúdio fotográfico com fundo cinza neutro',
];

const POSES = [
  'em pé, pose casual, sorrindo pra câmera',
  'sentada, pose relaxada, sorrindo',
  'segurando o produto na mão na altura do peito, pose de divulgação',
  'em pé com uma mão na cintura, pose confiante',
  'de lado, olhando pra câmera por cima do ombro',
];

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Calçado é geometricamente difícil pro modelo calçar corretamente (pé+perna+sapato
// exige mais precisão espacial que vestir tronco) — em vez de forçar uma única ação
// que o modelo tende a ignorar, sorteia entre variações válidas de divulgação.
const ACOES_CALCADOS = [
  'CALCE a peça nos pés da modelo, os dois pés visíveis, calçado corretamente',
  'a modelo segurando o calçado na mão, mostrando bem os detalhes, como em foto de divulgação',
  'o calçado em exibição numa prateleira ou superfície ao lado da modelo, ela por perto olhando ou apontando pra ele',
];

// Como aplicar o produto no corpo, por categoria — evita o modelo "escolher"
// (ex.: segurar uma regata na mão em vez de vestir).
function acaoPorCategoria(category) {
  switch (category) {
    case 'roupas':
      return 'VISTA a peça no corpo da modelo (nunca segure na mão — é roupa, deve estar vestida)';
    case 'calcados':
      return randomPick(ACOES_CALCADOS);
    default:
      return 'segure o produto na mão, visível e em destaque, como em foto de divulgação';
  }
}

function buildPrompt(offer) {
  const cenario = randomPick(CENARIOS);
  const pose = randomPick(POSES);
  const acao = acaoPorCategoria(offer.category);
  return (
    `CRÍTICO — preserve EXATAMENTE o rosto, feições, formato do nariz/boca/olhos, cor de ` +
    `pele e cabelo da modelo da imagem 1. Preserve também EXATAMENTE o tipo de corpo dela: ` +
    `mesmo biotipo, mesma quantidade de curvas, mesma largura de quadril/coxa/braço — ela é ` +
    `uma mulher de corpo cheio/curvy, NÃO a deixe mais magra, mais fina ou com corpo diferente. ` +
    `Não altere a identidade nem o biotipo dela de forma alguma. ` +
    `Imagem 2 é o produto real: mantenha fielmente a cor, estampa, textura e formato exatos ` +
    `— não invente nem distorça texto/logo do produto; se não conseguir reproduzir o texto ` +
    `com nitidez, prefira simplificar a estampa a gerar texto ilegível. ` +
    `Ação obrigatória: ${acao}. ` +
    `Produto: "${offer.title || 'produto'}". Cenário: ${cenario}. Pose: ${pose}. ` +
    `Foto realista, estilo comercial, iluminação natural. ` +
    `Lembrete final: rosto E corpo da imagem 1 devem ficar IDÊNTICOS no resultado — mesmo ` +
    `biotipo curvy, sem emagrecer nem afinar a modelo.`
  );
}

/**
 * Gera imagem de try-on (avatar + produto) em base64 (PNG), ou null em qualquer falha.
 * Sempre com timeout curto (config.tryon.timeoutMs) — nunca trava o caller.
 */
export async function generateTryOnImage(offer) {
  if (!config.tryon.enabled) return null;
  if (!config.copy.openai.apiKey) {
    console.log('[tryon] sem OPENAI apiKey configurada — pulando');
    return null;
  }
  if (!offer.image_url) return null;
  // Avatar é feminino — produto explicitamente masculino não deve ser "vestido"
  // nela. Cai na foto original do produto.
  if (isMasculineTitle(offer.title)) {
    console.log(`[tryon] produto masculino (#${offer.id}) — pulando, usando foto original`);
    return null;
  }

  const avatar = loadAvatar();
  if (!avatar) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tryon.timeoutMs);

  try {
    const productRes = await fetch(offer.image_url, { signal: controller.signal });
    if (!productRes.ok) {
      console.log(`[tryon] falha ao baixar foto do produto (HTTP ${productRes.status}) — pulando`);
      return null;
    }
    const productBuffer = Buffer.from(await productRes.arrayBuffer());
    // OpenAI só aceita mimetype puro (sem "; charset=..." etc) — alguns CDNs (Shopee)
    // mandam esse parâmetro extra, que a API rejeita com HTTP 400.
    const rawType = (productRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const productType = ['image/jpeg', 'image/png', 'image/webp'].includes(rawType) ? rawType : 'image/jpeg';

    const form = new FormData();
    form.append('model', config.tryon.model);
    form.append('prompt', buildPrompt(offer));
    form.append('size', '1024x1536');
    form.append('quality', config.tryon.quality);
    form.append('image[]', new Blob([avatar], { type: 'image/png' }), 'avatar.png');
    form.append('image[]', new Blob([productBuffer], { type: productType }), 'produto.jpg');

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.copy.openai.apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`[tryon] OpenAI falhou (HTTP ${res.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) {
      console.log('[tryon] resposta sem imagem — pulando');
      return null;
    }
    return b64;
  } catch (err) {
    const motivo = err?.name === 'AbortError' ? `timeout ${config.tryon.timeoutMs}ms` : err?.message;
    console.log(`[tryon] falhou (${motivo}) — usando foto original`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
