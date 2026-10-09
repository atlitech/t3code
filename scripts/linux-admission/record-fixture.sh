#!/usr/bin/env bash
# Fork-only (atlitech/t3code). Regenerates the committed pre-upgrade.sqlite
# and snapshot-response.json that fixture.test.ts reads, from a released
# Linux x64 archive. Run it on Linux x64 with node, sqlite3, curl, and tar,
# from the repository root, after changing fixtures.json:
#
#   gh release download v0.0.46-atli.3 --repo atlitech/t3code --dir /tmp/rel
#   scripts/linux-admission/record-fixture.sh /tmp/rel/t3-0.0.46-atli.3-linux-x64.tar.gz
#
# The archive starts once on an empty home so it migrates, stops, and gets the
# fixtures seeded with sqlite3; that database is pre-upgrade.sqlite. It then
# starts again on the same home, and what readback.ts reads (the seeded event
# rows, the thread snapshots, and the event replays) is snapshot-response.json.
set -euo pipefail

archive="${1:?usage: record-fixture.sh <t3-VERSION-linux-x64.tar.gz>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=server.sh
source "$here/server.sh"

work="$(mktemp -d)"
trap 'stop_server || true; rm -rf "$work"' EXIT

t3="$(extract_archive "$archive" "$work/release")"
home="$work/home"
db="$home/userdata/statev2.sqlite"

start_server "$t3" "$home" "$(free_port)" "$work/migrate.log"
stop_server

node "$here/seed.ts" --fixtures "$here/fixtures.json" --out "$work/seed.sql"
sqlite3 -bail "$db" <"$work/seed.sql"
# The seeded log as the prior left it, for readback.ts's event-log check.
sqlite3 -json "$db" \
  "SELECT sequence, event_id, stream_id, event_type FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread' ORDER BY sequence" \
  >"$work/seeded-events.json"

# One self-contained file: no -wal or -shm beside it once committed.
cp "$db" "$work/pre-upgrade.sqlite"
for sidecar in -wal -shm; do
  if [[ -f "$db$sidecar" ]]; then cp "$db$sidecar" "$work/pre-upgrade.sqlite$sidecar"; fi
done
sqlite3 -bail "$work/pre-upgrade.sqlite" 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;' >/dev/null
rm -f "$work/pre-upgrade.sqlite-wal" "$work/pre-upgrade.sqlite-shm"

port="$(free_port)"
start_server "$t3" "$home" "$port" "$work/serve.log"
run_t3 "$t3" "$home" auth session issue --base-dir "$home" --scope orchestration:read \
  --token-only >"$work/token"
node "$here/readback.ts" --base-url "http://127.0.0.1:$port" --token-file "$work/token" \
  --fixtures "$here/fixtures.json" --seeded-events "$work/seeded-events.json" \
  --out "$work/readback.json" \
  --responses-out "$work/snapshot-response.json"
stop_server

cp "$work/pre-upgrade.sqlite" "$here/pre-upgrade.sqlite"
cp "$work/snapshot-response.json" "$here/snapshot-response.json"
echo "Recorded from $(run_t3 "$t3" "$home" --version): $here/pre-upgrade.sqlite, $here/snapshot-response.json"
