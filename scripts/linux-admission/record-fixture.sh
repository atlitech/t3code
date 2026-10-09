#!/usr/bin/env bash
# Fork-only (atlitech/t3code). Regenerates the committed pre-upgrade.sqlite
# and snapshot-response.json that fixture.test.ts reads, from a released
# Linux x64 archive. Run it on Linux x64 with node, sqlite3, curl, and tar,
# from the repository root, after changing fixtures.json:
#
#   gh release download v0.0.46-atli.3 --repo atlitech/t3code --dir /tmp/rel
#   scripts/linux-admission/record-fixture.sh /tmp/rel/t3-0.0.46-atli.3-linux-x64.tar.gz
#
# The archive writes the fixture history as the prior does in an admission
# (server.sh write_prior_history); that database is pre-upgrade.sqlite. It
# then starts again on the same home as the candidate would, and what
# readback.ts reads at the `upgraded` stage (the logged event rows, the thread
# snapshots, and the resumes) is snapshot-response.json.
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

write_prior_history "$t3" "$home" "$work" "$here/fixtures.json"

# One self-contained file: no -wal or -shm beside it once committed, and no
# scratch credentials.
cp "$db" "$work/pre-upgrade.sqlite"
for sidecar in -wal -shm; do
  if [[ -f "$db$sidecar" ]]; then cp "$db$sidecar" "$work/pre-upgrade.sqlite$sidecar"; fi
done
sqlite3 -bail "$work/pre-upgrade.sqlite" \
  'PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM auth_sessions; DELETE FROM auth_pairing_links; PRAGMA journal_mode=DELETE; VACUUM;' \
  >/dev/null
rm -f "$work/pre-upgrade.sqlite-wal" "$work/pre-upgrade.sqlite-shm"

port="$(free_port)"
start_server "$t3" "$home" "$port" "$work/serve.log"
run_t3 "$t3" "$home" auth session issue --base-dir "$home" --scope orchestration:read \
  --token-only >"$work/token"
node "$here/readback.ts" --stage upgraded --base-url "http://127.0.0.1:$port" \
  --token-file "$work/token" \
  --fixtures "$here/fixtures.json" --seeded-events "$work/seeded-events.json" \
  --out "$work/readback.json" \
  --responses-out "$work/snapshot-response.json"
stop_server

cp "$work/pre-upgrade.sqlite" "$here/pre-upgrade.sqlite"
cp "$work/snapshot-response.json" "$here/snapshot-response.json"
echo "Recorded from $(run_t3 "$t3" "$home" --version): $here/pre-upgrade.sqlite, $here/snapshot-response.json"
