# Testar o app completo no seu computador (Windows)

Roda o sistema inteiro na sua máquina, igual ao servidor: login, Meus clubes, convite, cores e logo, assinatura e o Painel da plataforma. Os dados ficam só no seu computador.

## Uma vez só

1. **Instale o Docker Desktop**: baixe em docker.com/products/docker-desktop e instale com as opções padrão. Se pedir para instalar ou atualizar o **WSL**, aceite e reinicie o computador.
2. Abra o **Docker Desktop** e espere aparecer "Engine running" (canto inferior esquerdo).
3. **Baixe o projeto**: no GitHub, abra o repositório, troque a branch para `claude/artefato-claudecode-jd4z73`, clique em **Code → Download ZIP** e extraia a pasta.

## Para ligar

1. Abra a pasta extraída (a que tem o arquivo `docker-compose.yml`).
2. Clique na barra de endereço do Explorador de Arquivos, digite `cmd` e tecle Enter. Abre uma janela preta já na pasta certa.
3. Digite (troque o código por um seu, com 12 caracteres ou mais) e tecle Enter:

   ```
   set ADMIN_CLAIM_CODE=meu-codigo-local-2026&& docker compose up --build
   ```

   Na primeira vez demora alguns minutos. Está pronto quando aparecer `Server listening at http://0.0.0.0:3000`.
4. Abra no navegador: **http://localhost:3000**

Para virar administrador da plataforma: crie uma conta, e em **Meus clubes** abra "Tenho um código de administração da plataforma" e digite o mesmo código.

Para testar no celular (na mesma rede Wi-Fi): descubra o IP do computador (`ipconfig` na janela preta, linha "Endereço IPv4") e abra `http://ESSE-IP:3000` no celular. Se o Windows perguntar sobre o firewall, permita.

## Para desligar

Na janela preta, aperte **Ctrl + C**. Para ligar de novo, repita o passo 3 (as próximas vezes são rápidas). Os dados continuam salvos.

Para apagar tudo e começar do zero: `docker compose down -v`.
