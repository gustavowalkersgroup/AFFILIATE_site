#!/usr/bin/env python3
"""Gera o JSON de import do workflow 'Grupo Fitness — Link Inteligente' para o
n8n self-hosted (n8n-walkers), embutindo o código do nó e a API key da Evolution
(lida do .env do projeto). Uso: python3 build-workflow.py > /tmp/grupo-fitness.json"""
import json, pathlib, re, sys

HERE = pathlib.Path(__file__).parent
code = (HERE / 'grupo-fitness.code.js').read_text(encoding='utf-8')

env = (HERE / '..' / '.env').read_text(encoding='utf-8')
m = re.search(r'^EVOLUTION_APIKEY=(.+)$', env, re.M)
if not m:
    sys.exit('EVOLUTION_APIKEY não encontrada no .env')
code = code.replace('__EVOLUTION_APIKEY__', m.group(1).strip())

wf = {
    "id": "GrupoFitnessLink",
    "name": "Grupo Fitness — Link Inteligente",
    "active": True,
    "settings": {"executionOrder": "v1"},
    "nodes": [
        {
            "id": "wh-entrada",
            "name": "Entrada (link público)",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [0, 0],
            "webhookId": "grupofitness-link-inteligente",
            "parameters": {
                "httpMethod": "GET",
                "path": "grupo-fitness",
                "responseMode": "responseNode",
                "options": {},
            },
        },
        {
            "id": "code-escolher",
            "name": "Escolher grupo",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [220, 0],
            "parameters": {"jsCode": code},
        },
        {
            "id": "if-tem-link",
            "name": "Tem link?",
            "type": "n8n-nodes-base.if",
            "typeVersion": 2,
            "position": [440, 0],
            "parameters": {
                "conditions": {
                    "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose"},
                    "combinator": "and",
                    "conditions": [
                        {
                            "leftValue": "={{ $json.redirect }}",
                            "rightValue": "",
                            "operator": {"type": "string", "operation": "notEmpty", "singleValue": True},
                        }
                    ],
                }
            },
        },
        {
            "id": "resp-redirect",
            "name": "Redirecionar pro grupo",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [660, -100],
            "parameters": {
                "respondWith": "redirect",
                "redirectURL": "={{ $json.redirect }}",
                "options": {},
            },
        },
        {
            "id": "resp-html",
            "name": "Mensagem de espera",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [660, 100],
            "parameters": {
                "respondWith": "text",
                "responseBody": "={{ $json.message }}",
                "options": {
                    "responseCode": 200,
                    "responseHeaders": {
                        "entries": [{"name": "Content-Type", "value": "text/html; charset=utf-8"}]
                    },
                },
            },
        },
    ],
    "connections": {
        "Entrada (link público)": {"main": [[{"node": "Escolher grupo", "type": "main", "index": 0}]]},
        "Escolher grupo": {"main": [[{"node": "Tem link?", "type": "main", "index": 0}]]},
        "Tem link?": {
            "main": [
                [{"node": "Redirecionar pro grupo", "type": "main", "index": 0}],
                [{"node": "Mensagem de espera", "type": "main", "index": 0}],
            ]
        },
    },
}

print(json.dumps(wf, ensure_ascii=False, indent=2))
