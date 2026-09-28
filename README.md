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

No modo servidor, tudo o que o app grava (cartão, caderno de especialidades, aprovações, membros, unidades e contas pendentes) vai para a API. A tela muda na hora; se o servidor recusar (por exemplo, com a assinatura vencida), a mudança é desfeita e o motivo aparece. Na aba Gestão → Clube a diretoria encontra o código e o link de convite (com botão para enviar pelo WhatsApp).

O administrador do clube tem ainda, na Gestão:
- **Aparência:** 13 cores com prévia ao vivo no app inteiro, combinações prontas, aviso quando algum texto fica difícil de ler e envio do logo.
- **Assinatura:** plano mensal ou anual, dados de cobrança (CPF/CNPJ), fatura em aberto, histórico e cancelamento da renovação.
- **Passar a administração** para outra pessoa da liderança (aba Clube).

O link de convite (`/?clube=<endereço>&codigo=<código>`) já abre a tela de entrada com o nome, o logo e as cores do clube e deixa o código preenchido.
