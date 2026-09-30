# Bici Busão Sampa

Mapa ao vivo dos ônibus e trilhos da Grande São Paulo que levam bicicleta, em
[busao.bicisampa.info](https://busao.bicisampa.info).

- **Metrô e trens** (linhas 1 a 15 e 17): linhas finas na cor da situação da
  bicicleta agora:
  - 🟢 verde: liberada
  - 🟡 amarelo: a linha opera, mas está fora do horário da bici
  - 🔴 vermelho: a linha está fechada ou paralisada

  O status sai dos horários de operação e das regras de bicicleta de cada operadora,
  combinados com o status operacional ao vivo das linhas. As estações aparecem a
  partir do zoom 12, com o símbolo do Metrô ou da CPTM.
- **Ônibus SPTrans**: posição ao vivo (Olho Vivo), itinerário e pontos de parada das
  linhas com superarticulados de 23 m, os únicos com suporte para bicicleta
  ([Portaria SMT 32/2016](https://legislacao.prefeitura.sp.gov.br/leis/portaria-secretaria-municipal-de-mobilidade-e-transportes-32-de-7-de-maio-de-2016)).
  - Cada ônibus aparece de lado, com setas no corpo apontando o sentido da viagem.
  - A cor do corpo indica o tipo de ônibus: verde para convencional, amarelo para
    elétrico (`"electric": true` em `bike-buses.json`).
  - O contorno indica a bicicleta: preto quando é permitida naquele horário,
    vermelho quando não é.
  - Os itinerários são verdes (ou amarelos, se elétricos) com hachura preta e
    ficam levemente deslocados, para que sentidos e linhas no mesmo corredor
    apareçam lado a lado.
  - Os pontos de parada aparecem a partir do zoom 14.

O controle de camadas, no canto superior direito, liga e desliga separadamente:
trilhos, estações, itinerários, ônibus ao vivo e pontos de ônibus.

Ônibus intermunicipais (antiga EMTU, hoje Artesp) não aparecem porque não aceitam
bicicleta a bordo.

## Regras usadas

| Sistema | Dias úteis | Sábado | Domingo e feriado |
|---|---|---|---|
| Metrô, ViaQuatro, ViaMobilidade, CPTM, TIC Trens, LinhaUni | 10h–16h e 21h até o fechamento | dia todo | dia todo |
| Ônibus SPTrans (superarticulados) | 10h01–15h59 e 19h01–5h59 | a partir das 14h | dia todo |

Os horários de operação de cada linha ficam em
[public/data/rail-lines.json](public/data/rail-lines.json). O Metrô roda 24h de
sábado para domingo nas linhas 1, 2, 3 e 15 até 31/01/2027 (fase experimental). As
linhas 6 e 17 estão em operação reduzida.

Os feriados considerados são os nacionais, o estadual (9/7) e os municipais de São
Paulo (25/1 e Corpus Christi). Carnaval é ponto facultativo e não entra.

## Quais ônibus aparecem

A SPTrans não publica a lista de linhas atendidas por superarticulados. Em 2021 eram
1.308 veículos em 94 linhas. A lista fica em
[public/data/bike-buses.json](public/data/bike-buses.json) e ainda está incompleta.
Para acrescentar:

- **uma linha:** use o código do letreiro, como `6450-10`, em `lines`;
- **um veículo específico:** use o prefixo em `vehicles`.

## Como funciona

```
public/                     site estático (Leaflet)
  data/rail-lines.json      linhas, cores, horários de operação e regras de bicicleta
  data/bike-buses.json      linhas de ônibus com suporte e regras da SPTrans
  data/rail.geojson         trilhos e estações (gerado, OpenStreetMap)
  data/bus-routes.geojson   itinerários (gerado, GTFS SPTrans)
  data/bus-stops.geojson    pontos de parada dessas linhas (gerado, GTFS SPTrans)
functions/api/buses.js      proxy do Olho Vivo: filtra os ônibus com bici (cache de 20 s)
functions/api/rail-status.js  status ao vivo das linhas (feed usado por trilhos.motiva.com.br, cache de 60 s)
scripts/build-data.mjs      gera os .geojson (simplificados a ~2 m)
```

As funções existem porque nem o Olho Vivo nem o feed de status aceitam chamadas
diretas do navegador (não têm CORS), e o token da SPTrans precisa ficar no servidor.

O workflow [refresh-data](.github/workflows/refresh-data.yml) regenera os `.geojson`
toda segunda-feira e sempre que as listas de linhas mudam.

## Desenvolvimento

Precisa de Node 24 e de um token gratuito da API Olho Vivo, criado em
[sptrans.com.br/desenvolvedores](https://www.sptrans.com.br/desenvolvedores/) na
opção "Meus Aplicativos".

```sh
npm install
cp .env.example .env            # e preencha SPTRANS_TOKEN
npm run dev                      # http://localhost:8788
npm test
npm run build:data               # regenera rail.geojson e bus-routes.geojson
```

## Publicação (Cloudflare Pages)

1. **Criar o projeto.** Crie um projeto Pages ligado a este repositório, sem comando
   de build e com diretório de saída `public`. As funções em `functions/` são
   publicadas junto.
2. **Configurar o token.** Nas variáveis do projeto, crie o segredo `SPTRANS_TOKEN`,
   ou rode `npx wrangler pages secret put SPTRANS_TOKEN`.
3. **Ligar o domínio.** Em *Custom domains*, adicione `busao.bicisampa.info`. A zona
   `bicisampa.info` já está no Cloudflare, então o CNAME é criado automaticamente.

Para publicar direto da máquina, sem integração com o Git: `npm run deploy`.

## Fontes

- Regras de bicicleta:
  - [Metrô](https://www.metro.sp.gov.br/sua-viagem/bicicletas/bicicleta-metro/)
  - [CPTM](https://www.cptm.sp.gov.br/cptm/sua-viagem/bicicletas-na-cptm)
  - [ViaQuatro](https://trilhos.motiva.com.br/viaquatro/guia-de-uso/)
  - [ViaMobilidade 5](https://trilhos.motiva.com.br/viamobilidade5/guia-de-uso/)
  - [ViaMobilidade 8 e 9](https://trilhos.motiva.com.br/viamobilidade8e9/guia-de-uso/)
  - [LinhaUni](https://www.linhauni.com.br/guia-do-passageiro)
  - [SPTrans](https://prefeitura.sp.gov.br/web/mobilidade/w/noticias/313171)
- Horários de operação:
  - [Metrô](https://www.metro.sp.gov.br/sua-viagem/horarios/)
  - [operação 24h](https://www.agenciasp.sp.gov.br/metro-de-sao-paulo-estende-operacao-24-horas-nos-fins-de-semana-ate-janeiro-de-2027/)
  - [Linha 17](https://viatrolebus.com.br/2026/09/linha-17-passa-a-operar-ate-as-22h/)
- Dados:
  - [API Olho Vivo](https://www.sptrans.com.br/desenvolvedores/)
  - [GTFS SPTrans (espelho do Mobility Database)](https://files.mobilitydatabase.org/mdb-8/latest.zip)
  - © colaboradores do [OpenStreetMap](https://www.openstreetmap.org/copyright)
  - Ícones do [Metrô](https://commons.wikimedia.org/wiki/File:Metr%C3%B4-SP_icon.svg)
    e da [CPTM](https://commons.wikimedia.org/wiki/File:CPTM_icon.svg), via Wikimedia Commons

## Licença

[GPL-3.0](LICENSE)
