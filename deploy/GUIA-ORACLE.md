# Colocar o Trilha no ar no Oracle Cloud (grátis)

Você não precisa digitar comandos. Tudo é feito pelo site da Oracle; a máquina se instala sozinha.

No fim você terá:

- o app no endereço `https://SEU-IP.sslip.io` (grátis, com cadeado HTTPS);
- banco de dados na própria máquina, com **backup todo dia**;
- **atualização automática**: quando o código mudar no GitHub, o servidor se atualiza em até 15 minutos.

Tempo: uns 30 minutos, mais 10 a 15 de instalação automática.

> Os nomes dos botões da Oracle mudam de vez em quando e podem aparecer em inglês. Se algo estiver diferente, procure pelo nome parecido.

---

## 1. Criar a conta

1. Entre em **cloud.oracle.com** e clique em **Sign Up / Comece gratuitamente**.
2. Em **Home Region**, escolha **Brazil East (Sao Paulo)**. Essa escolha não muda depois, e os recursos grátis só existem nela.
3. A Oracle pede um cartão de crédito só para confirmar a identidade. Nos recursos "Always Free" nada é cobrado.

## 2. Preparar o texto de instalação

Abra o arquivo [`oracle-cloud-init.txt`](oracle-cloud-init.txt) e copie tudo. Antes de colar na Oracle, troque esta linha:

```
export CODIGO_ADMIN="troque-por-um-codigo-so-seu"
```

por um código secreto seu, **com pelo menos 12 caracteres e sem espaços** (ex.: `trilha-2026-bruno-7x9k`). Guarde esse código: é com ele que você vira o administrador da plataforma dentro do app.

## 3. Criar a máquina

No menu da Oracle: **Compute → Instances → Create instance**.

| Campo | O que escolher |
|---|---|
| **Name** | `trilha` |
| **Image** | Clique em *Change image* → **Canonical Ubuntu** (24.04 ou 22.04) |
| **Shape** | Clique em *Change shape* → **Ampere** → **VM.Standard.A1.Flex**, com **1 OCPU e 6 GB** de memória (aparece como *Always Free-eligible*) |
| **Networking** | Deixe criar a rede nova e marque **Assign a public IPv4 address** |
| **Add SSH keys** | **Generate a key pair for me** e baixe as duas chaves. Guarde; só servem para emergência |
| **Advanced options → Management** | Marque **Paste cloud-init script** e cole o texto do passo 2 |

Clique em **Create**.

> Se aparecer **"Out of capacity"** no Ampere, tente de novo mais tarde (costuma liberar em algumas horas) ou use o shape **VM.Standard.E2.1.Micro** (AMD, também grátis). O instalador se ajusta à máquina menor.

## 4. Liberar o acesso pela internet

A Oracle bloqueia o site até você liberar as portas:

1. Na página da máquina, em **Primary VNIC**, clique no nome da **Subnet**.
2. Clique em **Security Lists → Default Security List**.
3. **Add Ingress Rules**:
   - **Source CIDR**: `0.0.0.0/0`
   - **IP Protocol**: `TCP`
   - **Destination Port Range**: `80,443`
4. Salve.

## 5. Abrir o app

Na página da máquina, copie o **Public IP address**, por exemplo `129.146.10.20`. O endereço do app é o IP com **traços** no lugar dos pontos, seguido de `.sslip.io`:

```
https://129-146-10-20.sslip.io
```

A instalação leva de 10 a 15 minutos depois que a máquina aparece como *Running*. Se o site ainda não abrir, espere mais um pouco.

## 6. Virar administrador da plataforma

1. No app, clique em **Criar conta** e cadastre-se.
2. Na tela **Meus clubes**, abra **"Tenho um código de administração da plataforma"** e digite o código do passo 2.
3. Aparece o botão **Painel da plataforma**. Pronto: você confirma pagamentos, dá cortesias e ajusta preços por ali.

Agora é só criar o seu clube ou passar o link para outros clubes se cadastrarem.

---

## Perguntas comuns

**O site não abre.**
Confira o passo 4 (portas 80 e 443). Se a máquina foi criada há menos de 15 minutos, espere. Confira também se o endereço tem traços no lugar dos pontos.

**Como o app se atualiza?**
Sozinho. A cada 15 minutos o servidor olha o GitHub; se houver versão nova, faz um backup e se atualiza. Leva uns 2 minutos, e o app pode ficar fora do ar nesse intervalo.

**E o backup?**
Todo dia às 3h30 (horário do servidor) é feita uma cópia do banco, guardada por 14 dias na própria máquina. Recomendo, mais adiante, mandar essas cópias também para fora da máquina (Google Drive ou armazenamento da Oracle); é só me pedir.

**Quero um domínio próprio (ex.: trilhadodesbravador.com.br).**
Compre no registro.br (cerca de R$ 40 por ano), crie um registro **A** apontando para o IP da máquina e me chame para trocar o endereço no servidor.

**A Oracle pode desligar a máquina?**
A Oracle pode recolher máquinas grátis que ficam praticamente paradas por muitos dias. Com clubes usando, isso não deve acontecer. Para eliminar o risco, dá para mudar a conta para **Pay As You Go**: os recursos grátis continuam grátis, e a máquina deixa de ser recolhida. Confira as regras atuais no site da Oracle.

---

## Para quem entende de servidor

- Tudo fica em `/opt/trilha`; as senhas geradas ficam em `/opt/trilha/deploy/.env` (só o root lê).
- Log da instalação: `/var/log/trilha-instalacao.log`; atualizações: `/var/log/trilha-atualizacao.log`; backups: `/var/log/trilha-backup.log`.
- Forçar atualização: `sudo /opt/trilha/deploy/atualizar.sh --forcar`.
- Ver os serviços: `cd /opt/trilha/deploy && sudo docker compose -f docker-compose.prod.yml ps`.
- Restaurar um backup: `gunzip -c /opt/trilha-backups/ARQUIVO.sql.gz | sudo docker compose -f /opt/trilha/deploy/docker-compose.prod.yml exec -T db psql -U trilha trilha`.
- Trocar o endereço: edite `SITE_HOST` no `.env` e rode `sudo docker compose -f docker-compose.prod.yml up -d` na pasta `deploy`.
