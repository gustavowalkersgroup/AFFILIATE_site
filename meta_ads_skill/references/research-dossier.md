# Dossier técnico acionável — Meta Ads Campaign Operator

**Finalidade.** Este documento consolida a pesquisa para servir de referência a uma skill Claude Code que analisa, opera e testa campanhas Meta Ads. Ele define um contrato mínimo de dados, separa evidência de interpretação, fornece um protocolo reproduzível para discrepâncias de gênero e estabelece critérios para testes e decisões. Não substitui a documentação vigente da Meta, a revisão jurídica ou a validação humana antes de alterar campanhas.

## 1. Regra de decisão em uma página

A skill deve seguir esta ordem:

1. **Definir a pergunta de negócio.** Identificar resultado desejado, objetivo, evento de otimização, tipo de compra, conta, nível do objeto e janela de atribuição.
2. **Congelar o universo comparável.** Fixar IDs, período e fuso da conta, moeda, geografia, status, configuração de orçamento, posicionamentos, Advantage+ e filtros. Campanha, conjunto e anúncio não são o mesmo universo.
3. **Extrair primeiro a linha de base sem breakdown.** Em seguida, repetir a consulta com cortes compatíveis. Registrar versão da API, timestamp, fields, breakdowns, paginação e status da resposta.
4. **Separar entrega de resposta.** Entrega inclui impressões, alcance, frequência, gasto e CPM. Resposta atribuída inclui cliques, leads, compras, CPA, valor e ROAS. Não misturar janelas ou modelos de atribuição.
5. **Formular hipóteses antes de explicar.** Para cada hipótese, declarar previsão, comparação necessária e achado que a enfraqueceria. A saída inicial pode ser **“não determinado”**.
6. **Escolher a ferramenta certa.** Breakdown é diagnóstico descritivo; A/B compara versões; holdout ou Conversion Lift avalia incrementalidade. Um breakdown não demonstra causalidade.
7. **Decidir somente com evidência suficiente.** Se o denominador for instável, a célula pequena, a atribuição incompatível, o teste sem potência ou a extração incompleta, não pausar, escalar nem acusar erro. Corrigir a mensuração ou marcar como inconclusivo.

### 1.1 Taxonomia obrigatória da evidência

Toda resposta da skill deve rotular afirmações e observações com uma destas classes:

| Rótulo | Uso | Exemplo de linguagem |
|---|---|---|
| **Fato oficial — Meta** | Regra, definição, configuração ou limitação descrita na documentação da Meta. | “A documentação define…” |
| **Resultado/promessa da Meta** | Resultado de produto, recomendação operacional, estudo técnico ou claim da própria Meta; não é garantia universal. | “A Meta reporta/recomenda…” |
| **Evidência independente** | Estudo acadêmico ou fonte externa. É contexto, método ou hipótese, não explicação automática da conta atual. | “O estudo encontrou no contexto avaliado…” |
| **Dado observado da conta** | Medição obtida nesta consulta, com escopo e timestamp. | “A extração de [data] mostra…” |
| **Heurística operacional** | Regra interna para reduzir risco, melhorar auditabilidade ou priorizar investigação. Não atribuir à Meta. | “Recomendação interna: …” |
| **Hipótese** | Explicação ainda não confirmada. | “H4 continua plausível porque…” |

A skill deve colocar URL completa ao lado da fonte correspondente e nunca preencher métrica ausente com estimativa inventada. A classificação deve permanecer explícita mesmo quando uma recomendação interna coincidir com uma prática da Meta.

## 2. Modelo operacional da conta

A hierarquia é **campanha → conjunto de anúncios → anúncio**. Em termos operacionais, a campanha concentra objetivo e tipo de compra; o conjunto concentra audiência, exclusões, posicionamentos, orçamento, programação, evento e atribuição; o anúncio concentra formato, mídia, texto, identidade e CTA. Essa separação e os níveis disponíveis para análise são descritos pela Meta [1] [2].

Os objetivos simplificados — Awareness, Traffic, Engagement, Leads, App promotion e Sales — orientam a ação para a qual o sistema otimiza. Eles não são rótulos intercambiáveis nem substituem o resultado de negócio. Antes de recomendar mudança, registrar objetivo, evento de otimização, bid, orçamento, audiência, posicionamentos, criativos e status de learning [3].

### 2.1 Advantage+ e audiência efetiva

Distinguir três conceitos:

- **Audiência elegível:** pessoas que podem ser consideradas após controles, país/geografia, idade mínima, idioma, exclusões e regras de elegibilidade.
- **Audiência sugerida:** sinal dado pelo anunciante para orientar o sistema. Em Advantage+ audience ou detailed targeting, gênero, idade, detalhamento e inclusões de públicos podem ser sugestões; a entrega pode ultrapassá-las dentro dos controles aplicáveis [4] [5] [6].
- **Audiência alcançada:** pessoas para as quais houve impressão, observada por métricas agregadas e seus breakdowns. Não é sinônimo da configuração inserida.

Advantage+ deve ser descrito como automação orientada por sinais, previsão de ação e leilão; não como prova de que alguém foi escolhido exclusivamente por um atributo. Advantage+ placements amplia oportunidades entre posicionamentos elegíveis, mas disponibilidade depende de objetivo, criativo, país e configuração [7]. Com Advantage+ campaign budget (CBO), o orçamento pode ser redistribuído entre conjuntos; a avaliação primária deve ser no nível da campanha, não na igualdade de gasto entre conjuntos [8].

A distribuição observada em um placement não prova qualidade superior. Separar impressões, alcance, frequência, cliques, resultado, custo e objetivo. Uma oportunidade pode receber mais entrega por previsão de custo ou ação, não por ser universalmente melhor.

### 2.2 Orçamento, aprendizado e edição

O orçamento diário deve ser tratado como **média**, e não automaticamente como teto diário. A Meta informa flexibilidade de gasto que pode chegar a 75% acima em alguns dias, sem exceder sete vezes o orçamento diário na semana, para contas às quais a regra se aplica; confirmar a aplicabilidade na conta antes de comprometer caixa [9]. Orçamento vitalício é um teto total dentro da programação configurada.

A Meta descreve cerca de 50 resultados/eventos na semana posterior à última edição significativa como referência usual para sair da learning phase. Isso é uma indicação operacional da plataforma, não SLA, garantia de estabilidade, qualidade ou causalidade [10] [11] [12]. Mudança de targeting, criativo, evento, bid, novo anúncio ou pausa prolongada pode reiniciar ou perturbar o aprendizado.

**Regra interna de edição:** antes de uma mudança material, registrar motivo, proprietário, aprovação, `last_significant_edit`, snapshot anterior, janela de comparação e plano de rollback. Durante o aprendizado, evitar alterações desnecessárias, fragmentação excessiva e volume de anúncios incompatível com o orçamento.

## 3. Contrato mínimo de coleta e API

Antes de analisar ou sugerir mudança, solicitar ou obter:

- `account_id`, `campaign_id`, `adset_id` e `ad_id`, quando aplicável;
- objetivo, tipo de compra, evento de otimização, performance goal, bid strategy e controles de custo/ROAS;
- data inicial e final no fuso da conta, timestamp da consulta, moeda e modelo/janela de atribuição;
- orçamento, nível do orçamento, programação, limites e status de veiculação/learning;
- audiência, exclusões, localização, categoria especial e indicação de controles versus sugestões;
- placements, Advantage+ audience/detailed targeting, Advantage+ placements e Advantage+ campaign budget;
- identidade, criativo efetivo, variações automáticas de texto e anúncios concorrentes;
- pixel, Conversions API, evento, qualidade/correspondência e possíveis incidentes de tracking.

Na Ads Insights API, usar app com `ads_read`, o edge apropriado e `fields` explícitos: `/{ad-account-id}/insights`, `/{campaign-id}/insights`, `/{ad-set-id}/insights` ou `/{ad-id}/insights`. Declarar `date_preset` ou datas explícitas, nível, breakdowns, versão da API e timestamp. Validar a matriz de compatibilidade antes de enviar a requisição; não pedir fields proibidos com breakdown, nem combinar ação, atribuição e breakdown sem verificar suporte [13] [14] [15] [16].

Para grande volume, limitar datas, IDs, fields e cardinalidade. Paginar todas as respostas, usar consultas por nível inferior quando necessário, batch em chamadas síncronas e jobs assíncronos para operações longas. Implementar backoff de rate limit e registrar respostas parciais, timeouts e falhas. Nunca guardar access tokens em código, logs ou relatório; usar secrets e menor privilégio.

Os valores de breakdown são estimados. O breakdown `gender` descreve gênero agregado das pessoas alcançadas, não necessariamente o targeting configurado e não uma medida perfeita de identidade. Preservar `not specified`, `unknown` ou equivalente retornado pela versão da API; descartar essa categoria silenciosamente invalida a reconciliação [14] [16]. Resultados off-Meta, ações modeladas, reach/frequency e combinações de atribuição têm disponibilidade e restrições próprias.

### 3.1 Matriz de escopo obrigatória

A primeira página de qualquer análise deve conter uma matriz como esta:

| Dimensão | Valor a registrar | Falha se ausente |
|---|---|---|
| Conta e objeto | Conta, campanha, conjunto ou anúncio; IDs | Comparação entre universos diferentes |
| Período | Início/fim, fuso da conta e timestamp da extração | Diferença de calendário ou atraso confundida com entrega |
| Medição | Moeda, fields, denominador, nível e breakdown | Métricas incompatíveis |
| Negócio | Objetivo, tipo de compra, evento, performance goal | Otimização comparada com evento diferente |
| Atribuição | Janela/modelo, on-Meta versus off-Meta | CPA/ROAS não reconciliável |
| Entrega | Placement settings, plataforma, dispositivo, Advantage+ e CBO | Mix e automação ocultos |
| Público | Elegível, sugerido, controles, exclusões e categoria especial | Target confundido com reached |
| Estado | Learning, alterações, concorrência e incidências de tracking | Pré/pós não estacionário |

## 4. Protocolo de discrepância de gênero (GD-01)

**Objetivo.** Determinar se a diferença observada é uma característica descritiva da entrega, uma divergência de escopo/medição, uma hipótese de composição ou um efeito que merece experimento. O protocolo não autoriza concluir “bug”, “erro da Meta” ou “discriminação” sem evidência específica.

### Etapa 0 — Proteção e conformidade

Usar somente dados agregados e minimamente necessários. Aplicar acesso mínimo, retenção definida e supressão de células muito pequenas como **salvaguarda interna de privacidade e estabilidade**, não como regra citada da Meta. Não tentar reidentificar pessoas nem inferir identidade individual a partir de categoria demográfica. Em criativo, não afirmar nem insinuar atributo pessoal do espectador, inclusive gênero; revisar anúncio, landing page e targeting conforme os Advertising Standards [17] [18].

Se a campanha for de habitação, emprego ou produto/serviço financeiro, declarar a categoria especial antes de comparar. Restrições de idade, gênero, localização, exclusões, detalhamento e lookalike variam por país; campanhas desse escopo não devem ser tratadas como equivalentes às demais [19].

### Etapa 1 — Reconstituir o universo

Preencher a matriz de escopo e obter o snapshot de configuração. Confirmar que a comparação usa a mesma conta, IDs, nível, datas, fuso, geografia, status, objetivo, evento, orçamento, atribuição e versão da API. Identificar alterações significativas, CBO, learning, concorrência e automações.

### Etapa 2 — Extrair linha de base e cortes

Executar uma tabela sem breakdown e tabelas com filtros idênticos para:

- `gender`, preservando `not specified/unknown`;
- `age × gender`, quando suportado;
- `publisher_platform × gender`, `platform_position × gender` e `device_platform × gender`, quando suportados;
- país/região × gender, quando geografia for relevante;
- período, placement, plataforma e dispositivo como diagnósticos adicionais.

Solicitar, quando compatíveis, `impressions`, `reach`, `spend`, `frequency`, `CPM`, `clicks` e a ação alinhada ao objetivo, além de CPA/ROAS e valor. Guardar contagens e denominadores, não apenas percentuais. Confirmar paginação, filtros, atribuição e total sem breakdown.

Calcular participação por gênero dentro do mesmo universo, com denominador explícito. Reconciliar, dentro da tolerância documentada para estimativas e arredondamento, gasto, impressões, alcance, frequência, cliques e eventos. Não tratar participação de impressões isolada como evidência de qualidade ou viés.

### Etapa 3 — Rodar hipóteses na ordem de menor custo

| ID | Hipótese | Previsão observável | Comparação/teste | Achado que enfraquece |
|---|---|---|---|---|
| **H1** | Escopo, período, fuso, nível ou filtro divergem | A diferença desaparece ao alinhar o universo | Repetir consulta com IDs, datas, fuso, nível, geografia, status, atribuição e fields idênticos | Gap persiste após reconciliação completa |
| **H2** | Gênero configurado foi confundido com gênero alcançado | Breakdown reached não coincide com a sugestão/seleção; `unknown` muda o total | Comparar controles e sugestões reais com `gender` entregue; conservar categoria não especificada | Não há diferença após definição e denominador alinhados |
| **H3** | Advantage+ expandiu além da sugestão | Entrega fora da sugestão aparece quando o controle permite | Comparar condição com gênero como controle contra condição com gênero apenas como sugestão, mantendo objetivo, evento, orçamento, criativo, localização e placements | A expansão está desligada ou as condições têm a mesma entrega |
| **H4** | Mix de placement, plataforma ou dispositivo altera a composição | Gap agregado é explicado por alguns cortes de delivery | Estratificar `publisher_platform`, `platform_position`, `device_platform`, idade e geografia; comparar custo por evento, frequência e volume | Gap permanece homogêneo nos cortes relevantes |
| **H5** | Objetivo, evento, lance, orçamento, pacing ou learning orientam composição | Diferença acompanha custo/volume do evento otimizado ou estado de aprendizado | Comparar no mesmo objetivo/evento; avaliar gasto, resultado, custo, fase de learning e CBO no nível correto | Nenhuma relação com otimização, pacing ou estado aparece |
| **H6** | Elegibilidade e oportunidade real diferem | Mix alcançado reflete população, disponibilidade ou competição, não a configuração isolada | Comparar audiência elegível estimada, controles, impressões, alcance e leilão; checar sobreposição | População e oportunidades são comparáveis e gap persiste |
| **H7** | Criativo, relevância ou fadiga alteram resposta e entrega | Mudança acompanha ativo, hook, formato, placement ou repetição | Teste paired/A/B com audiência e configuração constantes; comparar evento, custo, frequência e resposta por célula | Gap permanece com criativo pareado e sem sinais de fadiga |
| **H8** | Atraso, modelagem, atribuição, baixa amostra ou tracking | Totais mudam com janela, paginação, estabilização ou qualidade do evento | Repetir após maturação; alinhar atribuição; separar on/off-Meta; auditar Pixel/CAPI, match e respostas completas | Dados estáveis, completos e compatíveis continuam divergentes |

A ordem é uma **heurística de triagem**, não uma causalidade estabelecida. Se uma hipótese continua plausível, a conclusão deve dizê-lo; se faltam dados, o resultado é “não determinado”.

### Etapa 4 — Comunicação da conclusão

Usar sempre três camadas:

1. **O que os dados mostram:** objeto, período, métricas, denominadores, categorias e limitações da extração.
2. **O que permanece plausível:** hipóteses apoiadas por padrão observado e hipóteses já enfraquecidas.
3. **O que falta verificar:** consulta, configuração, experimento, janela de conversão, tracking, amostra ou revisão de política.

Exemplo de conclusão adequada: “No conjunto X, de 1 a 7 de março no fuso Y, a participação de impressões por gênero divergiu; `not specified` representou parte do total. O corte placement × gender explica parte do gap, enquanto a extração não permite avaliar ações off-Meta. Advantage+ está ativo, portanto a configuração de gênero não é evidência de restrição. Causa não determinada; repetir com janela estabilizada e testar H3/H4.”

## 5. Testes A/B, incrementalidade e critérios estatísticos

### 5.1 Escolha do desenho

| Pergunta | Desenho | O que pode concluir |
|---|---|---|
| Qual versão/estratégia teve melhor resultado observado? | A/B ou Creative Test | Diferença entre células aleatorizadas, normalmente em custo por resultado; não é conversão incremental |
| Quantos resultados adicionais vieram da oportunidade de anúncio? | Holdout ou Conversion Lift | Incrementalidade por intent-to-treat entre grupo de teste elegível e controle |
| Onde a diferença aparece? | Breakdown descritivo | Composição e diagnóstico; não causalidade |
| O efeito varia por gênero? | Interação tratamento × gênero dentro de experimento | Heterogeneidade exploratória ou pré-especificada, com intervalo, poder e controle de multiplicidade |

No A/B, usar grupos randomizados e não sobrepostos. A Meta descreve divisão aleatória e prevenção de que a mesma pessoa veja versões diferentes; ligar e desligar conjuntos manualmente não fornece a mesma garantia [20] [21]. Mudar uma única variável torna o resultado interpretável [22].

Conversion Lift usa grupo de teste elegível a receber anúncio e controle não elegível. A análise deve preservar **intent-to-treat**: comparar quem foi designado, mesmo que parte do teste não veja impressão. Incremental attribution é um modelo de machine learning para estimar conversões causadas e otimizar entrega; não é, sozinho, experimento randomizado [23] [24].

### 5.2 Plano obrigatório antes do lançamento

Gerar um plano com `experiment_id`, hipótese, `control_id`, `variant_id`, variável alterada, unidade de randomização, unidade de análise, população, datas e fuso, objetivo, evento primário, denominador, métricas de guarda, janela de atribuição, efeito mínimo relevante, poder, orçamento, concorrência e regra de parada.

O controle e as variantes devem ter audiência elegível compatível, versões não sobrepostas, orçamento comparável, objetivo/evento íntegros e nenhuma diferença além da variável planejada. Congelar orçamento e configuração. Registrar edições, troca de criativo, reentrada em learning, incidente de tracking e anúncios concorrentes; se a comparabilidade for comprometida, marcar o estudo como **comprometido**, não reinterpretar o resultado.

Para A/B, planejar pelo menos sete dias quando a janela de conversão permitir e respeitar ciclo de compra; a documentação consultada indica janela operacional de um a trinta dias [20] [25]. A duração e o poder devem refletir latência e volume, não apenas o calendário.

Para Conversion Lift, separar elegibilidade de poder e não misturar referências de produto: a página do produto menciona como guia self-serve campanha iniciada no último ano, pelo menos US$ 5.000 e 500 conversões, com prorrateamento acima de 90 dias; a página de boas práticas recomenda pelo menos US$ 10.000, holdout de 10% e mais de 500 conversões durante o teste [26] [23]. Esses números são guias da Meta para produtos/cenários específicos, não leis estatísticas universais.

### 5.3 Parada e leitura

Escolher antes do lançamento entre:

- **Horizonte fixo:** ler no fim da janela pré-definida. Não parar no primeiro cruzamento observado em leituras intermediárias.
- **Sequencial:** pré-definir eficácia, futilidade, `n` mínimo/máximo, frequência de leitura, datas e método. Não interromper apenas porque um p-valor ou confidence cruzou limiar não planejado [27] [28].

Confidence da interface não deve ser chamado automaticamente de p-valor. A documentação consultada descreve 65% ou mais como critério de vencedor de A/B e 90% ou mais como resultado estatisticamente confiável em lift tests; reportar o produto, definição, intervalo e magnitude, sem transformar esses limiares em alfa universal [29] [30]. Poder de 80% é recomendação de planejamento, não garantia.

CUPED pode reduzir variância usando covariável pré-experimento, mas somente depois de randomização válida. Congelar a definição da covariável, verificar equilíbrio, ausências e sample-ratio mismatch e preservar a estimativa não ajustada. CUPED não corrige alocação não aleatória [31] [32].

### 5.4 Relatório de experimento

Para cada célula, mostrar alcance elegível, impressões, frequência, gasto, eventos, taxa, custo, valor/ROAS quando adequado, efeito, intervalo, confidence/método, janela, poder, concorrência, integridade do evento e motivo de parada. Separar resultado descritivo de conclusão causal.

Não chamar custo por resultado de conversão incremental sem holdout. Não chamar ausência de vencedor de equivalência. Não chamar confiança alta de relevância econômica. Se subgrupos por gênero, idade ou placement forem muitos, declarar exploração, número de leituras, interação pré-especificada e ajuste/controle de multiplicidade [33].

## 6. Teste de criativo e fadiga

Antes de gerar variantes, exigir objetivo, evento, público, país, placements, período, orçamento, atribuição, restrições de marca e ativo-base. Registrar exatamente um eixo alterado: `hook`, `mensagem`, `prova`, `formato`, `CTA` ou `placement`. Uma matriz cruzada de eixos é exploratória ou deve ser decomposta em rodadas.

Gerar três hooks candidatos sem afirmar qual vencerá. Cada um deve ter uma promessa única, CTA coerente, leitura sem áudio, legendas e zona segura para o placement. As referências de até 125 caracteres no texto principal, 40 no título e 25 na descrição são orientações sujeitas a truncamento, idioma, placement e otimização automática; registrar o texto efetivamente entregue [34] [35]. Em vídeo, priorizar mensagem/marca cedo, primeiro frame forte, legendas e adaptação ao placement [36] [37].

Para duas variantes, preferir A/B formal. Para três ou quatro, usar Creative Test ou testes separados e declarar se há controle pareado. Não inventar lift ou significância. Com CBO, avaliar primeiro no nível da campanha; com orçamento por conjunto, avaliar o conjunto, respeitando a configuração.

Diagnosticar fadiga por deterioração relativa contra baseline, acompanhada de repetição e exposição. Frequência isolada não é limiar universal. Confirmar repetição do ativo em outras campanhas da Página, sazonalidade, oferta, concorrência, learning, mix de placement e tracking antes de trocar criativo ou expandir audiência [38] [39] [40].

A IA deve bloquear claims não comprovados, estereótipos e atributos pessoais. Um criativo diferente não deve ser justificado por suposta preferência intrínseca de gênero; se houver hipótese de heterogeneidade, testá-la com randomização e controle.

## 7. Checklists operacionais

### 7.1 Checklist de intake e pré-voo

- [ ] Resultado de negócio, objetivo, tipo de compra e evento de otimização estão explícitos.
- [ ] IDs, nível do objeto, conta, fuso, moeda, datas e timestamp estão registrados.
- [ ] Atribuição, performance goal, lance, orçamento, programação e limites estão registrados.
- [ ] Audiência elegível, sugestões, controles, exclusões, geografia e categoria especial estão separados.
- [ ] Advantage+ audience/detailed targeting, placements e campaign budget estão identificados.
- [ ] Criativo efetivo, identidade, CTA, variações automáticas e concorrência estão registrados.
- [ ] Learning, últimas edições, automações, permissões e incidências de tracking foram verificados.
- [ ] A pergunta foi classificada como diagnóstico, A/B ou incrementalidade.

### 7.2 Checklist de extração e qualidade

- [ ] App tem `ads_read`; token não aparece em código, logs ou relatório.
- [ ] Endpoint, API version, fields, `date_preset/dates`, nível e breakdowns são explícitos.
- [ ] Compatibilidade de breakdown, métricas e atribuição foi validada antes da requisição.
- [ ] Paginação terminou; timeout, rate limit, job assíncrono e respostas parciais foram registrados.
- [ ] Existe linha de base sem breakdown e cortes com filtros idênticos.
- [ ] `not specified/unknown` foi preservado.
- [ ] Contagens, denominadores, totais, moeda e atribuição foram reconciliados.
- [ ] Células pequenas, estimativas, modelagem, atraso e off-Meta foram sinalizados.

### 7.3 Checklist de discrepância de gênero

- [ ] O gap foi definido como métrica, denominador, universo e janela.
- [ ] Targeting configurado não foi confundido com gender reached.
- [ ] H1–H8 foram avaliadas na ordem; cada hipótese tem previsão e falsificador.
- [ ] Delivery foi separado de resposta atribuída.
- [ ] Placement, plataforma, dispositivo, idade e geografia foram estratificados quando suportados.
- [ ] CBO/pacing foi avaliado no nível correto.
- [ ] Fadiga, criativo, sobreposição, concorrência, learning e alterações foram verificados.
- [ ] Atraso, modelagem, atribuição, Pixel/CAPI, match e paginação foram auditados.
- [ ] A conclusão usa “não determinado” quando a evidência não identifica causa.
- [ ] Não há inferência sobre indivíduos nem linguagem de discriminação sem evidência causal e revisão adequada.

### 7.4 Checklist de lançamento de A/B ou Lift

- [ ] Hipótese, variável única, controle, tratamento, unidade, população e métrica primária estão pré-especificados.
- [ ] Métricas de guarda, efeito mínimo relevante, poder, duração e janela estão definidos.
- [ ] Células são aleatorizadas, não sobrepostas e livres de campanha concorrente relevante.
- [ ] Orçamento, evento, atribuição e criativos estão congelados.
- [ ] Regra de parada fixa ou sequencial está escrita antes da leitura.
- [ ] Interações por gênero/idade/placement estão pré-especificadas ou marcadas exploratórias.
- [ ] O relatório preservará resultado não ajustado, denominadores, intervalo e motivo de parada.

### 7.5 Checklist de alteração e automação

- [ ] Regra começa em modo alerta/notificação.
- [ ] Escopo, condição, janela de dados, frequência, teto de mudança, responsável e rollback estão definidos.
- [ ] Mudança de orçamento, bid, evento, targeting, criativo ou pausa tem aprovação e snapshot.
- [ ] Depois da edição, Delivery, Results e Optimization events serão observados antes de concluir.
- [ ] Activity history e permissões foram conferidos; Admin fica reservado a billing/permissões, Advertiser a criação/edição e Analyst a leitura/relatórios [41] [42] [43].

## 8. Critérios de decisão

| Situação | Decisão recomendada | Linguagem proibida |
|---|---|---|
| Extração incompleta, escopo divergente ou breakdown incompatível | Corrigir consulta e repetir; status **não determinado** | “A Meta errou” |
| Gap explicado por placement, dispositivo, CBO ou denominador | Documentar composição; otimizar somente após verificar objetivo e custo | “Placement X é pior para gênero Y” sem ajuste |
| Advantage+ sugere, mas não controla, gênero | Tratar o gap como reached versus sugestão; comparar controles e teste | “A Meta ignorou o targeting” |
| A/B com vencedor descritivo e sem holdout | Escolher a versão observadamente melhor na métrica pré-definida, com cautela | “Gerou conversões incrementais” |
| Lift com intervalo útil, poder e evento íntegro | Considerar mudança se efeito e relevância econômica superarem critérios pré-definidos | “Confidence prova causalidade universal” |
| Baixo volume, células pequenas ou múltiplas leituras não planejadas | Aguardar, consolidar, replicar ou marcar inconclusivo | “Diferença significativa” por um gap isolado |
| Tracking ou atribuição incompatível | Corrigir instrumentação e reprocessar janela; não otimizar agressivamente | “É problema de entrega” |
| Categoria especial ou política potencialmente aplicável | Parar a mudança, validar restrições e encaminhar revisão humana/jurídica | Comparação direta com campanha comum |
| Regra automatizada que pode pausar ou alterar orçamento | Manter alerta, simular e aprovar rollback antes de ativar | Ativar ação irreversível sem guardrail |

Uma recomendação de alteração deve incluir **ação**, **objeto e IDs**, **hipótese**, **métrica primária**, **janela de avaliação**, **guardrails**, **risco**, **rollback**, **fonte** e **nível de confiança**. Se a ação depende de hipótese ainda não falsificada, priorizar teste ou coleta adicional em vez de mudança permanente.

## 9. Formato de saída da skill Claude Code

A resposta deve seguir este esqueleto:

```text
Status: determinado | parcialmente determinado | inconclusivo | não determinado
Pergunta e decisão solicitada:
Escopo e matriz de comparabilidade:
Dados observados (com timestamp, API version, fields e filtros):
Fatos oficiais da Meta:
Evidência independente:
Heurísticas operacionais usadas:
Protocolo GD-01 e hipóteses H1–H8:
Resultado de cada hipótese: apoiada | enfraquecida | não testada
Teste recomendado: A/B | Creative Test | Holdout | Conversion Lift | nenhum
Critérios de parada e decisão:
Riscos, privacidade e conformidade:
Ação proposta, rollback e proprietário:
Fontes com URLs completas:
```

A saída deve distinguir a configuração planejada, a audiência elegível, a sugestão, a entrega alcançada e a ação atribuída. Toda conclusão causal exige desenho experimental adequado; toda conclusão operacional deve informar sua incerteza.

## 10. Referências
[1]: https://www.facebook.com/business/help/621956575422138 "Meta for Business — What are the advertising levels in Meta Ads Manager?"
[2]: https://www.facebook.com/business/help/407108559393196 "Meta for Business — About ad placements across Meta technologies"
[3]: https://www.facebook.com/business/help/1438417719786914 "Meta for Business — How to choose the right ad objective in Meta Ads Manager"
[4]: https://www.facebook.com/business/help/273363992030035 "Meta for Business — About Advantage+ audience"
[5]: https://www.facebook.com/business/help/938372127764391 "Meta for Business — About Audience controls and Audience suggestions in Advantage+ audience"
[6]: https://www.facebook.com/business/help/128066880933676 "Meta for Business — About Advantage+ detailed targeting"
[7]: https://www.facebook.com/business/help/196554084569964 "Meta for Business — About Advantage+ placements"
[8]: https://www.facebook.com/business/help/153514848493595 "Meta for Business — About Advantage+ campaign budget"
[9]: https://www.facebook.com/business/help/214319341922580 "Meta for Business — About budgets"
[10]: https://www.facebook.com/business/help/112167992830700 "Meta for Business — About the learning phase"
[11]: https://www.facebook.com/business/help/316478108955072 "Meta for Business — Significant edits and learning phase"
[12]: https://www.facebook.com/business/help/269269737396981 "Meta for Business — About learning limited"
[13]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights "Meta for Developers — Ads Insights API"
[14]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/breakdowns "Meta for Developers — Insights API Breakdowns"
[15]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/best-practices "Meta for Developers — Limits and Best Practices"
[16]: https://www.facebook.com/business/help/334565827335725 "Meta for Business — Specifications for breakdowns in Meta Ads Reporting"
[17]: https://transparency.meta.com/policies/ad-standards/ "Meta Transparency Center — Introduction to the Advertising Standards"
[18]: https://transparency.meta.com/policies/ad-standards/objectionable-content/privacy-violations-personal-attributes/ "Meta Transparency Center — Privacy Violations and Personal Attributes"
[19]: https://www.facebook.com/business/help/2220749868045706 "Meta for Business — About audiences for housing, employment or financial products and services campaigns"
[20]: https://www.facebook.com/business/help/1738164643098669 "Meta — About A/B testing"
[21]: https://www.facebook.com/business/help/1915029282150425 "Meta — About Experiments"
[22]: https://www.facebook.com/business/help/290009911394576 "Meta — Best practices for A/B Testing"
[23]: https://www.facebook.com/business/help/221353413010930 "Meta — About Conversion Lift"
[24]: https://www.facebook.com/business/help/2366718460372682 "Meta — About incremental attribution"
[25]: https://www.facebook.com/business/help/449517765847905 "Meta — Measure Your Facebook Advertising With Experimentation"
[26]: https://www.facebook.com/business/help/4264682973751516 "Meta — Best practices to set up a Conversion Lift test"
[27]: https://amplitude.com/explore/experiment/sequential-testing "Amplitude — Sequential Testing Explained"
[28]: https://www.tandfonline.com/doi/full/10.1080/00031305.2023.2257237 "Larsen et al. — Statistical Challenges in Online Controlled Experiments"
[29]: https://www.facebook.com/business/help/239549606692303 "Meta — About Confidence in Your Facebook Tests and Experiments"
[30]: https://www.facebook.com/business/help/1376548572415613 "Meta — Viewing and understanding A/B test results"
[31]: https://exp-platform.com/Documents/2013-02-CUPED-ImprovingSensitivityOfControlledExperiments.pdf "Deng et al. — Improving the Sensitivity of Online Controlled Experiments by Utilizing Pre-Experiment Data"
[32]: https://docs.datadoghq.com/experiments/statistics/cuped/ "Datadog — CUPED: Variance Reduction Technique"
[33]: https://dl.acm.org/doi/fullHtml/10.1145/3442381.3450106 "Barajas & Bhamidipati — Incrementality Testing in Programmatic Advertising"
[34]: https://www.facebook.com/business/help/223409425500940 "Meta — Creative best practices for text in ads"
[35]: https://www.facebook.com/business/help/264160060861852 "Meta — About breakdowns, metrics and filtering in Meta Ads Reporting"
[36]: https://www.facebook.com/business/help/188534925073536 "Meta — Best practices for Instagram video ads"
[37]: https://www.facebook.com/business/news/the-science-of-the-hook-how-to-supercharge-your-reels-performance "Meta — The Science of the Hook"
[38]: https://www.facebook.com/business/help/1346816142327858 "Meta — About creative fatigue recommendations in Meta Ads Manager"
[39]: https://www.facebook.com/business/help/2720085414702598 "Meta — About managing ad volume"
[40]: https://www.facebook.com/business/ads/ad-formats "Meta — Ad Formats"
[41]: https://www.facebook.com/business/help/644860419002064 "Meta — Create an automated rule in Meta Ads Manager"
[42]: https://www.facebook.com/business/help/289211751238030 "Meta — How to view activity history for your ads"
[43]: https://www.facebook.com/business/help/155909647811305 "Meta — Ad account permission roles"
[44]: https://www.facebook.com/business/help/1000688343301256 "Meta for Business — About ad delivery"
[45]: https://www.facebook.com/business/help/1362234537597370 "Meta for Business — About Advantage+ sales campaigns"
[46]: https://www.facebook.com/business/help/182371508761821 "Meta for Business — About detailed targeting"
[47]: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/v2.4/ "Meta for Developers — Legacy/versioned Insights API Breakdowns reference"
[48]: https://about.fb.com/wp-content/uploads/2023/01/Toward_fairness_in_personalized_ads.pdf "Meta — Toward fairness in personalized ads"
[49]: https://arxiv.org/html/1904.02095v5 "Ali et al. — Discrimination through optimization: How Facebook’s ad delivery can lead to skewed outcomes"
[50]: https://gap.hks.harvard.edu/algorithmic-bias-empirical-study-apparent-gender-based-discrimination-display-stem-career-ads "Lambrecht & Tucker — Algorithmic Bias? An Empirical Study into Apparent Gender-Based Discrimination in the Display of STEM Career Ads"
[51]: https://www.facebook.com/business/help/950694752295474 "Meta — Best practices for Meta ads delivery"
[52]: https://www.facebook.com/business/help/770303663944673 "Meta — About the breakdown effect when advertising on our system"
[53]: https://www.facebook.com/business/help/2419480091640105 "Meta — Combine ad sets and campaigns to reduce audience fragmentation"
[54]: https://www.facebook.com/business/help/487269218011981 "Meta — About Meta Ads Reporting"
[55]: https://www.facebook.com/government-nonprofits/blog/ads-reporting "Meta — Government, nonprofit and advocacy ads reporting/breakdowns"
[56]: https://www.facebook.com/business/help/460276478298895 "Meta — About attribution models and attribution settings"
[57]: https://www.facebook.com/business/help/565573477186194 "Meta — Creative best practices for conversion testing"
[58]: https://www.facebook.com/business/help/1423851372208214 "Meta — Set up a creative test in Meta Ads Manager"
[59]: https://www.facebook.com/business/help/1364841787225722 "Meta — Understand fluctuations in ad performance"
[60]: https://link.springer.com/article/10.1007/s10660-021-09494-9 "Suh, Wilson e On — Estudo sobre atenção visual por gênero em publicidade digital place-based"
[61]: https://thearf.org/category/ua_resource/do-ads-really-wear-out-evidence-and-implications-for-media/ "Advertising Research Foundation — Do Ads Really Wear Out?"
[62]: https://www.sciencedirect.com/science/article/abs/pii/S0167923624001568 "Guo e Jiang — Modelo de publicidade dinâmica com fadiga"
[63]: https://academic.oup.com/pnasnexus/article/3/7/pgae247/7695718 "PNAS Nexus — Systematic discrepancies in the delivery of political ads on Meta"
[64]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9299278 "Al Tamime & Weber — Using social media advertisement data to monitor the gender gap in STEM"
[65]: https://www.facebook.com/business/help/166313650471318 "Meta — How winning campaigns are determined in A/B tests without a holdout"

## 10. Recursos externos avaliados e atualização de Creative Test

### 10.1 Recursos enviados pelo usuário

As páginas da **The Moonlighters** foram acessadas em 2026-09-24. A biblioteca de criativos promete acesso a criativos estáticos e em vídeo de marcas de e-commerce; a página de materiais gratuitos lista calculadora de investimento, biblioteca de criativos, fluxograma de campanhas e o “M3 Method”. As páginas são materiais comerciais/educacionais de terceiros, não documentação da Meta, e informam que não são endossadas pela Meta. Como o conteúdo completo está atrás de captura ou acesso, a skill deve usá-las para inspiração e catalogação, não para afirmar que um criativo “funciona” sem dados da conta.

O estudo de caso enviado apresenta claims comerciais de crescimento, ROAS e lucro de clientes. A página consultada também oferece outros estudos de caso. Esses números não devem ser transplantados para uma recomendação sem verificar: objetivo, país, canal, spend, margem, atribuição, período, baseline, sazonalidade, alterações simultâneas, criativos, landing page e definição de ROAS. A skill deve extrair o mecanismo alegado — por exemplo, simplificação de estrutura, melhoria de criativos ou processo de testes — e etiquetá-lo como **claim do fornecedor** até haver evidência reproduzível.

Links avaliados:

- Biblioteca de criativos: https://go.themoonlighters.com/d46638df
- Materiais gratuitos: https://go.themoonlighters.com/11eb9600
- Estudo de caso: https://go.themoonlighters.com/9d95396e

### 10.2 Vídeo enviado e alternativas

O vídeo enviado, https://www.youtube.com/watch?v=CPc4lB33Rv, retornou **“This video isn't available anymore”**; portanto, nenhum conteúdo do vídeo pode ser atribuído à skill.

Materiais melhores para estudo, priorizados pela confiabilidade e utilidade operacional:

1. **Meta Blueprint — Measure the impact of your ad creative**, curso gratuito de 20 minutos com lições sobre importância do teste, A/B e métricas, lift tests e preparação: https://www.facebookblueprint.com/student/path/253050-ad-creative-testing-course
2. **Meta — Set up a creative test in Meta Ads Manager**, documentação operacional. Confirma 2–7 variantes, `Highest volume`, recomendação de até 20% do orçamento existente, seleção de métrica, duração, retenção dos aprendizados e ausência de confidence level: https://www.facebook.com/business/help/1423851372208214
3. **Meta — About Experiments**, referência para A/B, Brand Lift e Conversion Lift. O A/B compara até 5 versões em grupos aleatorizados e não sobrepostos; Conversion Lift usa teste e controle para medir incrementalidade: https://www.facebook.com/business/help/1915029282150425
4. **Vídeo de terceiros sobre a nova ferramenta de Creative Testing**, útil para demonstração visual, mas secundário à documentação da Meta: https://www.youtube.com/watch?v=k1Ie8jBC7mI
5. **Guia independente de testes por orçamento**, útil para comparar pre-flight, new-vs-BAU e scaling, mas com claims de agência e sem substituir um desenho experimental: https://motionapp.com/blog/ultimate-guide-creative-testing-2025

O vídeo `k1Ie8jBC7mI` foi localizado com título “NEW Meta & Facebook Ads Creative Testing Feature Explained (2026)” e duração exibida de 13:15. O vídeo de 7knQyPYLmfo foi localizado como “How to Test Facebook Ads Creatives at Every Budget (2026)”, mas o conteúdo não pôde ser extraído de forma suficiente; não atribuir regras específicas a ele.

### 10.3 Regras implementáveis derivadas da atualização

1. Perguntar primeiro se a necessidade é inspiração, teste de criativo dentro de uma campanha existente, comparação causal de versões ou incrementalidade. Escolher biblioteca, Creative Test, A/B Test ou Conversion Lift respectivamente.
2. Para Creative Test, validar `Highest volume`, 2–7 variantes, orçamento de teste recomendado de no máximo 20%, métrica, duração e a ausência de confidence level. Não prometer um vencedor estatístico nem fazer alterações automáticas depois do teste.
3. Para A/B Test, preservar randomização, grupos não sobrepostos, uma variável principal e o limite documentado de até 5 versões. Para Conversion Lift, validar fonte de conversões, controle e elegibilidade.
4. Em orçamento limitado, usar 2–4 criativos novos com um eixo isolado. Depois testar o melhor novo contra o melhor anúncio atual; não misturar histórico acumulado e novidade sem declarar “new vs. BAU”.
5. Ao estudar um caso comercial, produzir uma tabela `claim`, `evidência fornecida`, `definição da métrica`, `o que falta`, `hipótese reproduzível` e `risco de generalização`.
6. Ao usar uma biblioteca, registrar para cada referência `marca`, `produto`, `ângulo`, `hook`, `formato`, `oferta`, `CTA`, `placement`, `data`, `fonte` e `hipótese`; não copiar identidade, marca, imagem ou claim sem autorização.
