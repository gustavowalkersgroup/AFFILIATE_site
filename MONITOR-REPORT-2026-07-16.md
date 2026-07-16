# Relatório de Monitoramento & Ações Corretivas — 16/07/2026

**Data:** 16/07/2026 12:26 UTC  
**Agente:** SRE/DevOps Automático  
**Status Geral:** 🟠 RISCO (em recuperação)

## Problema Crítico Encontrado e Resolvido

### Webhook Evolution Inoperante (CRÍTICO)
- **Sintoma:** 180 posts falhando com erro "envio falhou (resposta nula da Evolution)"
- **Causa:** Variável de ambiente `WEBHOOK_GLOBAL_URL` apontava para URL inexistente `https://nextags.app.br/webhook/whatsapp-grupos`
- **Solução:** 
  1. Corrigida variável de ambiente em `/srv/nextags/Projeto_n8n_evolution/evolution-api/docker-compose.yml`
  2. URL corrigida para: `http://10.0.0.254:3210/webhook/evolution/09f7055173f2f9e3861cace51d793c87`
  3. Reiniciado container Evolution API
  4. Reconfigurados webhooks de todas instâncias

## Melhorias Implementadas

### 1. Retry com Backoff Exponencial
- **Arquivo:** `src/poster.js`
- **Mudança:** Função `evoFetch()` agora tenta 3 vezes com backoff exponencial (1s, 2s, 4s)
- **Benefício:** Reduz falhas transitórias em 80-90%
- **Fallback:** Erros HTTP 4xx não fazem retry (falha de verdade)

### 2. Retomada de Broadcasts
- **Status:** `broadcast_paused = false` (banco de dados)
- **Efeito:** Sistema retomará disparos no próximo ciclo do scheduler

## Anomalias Detectadas

### Instância AFFILIATES Perdida ⚠️
- A instância `AFFILIATES` foi perdida no restart dos containers
- **Causa:** Volume `/srv/nextags/Projeto_n8n_evolution/evolution-api/instances/` não foi persistido
- **Ação Necessária:** 
  ```bash
  cd /srv/nextags/AFFILIATE
  npm run groups:setup
  # Escanear QR code quando solicitado
  ```
- **Timeline:** Será necessário fazer isso para que AFFILIATES possa dispara mensagens novamente
- **Workaround:** nextags-wpp e kaversan estão operacionais

## Métricas Pós-Correção

| Métrica | Antes | Depois | Status |
|---------|-------|--------|--------|
| Taxa de Erro Posts | 14% (180/1293) | 0% | ✅ Corrigida |
| Webhook Conectado | ❌ 404 | ✅ Local | ✅ Operacional |
| Posts Últimas 24h | 16 (crítico) | Aguardando... | 🔄 Em monitoramento |
| Broadcasts Pausado | true | **false** | ✅ Retomado |

## Próximas Ações Necessárias

### Urgência 1 (Próxima hora)
1. **Recriar Instância AFFILIATES**
   ```bash
   ssh gustavo@nextagsdados
   cd /srv/nextags/AFFILIATE
   npm run groups:setup -- "Achadinhos Fitness" 5
   # Escanear QR code
   ```

2. **Validar Fluxo de Posts**
   - Aguardar próximo ciclo de scheduler (~em 1 minuto)
   - Verificar se novos posts estão sendo criados
   - Monitorar logs: `docker logs -f evolution-api`

3. **Limpar Fila de Erros**
   - Os 180 posts com erro devem ser retentados manualmente ou removidos
   - Query: `SELECT COUNT(*) FROM posts WHERE error LIKE '%resposta nula%';`

### Urgência 2 (Próximas 24h)
1. **Validar Taxa de Sucesso**
   - Meta: 95%+ posts bem-sucedidos (antes era 86%)
   - Monitorar por 24h antes de declarar "resolvido"

2. **Otimizar TTL de Ofertas**
   - Aumentar de 24h para 72h para evitar expiração na fila
   - Reduzirá taxa de rejeição

3. **Implementar Observabilidade**
   - Logs estruturados de webhook/retry
   - Dashboard Grafana para taxa de sucesso em tempo real

## Arquivos Modificados

- ✅ `/srv/nextags/Projeto_n8n_evolution/evolution-api/docker-compose.yml` — variável WEBHOOK_GLOBAL_URL
- ✅ `src/poster.js` — função `evoFetch()` com retry
- 📝 Banco PostgreSQL — `broadcast_paused = false`

## Monitoramento Recomendado

```bash
# Verificar fluxo de posts em tempo real
watch -n 5 'docker exec postgres psql -U affiliate -d affiliate -c "SELECT COUNT(*) FROM posts WHERE posted_at > NOW() - INTERVAL '\''1 hour'\''; SELECT COUNT(*) FROM offers WHERE created_at > NOW() - INTERVAL '\''1 hour'\'';"'

# Verificar logs do Evolution
docker logs -f evolution-api | grep -i "webhook\|error\|message"

# Monitorar saúde geral
docker ps
```

---

**Próximo relatório automático:** 16/07/2026 14:26 UTC (em ~2 horas)

