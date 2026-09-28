# Trilha do Desbravador

App de acompanhamento das classes do Clube de Desbravadores (Amigo, Companheiro, Pesquisador, Pioneiro, Excursionista e Guia), com requisitos regulares e avançados, caderno de especialidades, aprovações, XP, níveis e ranking.

Origem: artefato do Claude — https://claude.ai/artifact/Hc4M7pfT1j6vTAqEkZ7aAy

## Como usar

É um único arquivo HTML sem build. Abra `index.html` no navegador ou sirva a pasta:

```sh
python3 -m http.server 8000
```

Dentro do Claude, o app salva os dados no banco compartilhado do artefato (`window.claude.use('db')`). Fora dele, usa o `localStorage` do navegador.

## Backend

A pasta [`backend/`](backend/README.md) tem a API com contas de acesso, permissões por papel e vários clubes (Node + TypeScript + Fastify + PostgreSQL). Para subir tudo:

```sh
docker compose up --build
```

O app ainda não usa essa API; ligar o front a ela é o próximo passo.
