import requests
import json

API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyNzVhYTFkMC0yNGUyLTRiODktYmZjYS0xZGYyNmYzNWU1OTEiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTQxYjU3NWMtMWNjNi00YjBiLWFiNDEtNzY3ZmU0MmI3YWVmIiwiaWF0IjoxNzkwMjc3NzQ1fQ.RHvWKe0MAWMjs5FamYUO0PkXFGpmaJ5E6NKtcEPWsRA"
WORKFLOW_ID = "9pR7FUyzPt4cUULf"
URL = f"https://nextags.app.br/api/v1/workflows/{WORKFLOW_ID}"

headers = {
    "X-N8N-API-KEY": API_KEY,
    "Content-Type": "application/json"
}

response_get = requests.get(URL, headers=headers)
workflow_data = response_get.json()

# Remove read-only fields before PUT
read_only_fields = ["id", "createdAt", "updatedAt", "versionId", "versionCounter", "triggerCount", "sourceWorkflowId"]
for field in read_only_fields:
    if field in workflow_data:
        del workflow_data[field]

workflow_data["active"] = True

response_put = requests.put(URL, headers=headers, data=json.dumps(workflow_data))
print(response_put.text)
