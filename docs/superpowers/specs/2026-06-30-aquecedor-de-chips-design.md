# Aquecedor de Chips (warmer) — Design

**Data:** 2026-06-30
**Projeto:** affiliate-fitness (Z:\AFFILIATE)
**Status:** Aprovado para implementação

## Objetivo

Manter as instâncias de WhatsApp (chips) conectadas à Evolution API conversando
entre si de forma contínua e realista, para aquecer números novos e reduzir o
risco de ban. Roda ininterrupto enquanto ligado; só para quando desligado
manualmente no painel.

## Decisões fechadas

- **Topologia:** mesh (todos com todos), pares aleatórios.
- **Conteúdo:** banco de frases pré-definido com spin (`{a|b|c}`), sem IA, sem mídia, sem links.
- **Integração:** módulo `src/warmer.js` no cron existente (`scheduler.js`) + controles no painel Express.
- **Descoberta de chips:** automática via `GET /instance/fetchInstances` (campo `ownerJid`).
- **Cadência:** modo contínuo — roda enquanto `warmer_enabled = on`, regulado por espaçamento.
- **Conversa encadeada:** threads de 3–8 trocas por par antes de fechar e sortear novo par.

## Arquitetura

Novo módulo `src/warmer.js`, simétrico ao `src/broadcast.js`. Um executor
`runWarmer()` é chamado por um cron minuto-a-minuto registrado em
`src/scheduler.js`. Reaproveita:

- `evoFetch` (`src/poster.js`) — cliente HTTP da Evolution (GET quando `body === undefined`).
- `getSetting` / `setSetting` (`src/db.js`) e `query` — estado persistido.
- `spin()` e `randomBetween()` — padrões já usados no broadcast/config.
- Padrão de janela horária + espaçamento randômico + guarda de reentrância.

Princípio herdado do broadcast: **o executor nunca lança** — todo erro é
capturado, logado e retorna neutro. Falha de rede não derruba o processo.

## Descoberta de chips (mesh)

- `GET /instance/fetchInstances` → filtra instâncias com `connectionStatus === 'open'`.
- Para cada uma, extrai `ownerJid` (o próprio número WhatsApp da instância).
- Produz lista `[{ instance, jid }]`.
- **Cache** da lista por ~5 min (setting `warmer_chips_cache` + timestamp), para
  não martelar a Evolution a cada tick.
- Se a lista tiver < 2 chips, `runWarmer()` sai silenciosamente (não há com quem conversar).

## Conteúdo das mensagens

Arquivo `src/warmer-phrases.js` exportando arrays de frases curtas e coloquiais,
agrupadas por papel na conversa:

- `OPENERS` — aberturas ("{oi|opa|e aí}, tudo {bem|certo|tranquilo}?").
- `REPLIES` — respostas genéricas ("{tudo sim|por aqui de boa|tranquilo e vc?}").
- `FOLLOWUPS` — continuações ("{viu aquilo|kkkk|nem me fala|verdade}").
- `CLOSERS` — encerramentos ("{falou|até mais|abraço|depois te chamo}").

Cada texto passa por `spin()` antes do envio. Sem mídia, sem links — warmup puro
de texto. A escolha do papel depende do estágio da thread (ver abaixo).

## Conversa encadeada (threads)

Estado de threads abertas persistido em setting JSON `warmer_threads`
(array de objetos):

```
{ a: "<instanceA>", b: "<instanceB>", jidA, jidB,
  turn: "a"|"b",        // de quem é a próxima fala
  exchanges: <int>,     // trocas já feitas
  target: <int> }       // 3..8, sorteado na abertura
```

Lógica por tick:

1. Com probabilidade alta, continua uma thread aberta: o lado `turn` envia a
   próxima fala (REPLY ou FOLLOWUP conforme `exchanges`), incrementa
   `exchanges`, alterna `turn`. Ao atingir `target`, envia um CLOSER e remove a
   thread.
2. Caso contrário (ou se não há threads abertas), sorteia um par novo de chips
   distintos, cria thread com `target` aleatório (3–8) e envia um OPENER.

Resultado: várias conversas de ida-e-volta acontecendo em paralelo ao longo do
tempo, sem parar, parecendo tráfego humano.

## Cadência — modo contínuo

Settings persistidas (lidas a cada tick; ajustáveis no painel):

| Setting | Default | Função |
|---|---|---|
| `warmer_enabled` | `off` | Kill-switch manual. É o único jeito de parar. |
| `warmer_spacing_ms` | `20000-120000` | Intervalo randômico entre mensagens. **Regulador de intensidade.** |
| `warmer_window` | `07:00-23:00` | Janela horária; fora dela pausa e retoma depois. |
| `warmer_daily_cap` | `0` | Trava de segurança por chip/dia. `0` = sem limite (roda solto). |
| `warmer_ramp_days` | `0` | Suaviza primeiros dias de chip novo. `0` = desligado. |

Sequência de guardas em `runWarmer()` (sai cedo se qualquer uma falhar):

1. Guarda de reentrância (`running`).
2. `warmer_enabled === on`?
3. Dentro de `warmer_window`?
4. `Date.now() >= warmer_next_at`? (respeita espaçamento)
5. Se `warmer_daily_cap > 0`: chip remetente ainda abaixo do teto do dia?
   (com `warmer_ramp_days`, o teto efetivo cresce linearmente até `daily_cap`).

Após enviar: registra em `warmer_log`, agenda
`warmer_next_at = now + randomBetween(warmer_spacing_ms)`.

## Persistência

Tabela criada no boot (`CREATE TABLE IF NOT EXISTS`, padrão do projeto):

```sql
CREATE TABLE IF NOT EXISTS warmer_log (
  id        BIGSERIAL PRIMARY KEY,
  from_inst TEXT NOT NULL,
  to_jid    TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warmer_log_sent_at_idx ON warmer_log (sent_at);
```

Usada para contagem diária por chip (quando `daily_cap > 0`) e auditoria/status.

## Painel

Card "Aquecedor de Chips" no painel Express, espelhando o card de broadcast:

- Toggle on/off (`warmer_enabled`).
- Inputs: espaçamento min/max, janela horária, daily cap, ramp days.
- Status: chips detectados (conectados), mensagens enviadas hoje, threads
  abertas, próximo envio (`warmer_next_at`).

Rotas REST novas (espelhando as do broadcast):

- `GET  /api/warmer/status` — estado + estatísticas.
- `POST /api/warmer/toggle` — liga/desliga.
- `POST /api/warmer/settings` — salva espaçamento/janela/cap/ramp.

## Anti-ban

- Espaçamento randômico entre envios + `options.delay` randômico + `presence: 'composing'` (simula digitação).
- Threads encadeadas em vez de disparos em rajada.
- Janela horária evita madrugada.
- `daily_cap` + `ramp_days` opcionais para chip muito novo.
- Falha de envio apenas loga e reagenda; processo nunca cai.

## Fora de escopo (YAGNI)

- Geração de conteúdo por IA.
- Envio de mídia/áudio/figurinhas.
- Grupos de aquecimento (só DM par-a-par).
- Métricas avançadas / dashboards de saúde do chip.
