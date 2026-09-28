# API do Trilha do Desbravador

Backend com contas de acesso, permissões por papel e vários clubes na mesma instalação.

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

Para dar a uma conta o acesso de administrador da plataforma (enxerga todos os clubes):

```sh
npm run make-admin -- nome.de.usuario
```

## Modelo

| Tabela | O que guarda |
|---|---|
| `users` | Conta global: usuário, nome, e-mail, nascimento, hash da senha (scrypt). |
| `sessions` | Sessões de login. Só o hash SHA-256 do token fica no banco. |
| `clubs` | Clube, código de convite e configurações. |
| `units` | Unidades de cada clube. |
| `memberships` | Vínculo conta ↔ clube: papel, status, unidade e classe. **Uma conta pode estar em vários clubes com papéis diferentes.** |
| `requirement_progress` | Cada requisito do cartão de classe: resposta escrita, opções escolhidas e status. |
| `specialty_progress` | Cada especialidade do caderno: respostas, requisitos marcados e status. |
| `audit_log` | Quem fez o quê em cada clube (aprovações, mudanças de papel etc.). |

O catálogo de classes, requisitos e especialidades vem do próprio `index.html` do app (`npm run catalog` regenera `src/catalog/catalog.json`). Assim front e back usam o mesmo cartão e a mesma conta de XP.

## Papéis e permissões

| Ação | Diretor | Associado | Conselheiro | Instrutor | Desbravador |
|---|:-:|:-:|:-:|:-:|:-:|
| Ver o clube, unidades e ranking | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ver todos os membros com dados e XP | ✓ | ✓ | ✓ | ✓ | só nome/unidade |
| Aprovar e devolver requisitos e especialidades | ✓ | ✓ | ✓¹ | ✓ | — |
| Escrever no próprio cartão e caderno | | | | | ✓ |
| Escrever no cartão de um desbravador por ele | ✓ | ✓ | ✓¹ | ✓ | — |
| Cadastrar, editar, aprovar e remover membros | ✓ | ✓² | — | — | — |
| Redefinir senha de membro³ | ✓ | ✓² | — | — | — |
| Gerenciar unidades, código de convite e ver auditoria | ✓ | ✓ | — | — | — |
| Editar dados e configurações do clube | ✓ | ✓ | — | — | — |
| Excluir o clube | ✓ | — | — | — | — |

1. Se o clube usa `counselorScope: "unit"`, o conselheiro só age sobre a própria unidade.
2. O associado não mexe em diretores nem promove alguém a diretor.
3. Só de contas que pertencem apenas a este clube; quem está em outros clubes troca a própria senha.

Outras regras:

- O clube sempre mantém pelo menos um diretor ativo.
- Ninguém muda o próprio papel ou status.
- Quem entra pelo código como liderança fica **pendente** até a diretoria aprovar. Desbravadores entram ativos (configurável com `autoApproveDesbravadores`).
- O caderno de especialidades é pessoal: só o próprio desbravador escreve nele. A liderança revisa.
- Aprovar uma especialidade também aprova os requisitos de classe que pedem por ela, igual ao app.
- Quem não é membro ativo recebe 404 em qualquer rota do clube.
- Login, cadastro e troca de senha têm limite de tentativas.

## Rotas

Autenticação por cabeçalho `Authorization: Bearer <token>`. Todas as rotas começam com `/api`. Erros vêm como `{ error, message, details? }`.

### Conta

| Método | Rota | |
|---|---|---|
| POST | `/auth/register` | `{ username, name, password, email?, birth? }` → `{ token, user }` |
| POST | `/auth/login` | `{ username, password }` (aceita e-mail no lugar do usuário) |
| POST | `/auth/logout` | encerra a sessão atual |
| GET | `/auth/me` | conta + clubes em que participa, com papel e status |
| PATCH | `/auth/me` | `{ name?, email?, birth? }` |
| POST | `/auth/password` | `{ current, password }`; encerra as outras sessões |

### Clubes e unidades

| Método | Rota | |
|---|---|---|
| POST | `/clubs` | cria o clube; quem cria vira diretor |
| POST | `/clubs/join` | `{ code, role?, unitId? }` entra pelo código de convite |
| GET | `/clubs/:clubId` | clube, unidades e o seu vínculo (o código só aparece para a diretoria) |
| PATCH | `/clubs/:clubId` | `{ name?, church?, region?, settings? }` |
| DELETE | `/clubs/:clubId` | `{ confirm: "<nome do clube>" }` |
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

### Outras

| Método | Rota | |
|---|---|---|
| GET | `/clubs/:clubId/approvals` | fila de pendências da liderança `?unitId=` |
| GET | `/catalog` | classes, requisitos e especialidades |
| GET | `/health` | |
| GET | `/admin/clubs` · `/admin/users?q=` | só administrador da plataforma |
| PATCH | `/admin/users/:userId` | `{ disabled?, isPlatformAdmin? }` |

## Configuração

Veja `.env.example`. As migrações rodam sozinhas quando o servidor sobe. Para mudar o banco: edite `src/db/schema.ts`, rode `npm run db:generate` e confira o SQL gerado em `drizzle/`.
