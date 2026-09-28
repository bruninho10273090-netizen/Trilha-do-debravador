# Simulação da versão oficial

Gera uma página única com o app (`index.html`) e um servidor de mentira que roda
no próprio navegador (`mock-api.js`), para mostrar a versão oficial sem servidor.

    node deploy/simulador/build.mjs   # gera deploy/simulador/trilha-simulacao.html

- Os dados ficam só no navegador de quem abre (localStorage `trilha-sim.v1`).
- Para trocar de pessoa, saia e entre com outra conta no mesmo navegador.
- Código do Painel da plataforma: `TRILHA-SIMULACAO`.
- Não funcionam: convite por link (`?clube=`), importação do app antigo.
