#!/usr/bin/env bash
# Cópia do banco em /opt/trilha-backups (guarda os últimos 14 dias).
# Restaurar:  gunzip -c ARQUIVO.sql.gz | docker compose -f /opt/trilha/deploy/docker-compose.prod.yml exec -T db psql -U trilha trilha
set -euo pipefail
DEST=/opt/trilha-backups
mkdir -p "$DEST" && chmod 700 "$DEST"
cd /opt/trilha/deploy
F="$DEST/trilha-$(date +%F-%H%M).sql.gz"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U trilha --clean --if-exists trilha | gzip > "$F"
find "$DEST" -name 'trilha-*.sql.gz' -mtime +14 -delete
echo "[trilha $(date '+%F %H:%M')] backup: $F ($(du -h "$F" | cut -f1))"
