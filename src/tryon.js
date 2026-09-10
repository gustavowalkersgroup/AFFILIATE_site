// Virtual try-on: veste o avatar-base com a foto do produto via OpenAI gpt-image-1
// (POST /v1/images/edits, multi-image input). Reusa config.copy.openai.apiKey —
// mesma chave já usada em copy.js, sem infra/conta nova.
//
// Erros de rede/API NUNCA derrubam o processo: sempre retorna null em falha,
// o caller (poster.js) cai no offer.image_url original.
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { isMasculineTitle } from './ranking.js';

const avatarCache = new Map();
function loadAvatar(path) {
  if (avatarCache.has(path)) return avatarCache.get(path);
  try {
    const buf = readFileSync(path);
    avatarCache.set(path, buf);
    return buf;
  } catch (err) {
    console.log(`[tryon] avatar não encontrado em ${path}: ${err.message}`);
    avatarCache.set(path, null);
    return null;
  }
}

// Fotos extras da mesma modelo (poses/ângulos diferentes) — sorteia 1 por
// chamada além do avatar-base, em vez de mandar todas sempre (cada imagem a
// mais soma tempo/custo no request; 1 extra já ajuda a fixar identidade sem
// piorar o timeout). Só se aplica ao avatar feminino (padrão do sistema).
function pickAvatarRef() {
  const paths = config.tryon.avatarRefPaths;
  if (!paths.length) return null;
  const path = paths[Math.floor(Math.random() * paths.length)];
  return loadAvatar(path);
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
function acoesCalcados(pessoa, pronome) {
  return [
    `CALCE a peça nos pés d${pronome} ${pessoa}, os dois pés visíveis, calçado corretamente`,
    `${pessoa} segurando o calçado na mão, mostrando bem os detalhes, como em foto de divulgação`,
    `o calçado em exibição numa prateleira ou superfície ao lado d${pronome} ${pessoa}, ele(a) por perto olhando ou apontando pra ele`,
  ];
}

// Como aplicar o produto no corpo, por categoria — evita o modelo "escolher"
// (ex.: segurar uma regata na mão em vez de vestir).
function acaoPorCategoria(category, isMale) {
  const pessoa = isMale ? 'o modelo' : 'a modelo';
  const pronome = isMale ? 'o' : 'a';
  switch (category) {
    case 'roupas':
      return `VISTA a peça no corpo d${pronome} ${pessoa} (nunca segure na mão — é roupa, deve estar vestida)`;
    case 'calcados':
      return randomPick(acoesCalcados(pessoa, pronome));
    default:
      return `${pessoa} segurando o produto na mão, visível e em destaque, como em foto de divulgação`;
  }
}

function buildPrompt(offer, { isMale = false, hasExtraRef = false } = {}) {
  const cenario = randomPick(CENARIOS);
  const pose = randomPick(POSES);
  const acao = acaoPorCategoria(offer.category, isMale);
  const pessoa = isMale ? 'o modelo' : 'a modelo';
  const biotipo = isMale
    ? `Preserve também EXATAMENTE o físico dele: mesmo porte, definição muscular e postura da imagem 1.`
    : `Preserve também EXATAMENTE o tipo de corpo dela: mesmo biotipo, mesma quantidade de curvas, ` +
      `mesma largura de quadril/coxa/braço — ela é uma mulher curvy e ATLÉTICA, corpo de academia/fitness, ` +
      `tonificada, NÃO obesa, NÃO com sobrepeso genérico, e também NÃO mais magra ou mais fina do que ` +
      `nas imagens de referência.`;
  const lembreteBiotipo = isMale
    ? 'mesmo físico e postura, sem alterar o porte dele'
    : 'mesmo biotipo curvy e atlético (fitness, tonificada), sem emagrecer nem engordar a modelo';
  const indiceProduto = hasExtraRef ? 'imagem 3' : 'imagem 2';
  const refExtra = hasExtraRef
    ? `Imagens 1 e 2 mostram a MESMA pessoa em ângulos/poses diferentes — use as duas juntas ` +
      `pra entender melhor a aparência real d${isMale ? 'ele' : 'ela'} (rosto, corpo, proporções). `
    : '';
  return (
    `CRÍTICO — preserve EXATAMENTE o rosto, feições, formato do nariz/boca/olhos, cor de ` +
    `pele e cabelo d${isMale ? 'o' : 'a'} ${pessoa} da(s) imagem(ns) de referência. Atenção especial ` +
    `aos olhos: mantenha os dois olhos simétricos, abertos igualmente, olhando na mesma direção ` +
    `reta pra câmera — nunca gere olhar torto, vesgo, desalinhado ou com um olho mais fechado/virado ` +
    `que o outro. ${refExtra}${biotipo} ` +
    `Não altere a identidade nem o biotipo d${isMale ? 'ele' : 'ela'} de forma alguma. ` +
    `A ${indiceProduto} é o produto real: mantenha fielmente a cor, estampa, textura e formato exatos ` +
    `— não invente nem distorça texto/logo do produto; se não conseguir reproduzir o texto ` +
    `com nitidez, prefira simplificar a estampa a gerar texto ilegível. ` +
    `Ação obrigatória: ${acao}. ` +
    `Produto: "${offer.title || 'produto'}". Cenário: ${cenario}. Pose: ${pose}. ` +
    `Foto realista, estilo comercial, iluminação natural. ` +
    `Lembrete final: rosto E corpo d${isMale ? 'o modelo' : 'a modelo'} devem ficar IDÊNTICOS ao das ` +
    `imagens de referência — ${lembreteBiotipo}.`
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

  // Avatar padrão é feminino. Produto masculino: só faz sentido usar o avatar
  // homem quando dá pra vestir/calçar de verdade (roupa ou calçado). Fora
  // isso (ex.: segurar um item na mão), gênero do avatar é irrelevante e o
  // padrão do sistema (pular, cair na foto original) evita risco à toa.
  const masculino = isMasculineTitle(offer.title);
  const usaAvatarMasculino = masculino && ['roupas', 'calcados'].includes(offer.category);
  if (masculino && !usaAvatarMasculino) {
    console.log(`[tryon] produto masculino (#${offer.id}, categoria ${offer.category}) — pulando, usando foto original`);
    return null;
  }

  const avatarPath = usaAvatarMasculino ? config.tryon.avatarPathMasculino : config.tryon.avatarPath;
  const avatar = loadAvatar(avatarPath);
  if (!avatar) return null;
  // Ref extra (pose/ângulo diferente da mesma pessoa) só existe pro avatar
  // feminino por enquanto — melhora fidelidade sem inflar toda chamada.
  const avatarRef = usaAvatarMasculino ? null : pickAvatarRef();

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
    form.append('prompt', buildPrompt(offer, { isMale: usaAvatarMasculino, hasExtraRef: !!avatarRef }));
    form.append('size', '1024x1536');
    form.append('quality', config.tryon.quality);
    form.append('image[]', new Blob([avatar], { type: 'image/png' }), 'avatar.png');
    if (avatarRef) {
      form.append('image[]', new Blob([avatarRef], { type: 'image/png' }), 'avatar-ref.png');
    }
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
