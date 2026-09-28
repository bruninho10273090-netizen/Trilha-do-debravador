#!/usr/bin/env bash
# Confere se há versão nova no GitHub; se houver, faz backup, baixa e sobe de novo.
# Roda sozinho a cada 15 minutos. Para forçar: sudo /opt/trilha/deploy/atualizar.sh --forcar
set -euo pipefail
DIR=/opt/trilha
cd "$DIR"
BRANCH="$(grep ^BRANCH= deploy/.env | cut -d= -f2-)"
git fetch -q origin "$BRANCH"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] && [ "${1:-}" != "--forcar" ]; then
  exit 0
fi
echo "[trilha $(date '+%F %H:%M')] versão nova: $(git rev-parse --short "origin/$BRANCH")"
"$DIR/deploy/backup.sh"
git reset -q --hard "origin/$BRANCH"
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
docker image prune -f >/dev/null
echo "[trilha $(date '+%F %H:%M')] atualizado"
