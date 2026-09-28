# Caso de teste: Achadinhos Fitness — Grupo WhatsApp

## Escopo observado

Conta: `act_2528249354337240` (Achadinhos Fitness), moeda BRL. Campanha: `120251242963830189`, **Achadinhos Fitness - Grupo WhatsApp**. Objetivo retornado: `OUTCOME_TRAFFIC`. Período consultado: **2026-09-21 a 2026-09-23**; tratar como janela parcial em relação ao dia atual. Conjunto: `120251242992140189`, **BR Mulheres 25-45 Fitness**, com status efetivo `PAUSED` no momento da consulta, orçamento diário retornado de BRL 30,00.

## Evidência de breakdown

No breakdown `gender`, a API retornou, entre outras linhas, os seguintes valores de `inline_link_clicks`:

| Anúncio | Gênero | Impressions | Link clicks | Amount spent (BRL) |
|---|---:|---:|---:|---:|
| Achadinhos Fitness - Ad 1 | female | 196 | 196 | 6,96 |
| Achadinhos Fitness - Ad 1 | male | 63 | 63 | 1,51 |
| Ofertas Fitness Shopee - Pesos AB | female | 34 | 34 | 1,19 |
| Ofertas Fitness Shopee - Pesos AB | male | 531 | 531 | 16,43 |
| Ofertas Fitness Shopee - Yoga AB | male | 0 | 0 | 0,00 |
| Ofertas Fitness Shopee - Crossfit AB | female | 0 | 0 | 0,01 |
| Ofertas Fitness Shopee - Crossfit AB | male | 4 | 4 | 0,19 |
| Linhas unknown | unknown | 1 | 1 | 0,03 |

Somando as linhas exibidas, há **230 Link clicks femininos**, **598 Link clicks masculinos** e **1 Link click unknown**. Portanto, nesta resposta da API, homens representam aproximadamente **72,1%** dos Link clicks conhecidos (598 ÷ 828), e não 92%. Isso não invalida o relato do usuário: pode ser outra janela, outra campanha, outro nível, outra definição de “clique” ou uma mudança posterior. A conclusão correta é investigar a divergência, não substituir o dado do usuário por esta amostra.

## Hipóteses a verificar

1. A consulta pode não ser a campanha relatada.
2. O usuário pode ter observado `Clicks (all)` enquanto a consulta usa Link clicks.
3. O período ou fuso pode não coincidir.
4. O nome do conjunto pode não refletir a configuração efetiva; é necessário obter os campos de targeting completos.
5. Pode haver expansão de audiência, placements ou identidade de publicação que alterem a interpretação.
6. O breakdown pode conter linhas agregadas por anúncio e gênero; somar sem preservar o nível gera erro.
7. O volume pode ser pequeno ou parcial; não tratar a composição como estável sem janela adequada.

## Teste de regressão para a skill

A skill deve:

- localizar o ID, não confiar apenas no nome;
- declarar objetivo `OUTCOME_TRAFFIC`, período e moeda;
- distinguir `Link clicks` de `Clicks (all)`;
- calcular o percentual com denominador declarado;
- excluir `unknown` do percentual principal e reportá-lo separadamente;
- não afirmar que a API provou 92% de homens;
- apontar que o conjunto está nomeado para mulheres, mas que o nome não prova entrega;
- solicitar targeting/placements/expansão antes de sugerir correção;
- propor um teste controlado e um plano de rollback.

Fonte primária: export JSON do conector Meta Marketing salvo no ambiente de execução, consultado em 2026-09-23.
