#!/usr/bin/env bash
# Fork-only (atlitech/t3code). The admission job of fork-server-release.yml:
# installs the candidate Linux archive over data the prior release wrote,
# runs it, and writes ADMISSION.json only when every check passed.
#
#   1. The candidate's sha256 must be the one the build job reported.
#   2. The prior release's archive is downloaded and verified with its SHA256SUMS.
#   3. The prior starts once on an empty T3 home so it migrates, and stops.
#   4. fixtures.json is seeded into that home's database with sqlite3.
#   5. The candidate starts on the same home (running its own migrations).
#   6. probe.ts: GET / is 200 and the environment reports RELEASE_VERSION.
#   7. readback.ts: every fixture thread and message reads back through the
#      snapshot API, with a token from the candidate's own `t3 auth session issue`.
#   8. admission-record.ts writes OUT_DIR/ADMISSION.json, or nothing.
#
# Needs node, sqlite3, curl, tar, sha256sum, and gh (GH_TOKEN, GH_REPO).
set -euo pipefail

: "${CANDIDATE_ARCHIVE:?path to t3-<version>-linux-x64.tar.gz}"
: "${EXPECTED_SHA256:?sha256 the build job reported}"
: "${RELEASE_VERSION:?version the candidate must report}"
: "${PRIOR_VERSION:?the version to upgrade from}"
: "${PRIOR_SOURCE:?admitted or bootstrap}"
: "${VERIFIER_COMMIT:?commit of these scripts}"
: "${WORKDIR:?scratch directory}"
: "${OUT_DIR:?directory for ADMISSION.json}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=server.sh
source "$here/server.sh"
trap 'stop_server || true' EXIT

mkdir -p "$WORKDIR"
work="$(cd "$WORKDIR" && pwd)"
candidate_archive="$(cd "$(dirname "$CANDIDATE_ARCHIVE")" && pwd)/$(basename "$CANDIDATE_ARCHIVE")"
fixtures="$here/fixtures.json"

echo "::group::Verify the candidate archive"
printf '%s  %s\n' "$EXPECTED_SHA256" "$candidate_archive" | sha256sum -c -
echo "::endgroup::"

echo "::group::Download v$PRIOR_VERSION"
prior_archive_name="t3-$PRIOR_VERSION-linux-x64.tar.gz"
mkdir -p "$work/prior-download"
gh release download "v$PRIOR_VERSION" --pattern "$prior_archive_name" --pattern SHA256SUMS \
  --dir "$work/prior-download"
if ! grep -Eq "^[0-9a-f]{64}  $prior_archive_name\$" "$work/prior-download/SHA256SUMS"; then
  echo "::error::v$PRIOR_VERSION's SHA256SUMS does not list $prior_archive_name" >&2
  exit 1
fi
(cd "$work/prior-download" && sha256sum -c --ignore-missing SHA256SUMS)
echo "::endgroup::"

prior_t3="$(extract_archive "$work/prior-download/$prior_archive_name" "$work/prior")"
candidate_t3="$(extract_archive "$candidate_archive" "$work/candidate")"
home="$work/home"
db="$home/userdata/statev2.sqlite"

echo "::group::Migrate and seed with v$PRIOR_VERSION"
start_server "$prior_t3" "$home" "$(free_port)" "$work/prior-serve.log"
stop_server
node "$here/seed.ts" --fixtures "$fixtures" --out "$work/seed.sql"
sqlite3 -bail "$db" <"$work/seed.sql"
echo "::endgroup::"

echo "::group::Upgrade to $RELEASE_VERSION"
# A fresh port, so nothing but the candidate can answer the checks.
port="$(free_port)"
base_url="http://127.0.0.1:$port"
start_server "$candidate_t3" "$home" "$port" "$work/candidate-serve.log"
node "$here/probe.ts" --base-url "$base_url" --release-version "$RELEASE_VERSION" \
  --out "$work/probe.json"
(
  umask 077
  run_t3 "$candidate_t3" "$home" auth session issue --base-dir "$home" \
    --scope orchestration:read --ttl 15m --token-only >"$work/token"
)
node "$here/readback.ts" --base-url "$base_url" --token-file "$work/token" \
  --fixtures "$fixtures" --out "$work/readback.json"
rm -f "$work/token"
stop_server
echo "::endgroup::"

node "$here/admission-record.ts" \
  --archive "$candidate_archive" \
  --expected-sha256 "$EXPECTED_SHA256" \
  --release-version "$RELEASE_VERSION" \
  --prior-version "$PRIOR_VERSION" \
  --prior-source "$PRIOR_SOURCE" \
  --verifier-commit "$VERIFIER_COMMIT" \
  --probe "$work/probe.json" \
  --readback "$work/readback.json" \
  --out "$OUT_DIR"
