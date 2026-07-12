# Relatório de Criação — Agente Nathy · O Cantinho da Nathy

**Prompt gerado:** `prompt-cantinho-da-nathy-v1.0.md`
**Data:** 12/06/2026
**Skill:** nextags-prompt-creator
**Tipo de agente:** Vendas/consultora, COM MCP (afiliados Shopee/Mercado Livre)

---

## ⚠️ Pendência crítica (única restante — resolver ANTES de subir produção)

> Resolvidas em 12/06/2026 com o dono: ✅ flow de transferência = `1781229835100` (aplicado no prompt); ✅ grupo VIP = 5 links de convite no prompt, com rotação a cargo do agente; ✅ CUF `resumo_atendimento` criado na NexTags; ✅ nome "Nathy" confirmado; ✅ "preços exclusivos" mantido por decisão do dono; ✅ claim "promoções chegam primeiro, todos os dias" confirmado (postagem diária real); ✅ fora-de-horário transfere mesmo assim; ✅ disclosure `*Publi*` mantido.

### 1. MCP de produtos — criado e ativo, MAS com bloqueio de rede
- O MCP é o workflow n8n **"O Cantinho da Nathy MCP"** (nextags.app.br, workflow `qB5h1kCqQT99qfg2`, ATIVO), endpoint `https://nextags.app.br/mcp/o-cantinho-da-nathy-mcp` (Streamable HTTP v2). As 4 tools (`categorias`, `buscar_pecas`, `recomendar`, `detalhe`) chamam o serviço AFFILIATE em `/catalog/*` com `MCP_TOKEN` dedicado.
- O prompt está alinhado ao contrato real do payload slim: `titulo`, `preco_fmt`/`preco_de_fmt` (já formatados), `desconto_pct`, `avaliacao`, `link`, `imagem`, `imagem_hint`, `texto_pronto` — sem comissão/score, e a validação de imagem usa o `imagem_hint`.
- **BLOQUEIO:** o n8n de nextags.app.br é remoto e NÃO alcança o serviço na LAN (`http://10.0.0.254:3210`) — `initialize`/`tools/list` funcionam, mas `tools/call` pendura. **Fix:** expor o `/catalog` por hostname público (ex.: `catalog.nextags.app.br` via túnel cloudflared deste servidor — precisa de DNS no Cloudflare + sudo) e repointar a URL das 4 tools no workflow. Sem isso o agente fica sem catálogo.
- Nota: o MCP Server Trigger está com `authentication: none` — quem tiver a URL consulta o catálogo (read-only, dado público de oferta; risco baixo, mas dá pra ativar auth no trigger se quiser).

---

## O que mudou / decisões tomadas

1. **Sem site para scraping.** O negócio opera por WhatsApp/grupos e não há site no briefing. O contexto veio do briefing + do sistema AFFILIATE em produção (catálogo real: moda/fitness/futebol ~70%, acessórios/equipamentos ~20%, suplementos ~10%).
2. **"Preços exclusivos"**: havia conflito interno do briefing (preço fixo da plataforma × exclusividade), mas o dono confirmou em 12/06/2026 que quer manter "preços exclusivos" como tempero de marca — restaurado na identidade e no "Sobre". A resposta à objeção "achei mais barato" continua honesta (preço é o da oferta na plataforma).
3. **CTA "Agendar agora" do formulário não se aplica** a venda por afiliado (não há agendamento). Substituído por conduzir ao **link de compra** + **convite ao grupo VIP** (objetivo clarificado por você: sugerir produtos via MCP, puxar pro grupo, ajudar a comprar, tirar dúvidas).
4. **"Anotar a dúvida e prometer retorno"** (comportamento em incerteza do briefing) implementado de forma que a promessa se cumpre: `set_field_value` com o resumo + `send_flow` pro fluxo de transferência na MESMA resposta. Sem isso seria promessa falsa (modelo é stateless).
5. **Disclosure `*Publi*`** incluído no bloco de apresentação de produto, consistente com os posts dos grupos (CONAR 2026 — link de afiliado).
6. **Guardrail "sempre indicar um produto do MCP"** escopado para conversas de produto/compra (mínimo 1 oferta, máximo 3 por resposta), pra não virar spam em dúvida de suporte.
7. **Bloqueio de compra "política de troca"** atacado com o argumento verdadeiro do modelo: a compra acontece DENTRO da Shopee/ML, com a proteção ao comprador da plataforma, sem citar prazos que não controlamos.
8. **Suplementos:** proibido prometer efeito/resultado de saúde (alinha com a denylist do sourcing do sistema).

### Auditoria
- `analyze_prompt.py`: **0 violações bloqueantes** (1 warn falso-positivo: o placeholder `<URL_IMAGEM_RETORNADA_PELA_FERRAMENTA>` no Exemplo 3, padrão canônico do skeleton para URL dinâmica).
- Revisão adversarial multi-agente (4 lentes + verificação cética): 30 achados brutos → **9 confirmados e corrigidos** antes desta entrega, entre eles: exemplo que terminava em promessa pendente; fora-de-horário que prometia retorno sem encaminhar (faltava `send_flow`); "silêncio total" pós-handoff sem representação JSON definida (agora: emitir `{"messages":[]}`); claims inventados sobre o grupo ("promoções chegam primeiro, todos os dias"); "buscar uma condição" sugerindo negociação de preço; dois CUFs redundantes consolidados em `resumo_atendimento`; e seção de erros 100% redundante removida.

---

## 📋 Lista de fluxos a criar na NexTags

| Fluxo | Propósito | flow_id no prompt |
|---|---|---|
| **Transferência humana** | Notificar/atribuir a conversa ao responsável; usado em handoff, dúvida não respondida e fora de horário | `1781229835100` ✅ |

É o único fluxo que o prompt dispara. Opcionais para o futuro (NÃO referenciados no prompt): fluxo de NPS pós-atendimento e fluxo de boas-vindas do grupo.

---

## 🧪 Bateria de testes (rodar no preview da NexTags)

**T1 — Abertura.** Cliente: "oi" → JSON com 1 mensagem de texto, saudação com `{{first_name}}` se nome válido (senão neutra) + pergunta se procura algo específico ou quer ver as promoções.

**T2 — Lead quente.** Cliente: "manda o link daquela legging" → agente consulta `buscar_pecas` (texto "legging", limite 3) e responde os 3 blocos: imagem (só se `imagem_hint` = "provavel_jpeg_png"), texto com `preco_fmt`/`preco_de_fmt` da tool + `*Publi*` + 1 botão `web_url` com o campo `link` exato, e follow-up. Nunca preço de memória, nunca mencionar comissão.

**T3 — Desconto.** Cliente: "me dá um desconto?" → texto simples: preço é o da promoção na plataforma, fixo; reforço de valor (compra protegida). Sem cupom inventado.

**T4 — Desconfiança.** Cliente: "isso é golpe?" → explica que a compra é feita na própria Shopee/Mercado Livre com pagamento e devolução protegidos pela plataforma. Sem citar prazos de troca específicos.

**T5 — Handoff.** Cliente: "quero falar com um humano AGORA" → mensagem curta + `actions` com `set_field_value` (`resumo_atendimento`) ANTES de `send_flow` (`1781229835100`), tudo na mesma resposta. Próximo turno do cliente ("ok") → `{"messages":[]}`.

**T6 — Fora de escopo.** Cliente: "qual seu time de futebol?" → redireciona com leveza pras ofertas (pode indicar produto de futebol, não opina de torcida).

---

## Próximos passos

1. Resolver as 5 pendências acima (fluxo, link do grupo, MCP, CUF, nome).
2. Substituir os placeholders no prompt e testar os 6 casos no ambiente da NexTags.
3. Depois de editar o prompt manualmente, rodar o `nextags-prompt-fixer` pra revalidar.
