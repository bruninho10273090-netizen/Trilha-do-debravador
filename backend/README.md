# API do Trilha do Desbravador

Backend do app como serviço por assinatura: cada pessoa se cadastra, cria seus clubes (e vira a administradora deles), convida membros com suas funções, personaliza cores e logo do clube e paga um plano mensal ou anual.

**Stack:** Node 22, TypeScript, Fastify 5, PostgreSQL 16 (Drizzle ORM), Zod, Vitest.

## Rodando

Com Docker (API + Postgres), na raiz do repositório:

```sh
docker compose up --build
# API em http://localhost:3000/api, app em http://localhost:3000/
```

Sem Docker, com um Postgres já rodando:

```sh
cd backend
cp .env.example .env        # ajuste DATABASE_URL
npm install
npm run db:migrate
npm run dev                 # recarrega ao salvar
```

Testes (usam um banco separado, que é **apagado** a cada execução):

```sh
createdb trilha_test
TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/trilha_test npm test
```

Para dar a uma conta o acesso de administrador da plataforma (cria planos, confirma pagamentos e enxerga todos os clubes):

```sh
npm run make-admin -- nome.de.usuario
```

## Modelo

| Tabela | O que guarda |
|---|---|
| `users` | Cadastro da pessoa: usuário, nome, e-mail, nascimento, telefone, cidade/UF, responsável (nome e telefone) e hash da senha (scrypt). |
| `sessions` | Sessões de login. Só o hash SHA-256 do token fica no banco. |
| `clubs` | Clube, **administrador** (`owner_id`), código de convite, configurações e cores personalizadas (`theme`). |
| `club_logos` | Logo do clube (PNG, JPEG ou WebP), guardado no banco. |
| `plans` | Planos à venda: mensal ou anual, preço e limite de membros. |
| `subscriptions` | Uma assinatura por clube: teste, ativa ou cancelada, período pago e dados de cobrança (CPF/CNPJ). |
| `invoices` | Faturas de cada assinatura. |
| `units` | Unidades de cada clube. |
| `memberships` | Vínculo conta ↔ clube: papel, status, unidade e classe. **Uma conta pode estar em vários clubes com papéis diferentes.** |
| `requirement_progress` | Cada requisito do cartão de classe: resposta escrita, opções escolhidas e status. |
| `specialty_progress` | Cada especialidade do caderno: respostas, requisitos marcados e status. |
| `audit_log` | Quem fez o quê em cada clube (aprovações, mudanças de papel etc.). |

O catálogo de classes, requisitos e especialidades vem do próprio `index.html` do app (`npm run catalog` regenera `src/catalog/catalog.json`). Assim front e back usam o mesmo cartão e a mesma conta de XP.

## Administrador e funções

Cada clube tem **um administrador**: quem criou o clube, até passar a administração para outra pessoa da liderança (`POST /clubs/:clubId/transfer`). O administrador tem todas as permissões no clube, e algumas são só dele: cores, logo, assinatura, transferência e exclusão do clube. Ele não pode sair nem ser removido sem antes transferir a administração.

As **funções** (diretor, associado, conselheiro, instrutor, desbravador) são independentes disso e definem o resto:

| Ação | Admin | Diretor | Associado | Conselheiro | Instrutor | Desbravador |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Ver o clube, unidades e ranking | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ver todos os membros, com contato e responsável | ✓ | ✓ | ✓ | ✓ | ✓ | só nome/unidade |
| Aprovar e devolver requisitos e especialidades | ✓ | ✓ | ✓ | ✓¹ | ✓ | — |
| Escrever no próprio cartão e caderno | | | | | | ✓ |
| Cadastrar, editar, aprovar e remover membros | ✓ | ✓ | ✓² | — | — | — |
| Corrigir cadastro e redefinir senha de membro³ | ✓ | ✓ | ✓² | — | — | — |
| Unidades, código de convite, dados do clube e auditoria | ✓ | ✓ | ✓ | — | — | — |
| Cores e logo do clube | ✓ | — | — | — | — | — |
| Assinatura e pagamento | ✓ | — | — | — | — | — |
| Passar a administração e excluir o clube | ✓ | — | — | — | — | — |

1. Se o clube usa `counselorScope: "unit"`, o conselheiro só age sobre a própria unidade.
2. O associado não mexe em diretores nem promove alguém a diretor. Ninguém além do próprio administrador mexe no vínculo dele.
3. Só de contas que pertencem apenas a este clube; quem está em outros clubes altera os próprios dados.

Outras regras:

- Qualquer pessoa cadastrada pode criar clubes; cada clube tem a sua assinatura.
- Ninguém muda a própria função, exceto o administrador.
- Quem entra pelo código como liderança fica **pendente** até a diretoria aprovar. Desbravadores entram ativos (configurável com `autoApproveDesbravadores`).
- O caderno de especialidades é pessoal: só o próprio desbravador escreve nele. A liderança revisa.
- Aprovar uma especialidade também aprova os requisitos de classe que pedem por ela, igual ao app.
- Quem não é membro ativo recebe 404 em qualquer rota do clube.
- Login, cadastro e troca de senha têm limite de tentativas.

## Assinatura

- Clube novo começa em **teste grátis** (`TRIAL_DAYS`, padrão 14 dias).
- A cobrança é **por clube**: cada clube tem a sua assinatura, paga pelo administrador dele.
- Planos que já vêm cadastrados (migração `0002_planos_iniciais`):

  | Plano | Preço | Equivale a |
  |---|---|---|
  | Mensal | R$ 13,49 por mês | |
  | Anual | R$ 119,99 por ano | R$ 10,00 por mês, cerca de 26% mais barato |

  Nenhum dos dois limita o número de membros. A plataforma pode mudar preços e criar outros planos (`POST /admin/plans`, `PATCH /admin/plans/:planId`); faturas já emitidas não mudam.
- O administrador do clube escolhe o plano e informa nome, CPF/CNPJ e e-mail de cobrança (`POST /clubs/:clubId/subscription`). Isso gera uma fatura.
- Quando a fatura é paga, o período avança um mês ou um ano (somando ao que ainda restava).
- Estados: `trial`, `ativa`, `em_atraso` (até 5 dias depois do vencimento, ainda funciona), `cancelada` (funciona até o fim do período pago) e `expirada`.
- **Com a assinatura vencida o clube fica só para leitura**: tudo continua visível, mas gravações respondem `402 subscription_inactive`. O administrador ainda consegue renovar, transferir e excluir.
- Se o plano tem limite de membros, novas entradas acima do limite respondem 402.

**Meio de pagamento:** ainda não escolhido; por enquanto o provedor é `manual`. A fatura é registrada e a plataforma confirma o pagamento recebido (PIX, transferência) em `POST /admin/invoices/:id/paid`. Para cobrar automaticamente, implemente a interface `BillingProvider` em `src/billing/service.ts` com o gateway escolhido e chame `markInvoicePaid` no webhook dele.

## Cores e logo

O administrador personaliza 13 cores do app (fundo, cartões, texto, texto secundário, bordas, cor principal e o texto sobre ela, barra do topo e o texto dela, destaque…). `GET /theme/keys` lista todas com o nome e o padrão. O que não for personalizado usa o padrão do Trilha.

- `PATCH /clubs/:clubId/theme` com `{ "primary": "#0A3D91", "text": "#1B1B1B" }`; `null` volta a cor ao padrão.
- A resposta traz `warnings` quando algum texto fica com contraste abaixo do recomendado (WCAG) sobre o fundo. O tema é salvo mesmo assim.
- `GET /clubs/:clubId/theme.css` devolve o CSS com as variáveis do app, pronto para incluir na página.
- Logo: `PUT /clubs/:clubId/logo` com o arquivo no corpo e `Content-Type: image/png`, `image/jpeg` ou `image/webp` (até `LOGO_MAX_KB`, padrão 1 MB). O tipo é conferido pelos bytes do arquivo; SVG não é aceito porque pode carregar scripts.
- Cores e logo são públicos (`GET /public/clubs/:slug`), para a tela de entrada de cada clube já aparecer com a cara dele.

## Rotas

Autenticação por cabeçalho `Authorization: Bearer <token>`. Todas as rotas começam com `/api`. Erros vêm como `{ error, message, details? }`.

### Conta

| Método | Rota | |
|---|---|---|
| POST | `/auth/register` | `{ username, name, password, email?, birth?, phone?, city?, state?, guardianName?, guardianPhone? }` → `{ token, user }` |
| POST | `/auth/login` | `{ username, password }` (aceita e-mail no lugar do usuário) |
| POST | `/auth/logout` | encerra a sessão atual |
| GET | `/auth/me` | conta + clubes em que participa, com função, status e se é administrador |
| PATCH | `/auth/me` | `{ name?, email?, birth?, phone?, city?, state?, guardianName?, guardianPhone? }` |
| POST | `/auth/password` | `{ current, password }`; encerra as outras sessões |

### Clubes e unidades

| Método | Rota | |
|---|---|---|
| POST | `/clubs` | cria o clube; quem cria vira administrador e diretor, com período de teste |
| POST | `/clubs/join` | `{ code, role?, unitId? }` entra pelo código de convite |
| GET | `/clubs/:clubId` | clube, administrador, situação da assinatura, cores e logo, unidades e o seu vínculo |
| PATCH | `/clubs/:clubId` | `{ name?, church?, region?, settings? }` |
| DELETE | `/clubs/:clubId` | `{ confirm: "<nome do clube>" }` |
| POST | `/clubs/:clubId/transfer` | `{ memberId }` passa a administração |
| POST | `/clubs/:clubId/join-code` | gera um código novo |
| POST | `/clubs/:clubId/leave` | sai do clube |
| GET/POST | `/clubs/:clubId/units` | lista / cria unidade `{ name, color? }` |
| PATCH/DELETE | `/clubs/:clubId/units/:unitId` | |

### Membros

| Método | Rota | |
|---|---|---|
| GET | `/clubs/:clubId/members` | filtros `?status=&role=&unitId=` |
| POST | `/clubs/:clubId/members` | cadastra conta nova direto no clube |
| GET/PATCH/DELETE | `/clubs/:clubId/members/:memberId` | PATCH: `{ role?, status?, unitId?, classId? }` |
| PATCH | `/clubs/:clubId/members/:memberId/profile` | corrige nome, nascimento, telefone, cidade/UF e responsável |
| POST | `/clubs/:clubId/members/:memberId/approve` | aprova conta pendente |
| POST | `/clubs/:clubId/members/:memberId/password` | `{ password }` |
| GET | `/clubs/:clubId/ranking` | desbravadores por XP e unidades pela média |
| GET | `/clubs/:clubId/audit` | `?limit=&before=` |

### Cartão de classe e caderno

Prefixo `/clubs/:clubId/members/:memberId`. `:key` é a chave do requisito no catálogo (ex.: `amigo_II_1`, `guia_AV_3`).

| Método | Rota | |
|---|---|---|
| GET | `/progress` | requisitos, especialidades e estatísticas (XP, nível) |
| PATCH | `/requirements/:key` | `{ note?, choice?, subs? }` |
| POST | `/requirements/:key/submit` · `/unsubmit` | |
| POST | `/requirements/:key/approve` · `/unapprove` | |
| POST | `/requirements/:key/return` | `{ comment }` |
| POST | `/requirements/approve` | `{ keys: [...] }` aprova em lote |
| PATCH | `/specialties/:espId` | `{ answers?: { r0: "..." }, done?: [0,1], customName?, customArea? }` |
| POST | `/specialties/:espId/submit` · `/unsubmit` · `/approve` · `/unapprove` | |
| POST | `/specialties/:espId/return` | `{ comment }` |
| DELETE | `/specialties/:espId` | tira do caderno (as respostas ficam guardadas) |

Especialidades personalizadas usam o id `custom-<nome>`.

### Cores e logo

| Método | Rota | |
|---|---|---|
| GET | `/theme/keys` | cores personalizáveis e seus padrões |
| PATCH/DELETE | `/clubs/:clubId/theme` | ajusta / volta tudo ao padrão |
| GET | `/clubs/:clubId/theme.css` | CSS do clube (público) |
| PUT/DELETE | `/clubs/:clubId/logo` | envia / remove o logo |
| GET | `/clubs/:clubId/logo` | a imagem (pública, com cache) |
| GET | `/public/clubs/:slug` | nome, cores e logo do clube, sem login |

### Assinatura

| Método | Rota | |
|---|---|---|
| GET | `/plans` | planos à venda |
| GET | `/clubs/:clubId/subscription` | assinatura, plano e faturas (só o administrador) |
| POST | `/clubs/:clubId/subscription` | `{ planId, billingName, billingDocument, billingEmail }` escolhe o plano e gera a fatura |
| POST | `/clubs/:clubId/subscription/cancel` · `/resume` | cancela / retoma a renovação |

### Plataforma

Só para contas com `isPlatformAdmin`.

| Método | Rota | |
|---|---|---|
| GET | `/admin/clubs` | todos os clubes, com administrador, membros e assinatura |
| GET/POST | `/admin/plans` · PATCH `/admin/plans/:planId` | planos |
| GET | `/admin/invoices?status=pendente` | faturas |
| POST | `/admin/invoices/:invoiceId/paid` | `{ reference? }` confirma pagamento |
| PATCH | `/admin/clubs/:clubId/subscription` | ajuste manual (cortesia, prorrogação) |
| GET | `/admin/users?q=` · PATCH `/admin/users/:userId` | contas; `{ disabled?, isPlatformAdmin? }` |

### Outras

| Método | Rota | |
|---|---|---|
| GET | `/clubs/:clubId/approvals` | fila de pendências da liderança `?unitId=` |
| GET | `/catalog` | classes, requisitos e especialidades |
| GET | `/health` | |

## Configuração

Veja `.env.example`. As migrações rodam sozinhas quando o servidor sobe. Para mudar o banco: edite `src/db/schema.ts`, rode `npm run db:generate` e confira o SQL gerado em `drizzle/`.
