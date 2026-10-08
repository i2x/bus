#!/bin/bash
# backup ฐานข้อมูลรายวัน (systemd timer bus-backup.timer) · เก็บ 7 วัน
set -euo pipefail
umask 077
DIR=/var/backups/bus
mkdir -p $DIR && chmod 700 $DIR
f=$DIR/bus-$(date +%F-%H%M).dump
runuser -u postgres -- pg_dump -Fc bus > "$f.tmp" && mv "$f.tmp" "$f"
find $DIR -name 'bus-*.dump' -mtime +7 -delete
echo "backup ok: $f ($(du -h "$f" | cut -f1))"
