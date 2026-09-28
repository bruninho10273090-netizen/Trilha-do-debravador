#!/usr/bin/env bash
# Instala o Trilha do Desbravador numa máquina Ubuntu nova (pensado para o Oracle Cloud grátis).
# Pode rodar de novo sem problema: o que já existe é mantido.
#
# Variáveis (opcionais):
#   CODIGO_ADMIN  código secreto para virar administrador da plataforma pelo app (mín. 12 caracteres)
#   DOMINIO       domínio próprio já apontado para esta máquina; vazio = https://SEU-IP.sslip.io
#   BRANCH        branch do GitHub que o servidor acompanha
#   REPO_URL      repositório
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bruninho10273090-netizen/Trilha-do-debravador.git}"
BRANCH="${BRANCH:-claude/artefato-claudecode-jd4z73}"
DIR=/opt/trilha
log() { echo "[trilha $(date +%H:%M:%S)] $*"; }
export DEBIAN_FRONTEND=noninteractive

log "atualizando o sistema e instalando o básico"
apt-get update -y
apt-get install -y git curl ca-certificates openssl cron

# máquinas pequenas (1 GB) precisam de memória extra para montar o app
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ] && [ ! -f /swapfile ]; then
  log "criando 2 GB de memória de troca (swap)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null; then
  log "instalando o Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# as imagens Ubuntu da Oracle bloqueiam tudo menos SSH no firewall interno
log "liberando as portas 80 e 443"
iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

log "baixando o código ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

ENV="$DIR/deploy/.env"
if [ ! -f "$ENV" ]; then
  IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
  HOST="${DOMINIO:-$(echo "$IP" | tr . -).sslip.io}"
  CODE="${CODIGO_ADMIN:-}"
  if [ "${#CODE}" -lt 12 ]; then
    log "AVISO: CODIGO_ADMIN vazio ou curto (mínimo 12). O código de administração ficará desligado."
  fi
  umask 077
  cat > "$ENV" <<CONF
SITE_HOST=$HOST
DB_PASSWORD=$(openssl rand -hex 24)
ADMIN_CLAIM_CODE=$CODE
TRIAL_DAYS=14
BRANCH=$BRANCH
CONF
fi

log "montando e subindo o app (pode levar alguns minutos)"
cd "$DIR/deploy"
docker compose -f docker-compose.prod.yml up -d --build

log "agendando backup diário e atualização automática"
chmod +x "$DIR/deploy/"*.sh
cat > /etc/cron.d/trilha <<CRON
30 3 * * * root $DIR/deploy/backup.sh >> /var/log/trilha-backup.log 2>&1
*/15 * * * * root $DIR/deploy/atualizar.sh >> /var/log/trilha-atualizacao.log 2>&1
CRON
systemctl enable --now cron

log "pronto! endereço: https://$(grep ^SITE_HOST= "$ENV" | cut -d= -f2)"
