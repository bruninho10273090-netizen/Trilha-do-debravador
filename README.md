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

A pasta [`backend/`](backend/README.md) tem a API do serviço por assinatura: cadastro de pessoas, clubes com administrador e funções, cores e logo por clube, planos mensal e anual (Node + TypeScript + Fastify + PostgreSQL). Para subir tudo:

```sh
docker compose up --build
```

Quando o `index.html` é aberto pelo servidor, ele entra no **modo servidor**: login, cadastro com dados pessoais e a tela "Meus clubes" (criar um clube ou entrar com o código de convite), com os dados vindos da API. Aberto como artefato ou arquivo solto, continua funcionando como antes.

Em construção: no modo servidor, as mudanças no cartão, nas especialidades e na gestão ainda não são salvas (próxima etapa).
