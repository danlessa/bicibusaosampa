# Relay do Olho Vivo

A SPTrans bloqueia requisições vindas dos Cloudflare Workers (erro 1106), então a
função `/api/buses` busca as posições dos ônibus por este serviço no Cloud Run
(projeto GCP `bicisampa`, região `southamerica-east1`).

- `GET /posicao` com o cabeçalho `X-Relay-Key`: o JSON de `/Posicao` do Olho Vivo,
  com cache de 15 s.
- `GET /health`: `ok` (o Cloud Run reserva `/healthz`).

Segredos (Secret Manager): `sptrans-token` (token do Olho Vivo) e `relay-key` (chave
compartilhada com o Cloudflare, onde fica como `OLHOVIVO_RELAY_KEY`, junto com
`OLHOVIVO_RELAY_URL`).

Publicar:

```sh
gcloud run deploy olhovivo-relay --source relay --project bicisampa --region southamerica-east1 \
  --allow-unauthenticated --set-secrets SPTRANS_TOKEN=sptrans-token:latest,RELAY_KEY=relay-key:latest
```

Rodar local: `SPTRANS_TOKEN=... RELAY_KEY=teste node relay/server.mjs`.
