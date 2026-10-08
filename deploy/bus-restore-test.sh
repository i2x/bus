#!/bin/bash
# ทดสอบว่า backup ล่าสุดกู้คืนได้จริง: restore ลง DB ชั่วคราว → นับแถวเทียบกับของจริง → ลบทิ้ง
set -euo pipefail
f=$(ls -t /var/backups/bus/bus-*.dump | head -1)
db=bus_restore_test
pg() { runuser -u postgres -- "$@"; }
pg dropdb --if-exists $db 2>/dev/null
pg createdb $db
pg pg_restore --no-owner -d $db < "$f"
q="SELECT (SELECT count(*) FROM users) || ' users, ' || (SELECT count(*) FROM reviews) || ' reviews, ' || (SELECT count(*) FROM points_ledger) || ' ledger rows'"
echo "backup : $f"
echo "restore: $(pg psql -tAd $db -c "$q")"
echo "live   : $(pg psql -tAd bus -c "$q")"
pg dropdb $db
