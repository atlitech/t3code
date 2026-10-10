#!/usr/bin/env bash
# Fork-only (atlitech/t3code). The verify job of fork-recovery-drill.yml, on a
# fresh runner: re-observes the drilled home the drill job uploaded and
# judges RECOVERY.json by those observations alone (verify-recovery.ts).
#
#   1. The drilled home and its launcher are extracted; the launcher's target
#      runs `t3 --version`.
#   2. The prior's SHA256SUMS and archive are fetched from
#      T3CODE_RELEASE_BASE_URL and verified, and the archive's `t3` extracted.
#   3. The prior starts on a copy of the drilled home: GET
#      /.well-known/t3/environment, and readback.ts reads the fixtures back.
#   4. verify-recovery.ts hashes the live database and the recovery point,
#      looks for the post-upgrade thread in the displaced and the restored
#      database, checks the actions, and writes OUT_DIR/VERIFICATION.json.
#
# The record only says what to fetch and where to look; an observation that
# fails is left out, and its check fails. Exits non-zero unless every check
# passed. Needs node, sqlite3, curl, tar, and sha256sum.
set -euo pipefail

: "${RECORD:?path to RECOVERY.json}"
: "${DRILLED_HOME_ARCHIVE:?path to drilled-home.tar.gz}"
: "${T3CODE_RELEASE_BASE_URL:?the releases/download URL to fetch the prior from}"
: "${WORKDIR:?scratch directory}"
: "${OUT_DIR:?directory for VERIFICATION.json}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
admission="$(cd "$here/../linux-admission" && pwd)"
# shellcheck source=SCRIPTDIR/../linux-admission/server.sh
source "$admission/server.sh"
trap 'stop_server || true' EXIT

mkdir -p "$WORKDIR" "$OUT_DIR"
work="$(cd "$WORKDIR" && pwd -P)"
out="$(cd "$OUT_DIR" && pwd -P)"
base_url="${T3CODE_RELEASE_BASE_URL%/}"
root="$work/drilled"
home="$root/home"
launcher="$root/bin/t3"
copy="$work/copy-home"
if [[ -e "$root" || -e "$copy" ]]; then
  echo "::error::$work already holds a drilled home; use a fresh WORKDIR" >&2
  exit 1
fi

echo "::group::Extract the drilled home"
mkdir -p "$root"
tar -xpzf "$DRILLED_HOME_ARCHIVE" -C "$root"
echo "::endgroup::"

# What to fetch and where the drill's home was; never what to conclude.
prior_version="" prior_archive="" recorded_home=""
if claims="$(node -e 'const record = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
console.log([record.prior.version, record.prior.archive, record.home.path.replace(/\/+$/, "")].join("\t"));' "$RECORD")"; then
  IFS=$'\t' read -r prior_version prior_archive recorded_home <<<"$claims"
fi

# The launcher's target, re-rooted from the drill's home to the extracted one.
launcher_target="$(readlink "$launcher" || true)"
in_home() {
  local path="$1" under="$2"
  if [[ -n "$recorded_home" && "$path" == "$recorded_home"/* ]]; then
    printf '%s%s\n' "$under" "${path#"$recorded_home"}"
  fi
}
launcher_file="$(in_home "$launcher_target" "$home")"
copy_t3="$(in_home "$launcher_target" "$copy")"

# Each observation returns non-zero when it fails; the check it feeds then fails.
observe_launcher() {
  [[ -n "$launcher_file" && -x "$launcher_file" ]] || return 1
  mkdir -p "$work/version-home" || return 1
  run_t3 "$launcher_file" "$work/version-home" --version >"$work/launcher-version.txt" || return 1
}

observe_prior_release() {
  local dir="$work/prior-release"
  [[ -n "$prior_version" && -n "$prior_archive" ]] || return 1
  mkdir -p "$dir" || return 1
  curl -fsSL --retry 3 -o "$dir/SHA256SUMS" "$base_url/v$prior_version/SHA256SUMS" || return 1
  curl -fsSL --retry 3 -o "$dir/$prior_archive" "$base_url/v$prior_version/$prior_archive" \
    || return 1
  grep -Eq "^[0-9a-f]{64} [ *]$prior_archive\$" "$dir/SHA256SUMS" || return 1
  (cd "$dir" && sha256sum -c --ignore-missing SHA256SUMS) || return 1
  extract_archive "$dir/$prior_archive" "$work/prior-extracted" >"$work/prior-release-t3.path" \
    || return 1
}

observe_copy() {
  local port base status=0
  [[ -n "$copy_t3" ]] || return 1
  cp -a "$home" "$copy" || return 1
  [[ -x "$copy_t3" ]] || return 1
  port="$(free_port)" || return 1
  base="http://127.0.0.1:$port"
  start_server "$copy_t3" "$copy" "$port" "$work/copy-serve.log" || return 1
  curl -fsS --max-time 10 "$base/.well-known/t3/environment" >"$work/environment.json" \
    || status=1
  if (
    umask 077
    run_t3 "$copy_t3" "$copy" auth session issue --base-dir "$copy" \
      --scope orchestration:read --ttl 15m --token-only >"$work/token"
  ); then
    dump_thread_events "$copy/userdata/statev2.sqlite" "$work/copy-events.json" || status=1
    node "$admission/readback.ts" --stage seeded --base-url "$base" --token-file "$work/token" \
      --fixtures "$admission/fixtures.json" --seeded-events "$work/copy-events.json" \
      --out "$work/readback.json" || status=1
  else
    status=1
  fi
  rm -f "$work/token"
  stop_server || status=1
  return "$status"
}

for observation in observe_launcher observe_prior_release observe_copy; do
  echo "::group::$observation"
  "$observation" || echo "::warning::$observation did not complete; its checks fail"
  echo "::endgroup::"
done

prior_release_t3="$work/prior-release/no-t3"
if [[ -s "$work/prior-release-t3.path" ]]; then
  prior_release_t3="$(cat "$work/prior-release-t3.path")"
fi

node "$here/verify-recovery.ts" \
  --record "$RECORD" \
  --home "$home" \
  --launcher "$launcher" \
  --launcher-version "$work/launcher-version.txt" \
  --prior-sums "$work/prior-release/SHA256SUMS" \
  --prior-release-t3 "$prior_release_t3" \
  --readback "$work/readback.json" \
  --environment "$work/environment.json" \
  --out "$out"
