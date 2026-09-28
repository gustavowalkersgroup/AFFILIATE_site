import requests
import json

API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyNzVhYTFkMC0yNGUyLTRiODktYmZjYS0xZGYyNmYzNWU1OTEiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTQxYjU3NWMtMWNjNi00YjBiLWFiNDEtNzY3ZmU0MmI3YWVmIiwiaWF0IjoxNzkwMjc3NzQ1fQ.RHvWKe0MAWMjs5FamYUO0PkXFGpmaJ5E6NKtcEPWsRA"
URL = "https://nextags.app.br/api/v1/workflows/9pR7FUyzPt4cUULf"

workflow_data = {
    "name": "Cashback — AME PET",
    "nodes": [
        {
            "parameters": {
                "httpMethod": "POST",
                "path": "cashback/ame-pet",
                "responseMode": "onReceived",
                "options": {}
            },
            "id": "webhook-cashback",
            "name": "Webhook Receptivo",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [250, 300]
        },
        {
            "parameters": {
                "dataType": "string",
                "value1": "={{ $json.body.status }}",
                "rules": {
                    "rules": [
                        { "value2": "criado", "output": 0 },
                        { "value2": "expira_5_dias", "output": 1 },
                        { "value2": "ultimo_dia", "output": 2 }
                    ]
                }
            },
            "id": "switch-status",
            "name": "Roteador de Status",
            "type": "n8n-nodes-base.switch",
            "typeVersion": 1,
            "position": [450, 300]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://app.nextagsai.com.br/api/contacts",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "accept", "value": "application/json"},
                        {"name": "Content-Type", "value": "application/json"}
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={\n  \"phone\": \"{{ $json.body.phone }}\",\n  \"first_name\": \"{{ $json.body.nome }}\",\n  \"actions\": [\n    {\n      \"action\": \"send_flow\",\n      \"flow_id\": 1790277999841\n    }\n  ]\n}",
                "options": {}
            },
            "id": "out-parte-1",
            "name": "NextagsAI - Parte 1",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [700, 100]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://app.nextagsai.com.br/api/contacts",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "accept", "value": "application/json"},
                        {"name": "Content-Type", "value": "application/json"}
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={\n  \"phone\": \"{{ $json.body.phone }}\",\n  \"first_name\": \"{{ $json.body.nome }}\",\n  \"actions\": [\n    {\n      \"action\": \"send_flow\",\n      \"flow_id\": 1790278029586\n    }\n  ]\n}",
                "options": {}
            },
            "id": "out-parte-2",
            "name": "NextagsAI - Parte 2",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [700, 300]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://app.nextagsai.com.br/api/contacts",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "accept", "value": "application/json"},
                        {"name": "Content-Type", "value": "application/json"}
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={\n  \"phone\": \"{{ $json.body.phone }}\",\n  \"first_name\": \"{{ $json.body.nome }}\",\n  \"actions\": [\n    {\n      \"action\": \"send_flow\",\n      \"flow_id\": 1790278043640\n    }\n  ]\n}",
                "options": {}
            },
            "id": "out-parte-3",
            "name": "NextagsAI - Parte 3",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [700, 500]
        }
    ],
    "connections": {
        "Webhook Receptivo": {
            "main": [
                [
                    {
                        "node": "Roteador de Status",
                        "type": "main",
                        "index": 0
                    }
                ]
            ]
        },
        "Roteador de Status": {
            "main": [
                [ { "node": "NextagsAI - Parte 1", "type": "main", "index": 0 } ],
                [ { "node": "NextagsAI - Parte 2", "type": "main", "index": 0 } ],
                [ { "node": "NextagsAI - Parte 3", "type": "main", "index": 0 } ]
            ]
        }
    },
    "settings": {
        "executionOrder": "v1"
    }
}

headers = {
    "X-N8N-API-KEY": API_KEY,
    "Content-Type": "application/json"
}

response = requests.put(URL, headers=headers, data=json.dumps(workflow_data))
print(response.text)
