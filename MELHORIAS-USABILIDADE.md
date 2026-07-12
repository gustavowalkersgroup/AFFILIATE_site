# Melhorias de usabilidade — AFFILIATE

> Auditoria de usabilidade (24/06/2026) feita por 5 auditores varrendo o código real
> (gaps de config, UX/texto do painel, fluxos de setup, observabilidade/erros, operações).
> 60 achados → 38 itens priorizados. Objetivo: o Gustavo não depender do dev pra nada.
>
> Legenda: **Impacto** alto/médio/baixo (quanto reduz a dependência do dev) ·
> **Esforço** P/M/G · ⭐ = quick win (impacto alto/médio, esforço P).

## ✅ Implementado em 24/06/2026

Os 4 pacotes priorizados já estão no ar (itens **1–14, 20, 21, 27, 30, 38**): semáforos de saúde + alertas no WhatsApp, "buscar ofertas agora", reiniciar aquecimento, resumo diário completo, motivo/falhas dos disparos, banner de fila vazia, denylist/disclosure/rodapé/templates/estilo/mix/pesos editáveis, criar grupos pelo painel, guias de setup (IG/ML/Telegram), copiar Redirect URI, link da extensão ML, README pró-painel.

**Ainda pendentes (médio/baixo — não implementados):** 16 (heartbeat/aba Diagnóstico), 17 (sumir jargão restante), 19 (padronizar caixas de teste + trocar prompt() do ML), 22 (`<select>` de modelo de IA), 23 (botões de inserir placeholder), 24 (erros de API traduzidos nas listas), 25 (manutenção de dados pelo painel), 26 (contador copy IA vs template), 28 (confirmação ao sincronizar grupos), 29 (cadência dos crons editável), 31 (peakHours editável), 32 (renomear aba/card), 33 (token MCP editável), 34 (opt-out/criatividade), 35 (categorias por API), 36 (export/import config), 37 (validar telefones no front).

---

## Diagnóstico em 2 frases

1. **Falta de observabilidade** — quando uma integração cai (WhatsApp, Instagram pelo breaker,
   sessão Telegram, cookie do ML, sourcing seco, copy caindo em template), o sistema **falha em
   silêncio**: não há dashboard de saúde, nem alerta no WhatsApp, e os erros já gravados no banco
   não aparecem na tela. O Gustavo só descobre pela ausência de resultado.
2. **Config de conteúdo/negócio ainda no código/.env** — denylist, disclosure (#publi), mix
   70/20/10, pesos do score, templates de copy e a mensagem do WhatsApp exigem o dev. Some-se a
   isso jargão técnico na UI (JID, slug, ms, fração) e setups sem passo-a-passo.

---

## ⭐ Quick wins (faça primeiro — alto valor, esforço baixo)

### 3. Botão "Buscar ofertas agora" (forçar sourcing) + resumo do último sourcing — Operações · alto · P ⭐
- **Hoje:** o sourcing só roda de 3 em 3h. Cadastrou keyword nova ou corrigiu a chave Shopee? Espera 3h ou pede restart. Erros de sourcing são invisíveis.
- **Proposta:** exportar `runSourcing()` + `POST /api/sourcing/run-now`, botão na aba Fontes; gravar/mostrar "último sourcing há 12min: 34 ofertas, 0 erros".

### 4. Botão "Reiniciar aquecimento" (resetar started_at) — Operações · alto · P ⭐
- **Hoje:** trocou de chip / ativou cedo demais → reiniciar o ramp-up só com `UPDATE settings` no banco (= dev).
- **Proposta:** mostrar data de início + semana atual do ramp, botão "Reiniciar aquecimento" (posts e disparos) com confirmação.

### 21. Resumo diário completo (IG, disparos, Telegram, alertas) — Observabilidade · médio · P ⭐
- **Hoje:** o boletim das 22:30 cobre só os grupos; não menciona IG, disparos, Telegram nem alertas.
- **Proposta:** uma linha por integração + linha de Alertas (token IG vencendo, sessão TG caída, sourcing 0). Vira boletim de saúde diário no WhatsApp.

### 20. Botão "Testar / ver exemplo de link" no card Amazon — Painel/UX · médio · P ⭐
- **Hoje:** Shopee/ML/Ali/IG têm teste; Amazon só "Salvar" — o tag entra sem confirmação.
- **Proposta:** valida o formato do tag e mostra um link de exemplo `/dp/ASIN?tag=...`.

### 27. Ajuda inline do "Score" + tooltip nos cards de oferta — Painel/UX · médio · P ⭐
- **Hoje:** o score domina cada card, mas em lugar nenhum se diz o que é nem se 50 é alto/baixo.
- **Proposta:** frase no campo "Score mínimo" ("nota 0-100 que combina desconto, comissão, vendas e avaliação") + tooltip no card.

### 30. Reescrever README priorizando o painel — Setup · médio · P ⭐
- **Hoje:** o README mistura fluxo antigo (.env, `npm run telegram:login`) com o do painel, dando a impressão de que precisa de terminal.
- **Proposta:** painel como caminho primário; rebaixar .env/CLI a "avançado/fallback"; marcar o que SÓ vai no .env.

### 38. "Em uso agora" dos Disparos com a mesma linguagem do plano — Painel/UX · baixo · P ⭐
- **Hoje:** imprime o `dailyRamp` cru ("4,8,12/dia"); quem não sabe que vírgula = semanas não entende.
- **Proposta:** reaproveitar o `bcRenderPlan` ("Semana 1: 4 · …") também no "Em uso agora".

---

## 🔴 Maiores travas (alto impacto)

### Observabilidade
- **1. Alertas proativos no WhatsApp quando algo cai** (M) — usar o `notifyOwner` pra avisar: IG auto-desligado/token vencendo, sessão Telegram caída, cookie ML falhou, sourcing 0 há >6h. Cada msg diz a ação. (Atenção: queda da própria instância do WhatsApp precisa de canal alternativo, pois o `notifyOwner` morre junto.)
- **2. Dashboard de saúde (semáforos) no topo, no auto-refresh** (M) — `/api/health` agregando WhatsApp/IG/Telegram/disparos/copy; faixa verde/amarelo/vermelho no cabeçalho. Espelhar em `statusData` melhora também o comando "status" do WhatsApp.
- **6. "X falhas" clicável com motivos agregados** (M) — os motivos já estão no banco (`posts.error`, `contacts.last_error`); só falta exibir ("180 sem whatsapp, 20 envio falhou").
- **7. "Por que os disparos não estão enviando agora"** (M) — `broadcastStats` devolver a causa (fora da janela / teto atingido / próximo envio às HH:MM / instância desconectada / sem link).
- **8. Alerta de fila vazia / sourcing seco** (M) — destacar em amarelo quando há slots pendentes mas fila=0 ("sourcing pode estar com problema").
- **11. Erros de teste acionáveis — acabar com "veja o log do serviço"** (M) — o Gustavo não acessa o log (servidor compartilhado). Propagar o código real da Shopee + dica por código.
- **13. Feedback de join de canal Telegram** (M) — badge "monitorando" vs "não consegui entrar"; hoje o join é best-effort e o erro só vai pro console.
- **16. Heartbeat por job + aba "Diagnóstico"** (G) — `last_run_at` por job + ring-buffer dos últimos erros, visível sem SSH.
- **26. Copy: contar gerações por IA vs template** (M) — se a IA cair, 100% vira template repetitivo sem ninguém ver; contador + alerta se fallback > ~50%/dia.

### Config de conteúdo/negócio (tirar do código)
- **5. Denylist + disclosure (#publi) editáveis** (M) — termos bloqueados e a linha legal só vêm do .env; vazar termo novo ou ajustar o #publi (CONAR) exige dev.
- **15. Mix 70/20/10 + pesos do score editáveis** (M) — a Fila já mostra o preview do mix mas não deixa mudar; os pisos já são editáveis (incoerência).
- **18. Templates de copy + mensagem do WhatsApp editáveis** (G) — a voz da marca (templates, few-shot, rodapé "⏰ Preço pode mudar…", gancho sazonal) está toda no código; o IG já tem caption/hashtags editáveis.

### Setup / onboarding
- **9. Passo-a-passo "Como conseguir isso?" nos setups** (G) — `<details>` com passos numerados + link em Telegram (api_id/hash), Instagram (app Meta + Redirect URI + Tester) e ML (capturar cookie/csrf).
- **10. Instagram: pré-preencher URL pública, validar + copiar Redirect URI** (M) — campo livre que quebra o OAuth se errar; mapear erros do callback pra dica acionável.
- **12. Criar grupos espelho pelo painel** (M) — hoje só `npm run groups:setup`; portar pra `POST /api/whatsapp/groups/create` fecha o onboarding do WhatsApp no painel.
- **14. Extensão Chrome do ML linkada no painel + zip com a URL pública atual** (M) — o caminho fácil de capturar o cookie existe mas está escondido; zip estático com URL ngrok hardcoded.

---

## 🟡 Médio impacto

- **17. Sumir com jargão técnico cru** (M) — login "ADMIN_TOKEN/x-admin-token" → "Senha do painel"; ms → segundos; comissão em % (não fração); esconder JID; "slug da instância" → "Conta de WhatsApp dos disparos".
- **19. Padronizar resultados de teste numa caixa única + trocar `prompt()` do ML por input inline** (M).
- **22. Modelo de IA como `<select>` ("Mais barato"/"Melhor qualidade")** (M) — em vez de digitar o ID exato e quebrar com um typo.
- **23. Placeholders de copy/legenda como botões de inserir + aviso se faltar {link}** (M).
- **24. Erros de API traduzidos/orientativos nas listas + "Tentar de novo"** (M).
- **25. Manutenção de dados pelo painel** (M) — "limpar expiradas/rejeitadas antigas", "replanejar slots de hoje".
- **29. Cadência dos crons editável** (G) — intervalo do sourcing + hora do resumo diário.
- **31. Horários de pico (peakHours) editáveis** (M).
- **33. Token do MCP (Nathy) editável + "Gerar novo token"** (M).
- **35. Categorias do dropdown servidas por API (a partir de CATEGORY_BUCKET)** (G) — hoje `<option>` fixos que precisam casar com o código em 3 lugares.

## 🟢 Baixo impacto / polimento

- **28. Confirmação/prévia ao sincronizar e salvar grupos** (M).
- **32. Renomear aba "Importar ML" e o card "Teste geral"** (P).
- **34. Opt-out dos disparos + "criatividade" da copy editáveis** (M).
- **36. Exportar/importar config (backup/rollback) pelo painel** (M).
- **37. Normalizar/validar telefones no front (só números, com DDI 55)** (M).
