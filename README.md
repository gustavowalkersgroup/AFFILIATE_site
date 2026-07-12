# AFFILIATE — ofertas fitness no WhatsApp

Sistema simples e cru que **busca ofertas fitness (Shopee + Mercado Livre + canais de promo do Telegram), ranqueia, escreve a copy com IA local e posta automaticamente em 5 grupos espelho de WhatsApp** — com ramp-up gradual, horários aleatórios em janelas de pico, dedup de produto, kill-switch e comandos do dono direto no WhatsApp.

Tudo roda em **1 único processo Node.js** (sem filas, sem microserviço, sem framework além do Express).

---

## 👉 Comece pelo painel (faça tudo por aqui)

Acesse **`http://10.0.0.254:3210/painel`** e entre com a senha (o `ADMIN_TOKEN`). **Quase tudo é self-service pelo painel — sem terminal:**

- **Config** — conectar WhatsApp (QR), Shopee, Mercado Livre, Amazon, AliExpress, Instagram (login guiado), Telegram (login guiado), provedor de IA + chave, número do dono.
- **Operação** — janela de horário, posts/dia, dedup/TTL, pisos do ranking, **mix de categorias e pesos do score**, e **reiniciar aquecimento**.
- **Conteúdo e copy** — termos bloqueados (denylist), linha de publicidade (#publi), rodapé, templates de copy, instrução de estilo da IA.
- **Fontes** — keywords da Shopee, canais do Telegram e **“Buscar ofertas agora”**.
- **Grupos** — **criar grupos espelho** e escolher quais recebem ofertas.
- **Disparos** — disparos/dia, espaçamento, janela, links de convite, contatos.
- **Cabeçalho** — semáforos de saúde (WhatsApp/Instagram/Telegram/Disparos/Ofertas/Copy) e alertas no seu WhatsApp quando algo cai.

O que muda no painel **vale na hora**, sem reiniciar (overrides salvos no banco têm precedência sobre o `.env`).

> **Avançado / fallback:** o `.env` e os scripts CLI abaixo só são necessários para o que **não** vai pelo painel: `EVOLUTION_URL`/`EVOLUTION_APIKEY`, `PORT`, `ADMIN_TOKEN`, `WEBHOOK_TOKEN`, `DATABASE_URL`. Login do Telegram, criação de grupos e busca de ofertas, antes só via CLI, **agora têm botão no painel**.

---

## Arquitetura

```
                        ┌──────────────────────────────────────────────┐
  Shopee Affiliate API  │              processo Node (ESM)             │
  (GraphQL, cron 3h) ──▶│                                              │
                        │  shopee.js ─┐                                │
  Telegram (GramJS,     │  telegram.js ┼▶ ranking.js ──▶ Postgres      │
  canais de promo,   ──▶│  meli.js   ─┘   (score/dedup)  (offers,      │
  tempo real)           │                                 slots, posts)│
                        │  scheduler.js (node-cron):                   │
  Mercado Livre      ──▶│   · plano diário de slots (ramp 4→8→12)      │
  (import manual via    │   · executor por minuto                      │
  endpoint admin)       │       │                                      │
                        │       ▼                                      │
                        │  copy.js ──▶ Ollama local (gancho criativo;  │
                        │              fallback: templates prontos)    │
                        │       │                                      │
                        │       ▼                                      │
                        │  poster.js ──▶ Evolution API v1.8.6 ──▶ 5    │
                        │                (WhatsApp)        grupos espelho
                        │       ▲                                      │
                        │  control.js ◀── webhook (comandos do dono)   │
                        └──────────────────────────────────────────────┘
```

4 peças de infraestrutura:

| Peça | Papel |
|---|---|
| **Node.js 22 (1 processo)** | sourcing, ranking, agendamento, copy, postagem, API admin |
| **Postgres** | ofertas, posts, grupos, slots do dia, keywords, settings (pausa/ramp) |
| **Ollama** (local) | gera o texto-gancho criativo da copy (`llama3.2:3b` por padrão). Se cair, o sistema segue com templates prontos |
| **Evolution API v1.8.6** | ponte com o WhatsApp: envia posts nos grupos, recebe comandos do dono via webhook |

Princípios do código: ESM puro, `fetch` nativo, zero dependência além de `pg`, `express`, `node-cron`, `telegram` e `dotenv`. Erro de rede **nunca** derruba o processo — loga e segue. O LLM **nunca** controla preço nem link: a mensagem final é montada deterministicamente.

### Fluxo de uma postagem

1. **Sourcing** — a cada 3h busca as keywords ativas na Shopee; o monitor do Telegram captura links em tempo real; ofertas do ML entram por import manual.
2. **Ranking** — score 0–100 com pisos (comissão ≥ 5%, desconto ≥ 10%, vendas ≥ 30, nota ≥ 4.3) e pesos (comissão 45% / desconto 35% / popularidade 20%). Dedup: mesmo produto não repete por 7 dias; oferta com mais de 24h expira.
3. **Plano diário** — todo dia 00:05 sorteia N horários dentro da janela 08:00–22:00, com peso extra nos picos (12–14h e 19–21h). N segue o ramp-up: 4 posts/dia na semana 1, 8 na semana 2, 12 da semana 3 em diante.
4. **Executor** — a cada minuto: se chegou a hora de um slot, pega a melhor oferta, gera a copy (Ollama → fallback template), monta a mensagem e posta nos grupos com espaçamento aleatório de 60–180s entre grupos e delay de 3–8s "digitando" por mensagem. A janela 08:00–22:00 vale também na execução: slots vencidos há mais de 30 min (pausa longa/downtime) são pulados em vez de drenados em rajada.
5. **Resumo diário** — às 22:30 o dono recebe no WhatsApp um resumo (posts ok, falhas, top oferta).

---

## Requisitos

- Node.js ≥ 20 (recomendado 22)
- Postgres acessível (banco dedicado, ex.: `affiliate`)
- [Ollama](https://ollama.com) rodando local com um modelo pequeno (`ollama pull llama3.2:3b`)
- [Evolution API](https://doc.evolution-api.com) **v1.8.6** rodando (Docker) com uma key global
- Um **chip/número de WhatsApp dedicado** (NÃO use seu número pessoal como instância — risco de banimento)

## Instalação

```bash
cd /srv/nextags/AFFILIATE
npm install
cp .env.example .env   # e edite (passo a passo abaixo)
npm run migrate        # aplica sql/schema.sql (idempotente)
npm run smoke          # checa DB, assinatura Shopee, score, copy, parsers, Ollama, Evolution
```

---

## Configurando o `.env` passo a passo

Use o `.env.example` como base. Variável por variável:

### 1. Banco

```env
DATABASE_URL=postgresql://affiliate:SENHA@localhost:5432/affiliate
```
Crie o banco e o usuário no Postgres antes (`CREATE DATABASE affiliate; CREATE USER affiliate ...`). O schema é aplicado por `npm run migrate` e é idempotente.

### 2. Evolution API (WhatsApp)

```env
EVOLUTION_URL=http://localhost:8080
EVOLUTION_APIKEY=...                    # a key GLOBAL (AUTHENTICATION_API_KEY do docker-compose da Evolution)
EVOLUTION_INSTANCE=affiliate-fitness    # nome da instância dedicada ao número novo
OWNER_JID=5519XXXXXXXXX@s.whatsapp.net  # SEU número pessoal (recebe resumos e envia comandos)
```
O `OWNER_JID` é o seu WhatsApp pessoal no formato `DDI+DDD+numero@s.whatsapp.net`. A instância em si será criada e conectada pelo `npm run groups:setup` (ver checklist).

### 3. Shopee Affiliate Open Platform

```env
SHOPEE_APP_ID=...
SHOPEE_APP_SECRET=...
```
Pegue no painel da Open API do programa de afiliados Shopee (ver checklist). Sem essas credenciais o sistema sobe normalmente, mas o sourcing da Shopee fica desligado (loga aviso).

### 4. Mercado Livre

```env
MELI_AUTO_LINKS=false
MELI_MATT_WORD=
MELI_MATT_TOOL=
```
**Deixe `MELI_AUTO_LINKS=false`** (caminho seguro: importar links gerados no portal de afiliados via `POST /offers/manual`). O conversor automático com `matt_word`/`matt_tool` **viola os Termos e Condições do programa de afiliados do ML** — ver seção de avisos.

### 5. Telegram (monitor de canais de promo)

```env
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION=...   # gerada pelo: npm run telegram:login
```
Opcional, mas é a melhor fonte de ofertas "quentes". Sem essas variáveis o monitor simplesmente não liga.

### 6. IA (copy)

O texto-gancho da copy pode ser gerado por **dois provedores**, selecionados por `COPY_PROVIDER`:

```env
COPY_PROVIDER=ollama          # 'ollama' (default, local e grátis) | 'anthropic' (Claude, melhor qualidade)

# Ollama (local)
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b

# Claude / Anthropic (só usado quando COPY_PROVIDER=anthropic)
ANTHROPIC_API_KEY=            # sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
# ANTHROPIC_TIMEOUT_MS=30000  # opcional, timeout da chamada /v1/messages
```

- **`ollama`** (default): roda local, grátis. Se o Ollama estiver fora do ar ou demorar, a copy cai automaticamente nos templates prontos.
- **`anthropic`**: usa o Claude pela API da Anthropic — copy melhor, mas requer `ANTHROPIC_API_KEY`. Sem chave válida (ou em qualquer falha da API), cai no template — **nunca** no Ollama, pra não carregar o modelo de 5GB à toa. A chave nunca é logada.

**Em qualquer caso, nenhum post deixa de sair por causa do LLM** — o provedor só escreve o gancho; preço/link entram de forma determinística.

#### Ligar o Claude pelo painel (recomendado)

Não precisa editar o `.env`. Na aba **Config → IA (copy)**: troque o **Provedor** para *Claude (API Anthropic)*, cole a **Chave da Anthropic** e (opcional) ajuste o **Modelo**, e clique em **Salvar** — vale na hora (precedência banco > `.env` > default). O botão **Testar copy** gera um gancho de exemplo com o provedor efetivo atual, sem postar nada. A chave fica só no servidor: o painel mostra apenas "configurada" e os últimos 4 caracteres, e deixar o campo de chave em branco **não** apaga a chave já salva.

### 7. App e operação

```env
PORT=3210
TZ=America/Sao_Paulo
ADMIN_TOKEN=um-token-longo-aleatorio   # protege os endpoints admin; vazio = só localhost
WEBHOOK_TOKEN=outro-token-aleatorio    # segredo no path do webhook da Evolution (anti-spoofing de comandos);
                                       # defina ANTES do groups:setup, que registra a URL com o token

POSTING_WINDOW=08:00-22:00   # janela diária de postagem
RAMP_SCHEDULE=4,8,12         # posts/dia: semana 1, semana 2, semana 3+
GROUP_SPACING_MS=60000-180000
SEND_DELAY_MS=3000-8000
DEDUP_DAYS=7
OFFER_TTL_HOURS=24

MIN_COMMISSION=0.05          # pisos do ranking
MIN_DISCOUNT=10
MIN_SALES=30
MIN_RATING=4.3
MIN_SCORE=30
```
Os defaults são conservadores de propósito (anti-banimento + qualidade mínima de oferta). Só mexa depois de rodar algumas semanas.

---

## CHECKLIST — o que VOCÊ ainda precisa fazer

O código está pronto, mas dependem de você (cadastros, aprovações e logins que não dá para automatizar). Os passos 1–4 podem ser feitos **100% pelo painel web** (aba **Config**) — os comandos de terminal seguem valendo como alternativa:

- [ ] **1. Shopee: pegar AppID e Secret.** Inscreva-se no programa de afiliados da Shopee BR e, com a conta aprovada, acesse o painel da **Open API** (plataforma aberta de afiliados) e gere o **AppID** e o **AppSecret**. Cole na aba **Config → Shopee** do painel (tem botão **Testar conexão** que faz uma busca real) — ou, se preferir, em `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET` no `.env`. É isso que liga o sourcing automático — os links `offerLink` retornados já vêm com a SUA tag de afiliado.

- [ ] **2. Mercado Livre: cadastrar o WhatsApp como mídia e gerar links pelo portal.** O programa de afiliados do ML exige que você **cadastre cada canal de divulgação** — adicione seus grupos/WhatsApp como mídia na sua conta de afiliado. Não existe API oficial de afiliados: o fluxo correto é **gerar o link no portal/ferramenta de afiliados do ML** (link curto `mercadolivre.com/sec/...`) e importar no sistema pela aba **Importar ML** do painel (ou via `POST /offers/manual`, exemplo abaixo). Na aba **Config → Mercado Livre** dá pra colar um link do portal e extrair automaticamente seus `matt_word`/`matt_tool`. Dois avisos importantes:
  - **Suplementos são PROIBIDOS no programa de afiliados do ML.** O sistema rejeita import de oferta meli com categoria `suplementos` — não tente contornar; é regra do programa e dá ban.
  - **O modo automático (`MELI_AUTO_LINKS=true` com `matt_word`/`matt_tool`) viola a cláusula 1.8 dos T&C do programa.** Está implementado como flag de risco consciente, desligado por padrão (no painel é o checkbox "Conversão automática de links"). Se ligar, é por sua conta — o ML pode zerar comissões e banir a conta de afiliado.

- [ ] **3. Telegram: criar api_id/api_hash e logar.** Acesse [my.telegram.org](https://my.telegram.org) → *API development tools* → crie um app e copie `api_id` e `api_hash`. O login inteiro dá pra fazer pelo painel: aba **Config → Telegram** — informe api_id, api_hash e telefone, digite o código que chega no app (e a senha 2FA, se tiver) e pronto, o monitor sobe na hora. Alternativa de terminal:
  ```bash
  npm run telegram:login
  ```
  Ele pede telefone + código e imprime a `StringSession` — cole em `TELEGRAM_SESSION` no `.env`. Depois cadastre os canais de promo a monitorar na aba **Fontes** do painel (ou via `POST /telegram/channels`, ex.: `{"username": "canaldepromosfit"}`).

- [ ] **4. Conectar o número novo e criar os grupos.** Com a Evolution no ar e o chip novo em mãos, pelo painel: aba **Config → WhatsApp** → **Criar/conectar instância** (cria a instância na Evolution e configura o webhook `MESSAGES_UPSERT`), escaneie o QR que aparece na própria página com o WhatsApp do chip novo e salve o **número do dono**. Crie os grupos espelho no próprio WhatsApp (marque-os como **somente admins postam** — menos denúncia) e selecione quais recebem as ofertas na aba **Grupos → Escolher grupos do WhatsApp**. Alternativa de terminal que cria tudo de uma vez (instância + 5 grupos já como somente-admins + webhook):
  ```bash
  npm run groups:setup            # default: 5 grupos "Achadinhos Fitness #N"
  # ou: node scripts/setup-groups.js "Meu Prefixo" 5
  ```

- [ ] **5. Warm-up do chip: 1–2 semanas ANTES de ativar.** Número recém-criado postando link em grupo é receita de banimento. Use o chip manualmente por 1–2 semanas: converse com contatos reais, entre em alguns grupos, mande áudio/foto, deixe o WhatsApp "envelhecer". Só depois rode o `groups:setup` e deixe o ramp-up (4 → 8 → 12 posts/dia) fazer o resto. Não pule etapa do ramp editando `RAMP_SCHEDULE` para cima.

- [ ] **6. Divulgar os grupos.** O sistema posta; levar gente para os grupos (bio do Instagram, TikTok, indicação) é com você.

---

## Como rodar

### Na mão (teste)

```bash
npm run smoke    # checagens PASS/FAIL/WARN — rode sempre que mexer em config
npm start        # sobe o processo (migrate → express → scheduler → telegram)
```

### Em produção (systemd user unit)

Crie `~/.config/systemd/user/affiliate.service`:

```ini
[Unit]
Description=AFFILIATE - ofertas fitness no WhatsApp
After=network-online.target

[Service]
WorkingDirectory=/srv/nextags/AFFILIATE
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

E ative:

```bash
systemctl --user daemon-reload
systemctl --user enable --now affiliate.service
loginctl enable-linger $USER                      # mantém rodando sem sessão aberta
journalctl --user -u affiliate.service -f        # logs ao vivo
```

---

## Comandos do dono (no WhatsApp)

Mande qualquer um destes do **seu número pessoal** (`OWNER_JID`) para o número do sistema — chegam via webhook da Evolution e só são aceitos vindos de você:

| Comando | Efeito |
|---|---|
| `pausar` (ou `pause`) | **kill-switch**: para todas as postagens na hora |
| `retomar` (ou `voltar`, `resume`) | retoma as postagens |
| `status` | pausado?, posts de hoje, slots restantes, ofertas na fila, grupos ativos |
| `pular` (ou `skip`) | descarta a próxima oferta da fila (marca como rejeitada) |
| `ajuda` (ou `help`, `comandos`) | lista os comandos |

Maiúsculas/acentos não importam (`Pausar`, `PULAR` funcionam).

---

## Painel web

Painel de controle no navegador (feito para celular, funciona em desktop):

```
http://IP-do-servidor:3210/painel
```

**Autenticação:** a página pede o token de admin — é o mesmo `ADMIN_TOKEN` do `.env` (enviado em toda chamada como header `x-admin-token`). O token fica salvo no navegador; se for inválido/trocado, a tela de login volta sozinha.

**O que dá pra fazer (abas):**

| Aba | O que mostra/faz |
|---|---|
| **Fila** | ofertas por status (pendentes, postadas, rejeitadas…), com score, preços e copy original. Botões **Rejeitar**, **Restaurar** e **Postar agora** |
| **Posts** | histórico dos envios por grupo (ok/falha, erro, horário) |
| **Grupos** | liga/desliga cada grupo espelho e sincroniza grupos da Evolution por prefixo de nome |
| **Fontes** | keywords do sourcing Shopee e canais do Telegram monitorados (adicionar/ativar/desativar) |
| **Importar ML** | formulário do import manual de oferta do Mercado Livre + botão de test-post (manda a copy só pro seu WhatsApp) |
| **Config** | configuração guiada, sem editar `.env`: instância do WhatsApp (criar/conectar com QR, número do dono), credenciais da Shopee (com botão **Testar conexão**), Mercado Livre (cole um link do portal e ele extrai `matt_word`/`matt_tool`; liga/desliga o modo automático), **login do Telegram direto no navegador** (api_id/api_hash/telefone → código → 2FA, com Desconectar), **IA (copy)** — escolha do provedor Ollama (URL/modelo) ou Claude/Anthropic (chave mascarada + modelo, com botão **Testar copy**) — e parâmetros de operação (janela de postagem, ramp, espaçamentos, dedup/TTL e pisos do ranking) |

O cabeçalho mostra o estado do sistema (semana do ramp, slots/posts de hoje, fila) com botão **PAUSAR/RETOMAR** (kill-switch, o mesmo do comando `pausar` do WhatsApp).

**Postar agora:** posta a oferta imediatamente em todos os grupos habilitados, ignorando slots e até o pausado — é uma ação explícita do dono. Os envios respeitam o espaçamento anti-ban de 60–180s entre grupos, então a resposta pode levar vários minutos; mantenha a página aberta. O servidor trava a oferta durante o envio: um segundo clique (ou o executor automático) recebe `409` em vez de duplicar a postagem.

**Aba Config:** os valores salvos vão para o banco (tabela `settings`, chaves `cfg.*`) e valem **imediatamente**, sem reiniciar o serviço. A precedência é **banco > `.env` > default** — um valor salvo no painel passa a valer no lugar do que está no `.env`, inclusive nos próximos boots (para voltar ao `.env`, salve o valor desejado pelo painel ou apague a row `cfg.*` correspondente). Segredos nunca voltam inteiros pro navegador (o GET mostra só "configurado" e os últimos 4 caracteres do App Secret) e campo de segredo deixado em branco **não** apaga o valor salvo. ⚠️ Ficam **fora do painel, só no `.env`**: a URL e a apikey da Evolution (`EVOLUTION_URL`/`EVOLUTION_APIKEY`), a porta (`PORT`), os tokens (`ADMIN_TOKEN`/`WEBHOOK_TOKEN`) e o `DATABASE_URL` — mudou algum desses, edite o `.env` e reinicie o serviço.

⚠️ O painel **compartilha a mesma porta/serviço** do sistema (`PORT`, default 3210, servido pelo mesmo processo/systemd unit dos endpoints admin e do webhook). Não há serviço separado: se expor a porta para acessar o painel de fora, todo o resto da API fica exposto junto — proteja com `ADMIN_TOKEN` forte e, idealmente, firewall/VPN.

---

## Endpoints admin (HTTP)

Servidos em `http://localhost:3210` (config `PORT`). Autenticação: header `x-admin-token: $ADMIN_TOKEN` — se `ADMIN_TOKEN` estiver vazio, só aceita requests de `127.0.0.1`.

| Método/Rota | Auth | Descrição |
|---|---|---|
| `GET /health` | não | `{ ok, paused, uptime }` — healthcheck |
| `POST /webhook/evolution[/<WEBHOOK_TOKEN>]` | não* | recebe os eventos da Evolution (*valida instância/owner internamente; com `WEBHOOK_TOKEN` definido, exige o segredo no path) |
| `GET /status` | sim | mesmas infos do comando `status` |
| `POST /offers/manual` | sim | importa oferta do ML gerada no portal de afiliados |
| `POST /groups/sync` | sim | importa da Evolution os grupos cujo nome contém `prefix` (default `Achadinhos`) |
| `POST /telegram/channels` | sim | adiciona canal do Telegram ao monitor: `{ "username": "..." }` |
| `POST /test-post` | sim | gera a copy da melhor oferta e manda **só para o dono** (não marca como postada) |

Exemplos:

```bash
# importar oferta manual do Mercado Livre (link gerado no portal de afiliados)
curl -X POST localhost:3210/offers/manual \
  -H 'content-type: application/json' -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{
    "title": "Halteres Ajustáveis 20kg",
    "affiliateUrl": "https://mercadolivre.com/sec/abc123",
    "price": 189.90,
    "priceFrom": 299.90,
    "imageUrl": "https://http2.mlstatic.com/....jpg",
    "category": "equipamentos"
  }'

# adicionar canal de promo do Telegram
curl -X POST localhost:3210/telegram/channels \
  -H 'content-type: application/json' -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"username": "canaldepromos"}'

# testar o pipeline ponta a ponta (mensagem chega só no seu WhatsApp)
curl -X POST localhost:3210/test-post -H "x-admin-token: $ADMIN_TOKEN"
```

---

## Smoke test

```bash
npm run smoke
```

Imprime `PASS`/`FAIL`/`WARN` por item: conexão com o banco (+migrate), algoritmo da assinatura Shopee contra vetor conhecido, score de oferta exemplo, copy (mensagem precisa conter `#publi` e `R$`), parsers de URL Shopee/ML, e disponibilidade de Ollama e Evolution (estes dois só geram `WARN` se estiverem fora). Sai com código 1 se houver qualquer `FAIL` — WARNs não falham.

---

## Avisos legais e de risco

### CONAR / publicidade — por que todo post tem `#publi`

Conteúdo de afiliado é **publicidade** e, pelas regras do CONAR (Guia de Publicidade por Influenciadores) e pelo CDC, precisa ser identificado como tal. Por isso **toda mensagem postada termina, de forma fixa e não removível pelo LLM, com**:

```
#publi · link de afiliado
```

Não remova isso do código. Além de ser a prática correta com quem está no grupo, omitir a natureza publicitária do post pode gerar sanção no CONAR e responsabilização por publicidade velada.

### Outros riscos que você assume sabendo

- **WhatsApp**: automação de envio viola os termos do WhatsApp; o desenho inteiro (chip dedicado, warm-up, ramp-up, delays "digitando", espaçamento entre grupos, grupos somente-admin, kill-switch) existe para reduzir — não eliminar — o risco de banimento do número.
- **Mercado Livre**: `matt_word` automático viola os T&C do programa (seção 1.8) e **suplementos são categoria proibida** no programa de afiliados do ML. O sistema bloqueia o segundo e desliga o primeiro por padrão.
- **Preços mudam**: a mensagem sempre avisa ("⏰ Preço pode mudar a qualquer momento!") e ofertas com mais de 24h expiram sem postar.
