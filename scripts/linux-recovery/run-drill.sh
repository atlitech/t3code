#!/usr/bin/env bash
# Fork-only (atlitech/t3code). The drill job of fork-recovery-drill.yml: on a
# scratch T3 home, upgrades between two admitted fork releases, declares the
# upgrade failed after it wrote new work, recovers with `t3 recover`, and
# writes RECOVERY.json (record.ts) and the drilled home as it stood right
# after the recovery (drilled-home.tar.gz, which keeps the launcher symlink).
#
#   1. The target's ADMISSION.json names the prior. Both archives are
#      downloaded and verified with their SHA256SUMS, and the prior's
#      `t3 recover --help` must work, before anything installs.
#   2. install-prior: install.sh puts the prior in the scratch home.
#   3. seed-prior: the prior writes and reads back the fixture history
#      (linux-admission/server.sh write_prior_history).
#   4. update: `t3 update <target> --yes` keeps a recovery point.
#   5. post-upgrade-work: the target writes one thread (post-upgrade-thread.ts).
#   6. declare-failure: the upgrade is declared failed.
#   7. recover: `t3 recover <point>`; the database is hashed and the home is
#      archived before anything opens it again.
#   8. start-prior: the prior serves the restored home and reads the
#      fixtures and the environment id back.
#
# install.sh, `t3 update`, and `t3 recover` run with their own environment:
# a scratch HOME and T3CODE_HOME, T3CODE_RELEASE_BASE_URL, and a PATH of the
# system tool directories (tar, curl, sha256sum). Serving keeps server.sh's
# empty environment. Each step is an operator action whose command, UTC start
# and end, and exit code RECOVERY.json records.
#
# Refuses the default T3 home, a home a service or a live server serves, and
# a home that is not empty. Needs node, sqlite3, curl, tar, and sha256sum.
set -euo pipefail

: "${TARGET_VERSION:?the admitted fork version to upgrade to}"
: "${T3CODE_RELEASE_BASE_URL:?the releases/download URL to fetch releases from}"
: "${DRILL_COMMIT:?commit of these scripts}"
: "${WORKDIR:?scratch directory}"
: "${OUT_DIR:?directory for RECOVERY.json and drilled-home.tar.gz}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
admission="$(cd "$here/../linux-admission" && pwd)"
installer="$(cd "$here/.." && pwd)/install.sh"
# shellcheck source=SCRIPTDIR/../linux-admission/server.sh
source "$admission/server.sh"
trap 'stop_server || true' EXIT

fail() {
  echo "::error::$*" >&2
  exit 1
}

mkdir -p "$WORKDIR" "$OUT_DIR"
work="$(cd "$WORKDIR" && pwd -P)"
out="$(cd "$OUT_DIR" && pwd -P)"
base_url="${T3CODE_RELEASE_BASE_URL%/}"
fixtures="$admission/fixtures.json"
drill_root="$work/drill"
home="$drill_root/home"
bin_dir="$drill_root/bin"
launcher="$bin_dir/t3"
db="$home/userdata/statev2.sqlite"
actions_file="$work/actions.ndjson"
post_upgrade_thread="recovery-drill-post-upgrade"

fork_version='^[0-9]+\.[0-9]+\.[0-9]+-atli\.[0-9]+$'
[[ "$TARGET_VERSION" =~ $fork_version ]] || fail "'$TARGET_VERSION' is not a fork version"

# resolve_path <path>: the path with every symlink resolved, also for a path
# that does not exist yet.
resolve_path() {
  local path="$1" parent
  if [[ -d "$path" ]]; then
    (cd -P "$path" && pwd -P)
    return
  fi
  parent="$(dirname "$path")"
  if [[ -d "$parent" ]]; then
    printf '%s/%s\n' "$(cd -P "$parent" && pwd -P)" "$(basename "$path")"
  else
    printf '%s\n' "$path"
  fi
}

# The drill only ever runs on a scratch home nothing else uses.
check_scratch_home() {
  local resolved state pid unit
  mkdir -p "$drill_root"
  resolved="$(resolve_path "$home")"
  if [[ "$resolved" == "$(resolve_path "${HOME:?}/.t3")" ]]; then
    fail "refusing to drill the default T3 home $resolved; the drill needs a scratch home"
  fi
  if [[ -n "${T3CODE_HOME:-}" && "$resolved" == "$(resolve_path "$T3CODE_HOME")" ]]; then
    fail "refusing to drill $resolved, this user's T3CODE_HOME"
  fi
  unit="$HOME/.config/systemd/user/t3code.service"
  if [[ -f "$unit" ]] && { grep -qF -- "$home" "$unit" || grep -qF -- "$resolved" "$unit"; }; then
    fail "refusing to drill $resolved: the t3code service ($unit) serves it"
  fi
  state="$home/userdata/server-runtime.json"
  if [[ -f "$state" ]]; then
    pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$state" | head -n 1)"
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      fail "refusing to drill $resolved: a live server (pid $pid) serves it"
    fi
  fi
  if [[ -e "$home" && -n "$(ls -A "$home" 2>/dev/null)" ]]; then
    fail "refusing to drill $resolved: it is not empty; the drill needs a fresh scratch home"
  fi
}
check_scratch_home

case "$(uname -s)" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) fail "unsupported operating system $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

# The environment install.sh, `t3 update`, and `t3 recover` run with.
tool_path="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for tool in tar curl sha256sum; do
  env -i PATH="$tool_path" sh -c "command -v $tool" >/dev/null || fail "$tool is not on $tool_path"
done
user_home="$drill_root/user"
mkdir -p "$user_home" "$drill_root/tmp" "$work/actions"
TOOL_ENV=(env -i HOME="$user_home" USERPROFILE="$user_home" T3CODE_HOME="$home"
  TMPDIR="$drill_root/tmp" PATH="$tool_path" T3CODE_RELEASE_BASE_URL="$base_url" NO_COLOR=1)

# fetch_release <version> <dir>: downloads the release's archive for this
# machine and its SHA256SUMS, verifies one by the other, and prints the
# archive's path.
fetch_release() {
  local version="$1" dir="$2" name
  name="t3-$version-$platform-$arch.tar.gz"
  # Called in $(...), which does not inherit `set -e`: every step returns.
  mkdir -p "$dir" || return 1
  curl -fsSL --retry 3 -o "$dir/SHA256SUMS" "$base_url/v$version/SHA256SUMS" || return 1
  curl -fsSL --retry 3 -o "$dir/$name" "$base_url/v$version/$name" || return 1
  if ! grep -Eq "^[0-9a-f]{64} [ *]$name\$" "$dir/SHA256SUMS"; then
    fail "v$version's SHA256SUMS does not list $name"
  fi
  (cd "$dir" && sha256sum -c --ignore-missing SHA256SUMS >&2) || fail "$name does not match SHA256SUMS"
  printf '%s\n' "$dir/$name"
}

# launcher_version: the version the launcher's `t3 --version` reports.
launcher_version() {
  local printed
  printed="$(run_t3 "$launcher" "$home" --version)" || return 1
  printed="${printed##* }"
  printf '%s\n' "${printed#v}"
}

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# action <name> <command...>: one operator action. Runs the command in a
# subshell under `set -e` that stops any server it started, shows and keeps
# its output in $work/actions/<name>.log, and appends its command, UTC start
# and end, and exit code to $actions_file. Fails the drill on a non-zero exit.
action() {
  local name="$1" log started ended status command
  shift
  log="$work/actions/$name.log"
  command="$(printf '%q ' "$@")"
  echo "::group::$name"
  started="$(utc_now)"
  set +e
  (
    set -euo pipefail
    trap 'stop_server || true' EXIT
    "$@"
  ) >"$log" 2>&1
  status=$?
  set -e
  ended="$(utc_now)"
  cat "$log"
  echo "::endgroup::"
  node -e 'const [name, command, startedAt, endedAt, exitCode] = process.argv.slice(1);
process.stdout.write(`${JSON.stringify({ name, command, startedAt, endedAt, exitCode: Number(exitCode) })}\n`);' \
    "$name" "${command% }" "$started" "$ended" "$status" >>"$actions_file"
  if [[ "$status" -ne 0 ]]; then
    fail "$name exited $status"
  fi
}

write_post_upgrade_work() {
  local port count
  port="$(free_port)"
  start_server "$launcher" "$home" "$port" "$work/target-serve.log"
  (
    umask 077
    run_t3 "$launcher" "$home" auth session issue --base-dir "$home" --ttl 15m --token-only \
      >"$work/target-token"
  )
  node "$here/post-upgrade-thread.ts" --base-url "http://127.0.0.1:$port" \
    --token-file "$work/target-token" --fixtures "$fixtures"
  rm -f "$work/target-token"
  stop_server
  count="$(sqlite3 -readonly "$db" \
    "SELECT count(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND event_type = 'thread.created' AND stream_id = '$post_upgrade_thread'")"
  if [[ "$count" != "1" ]]; then
    echo "::error::the upgraded database holds $count $post_upgrade_thread threads, not 1" >&2
    return 1
  fi
  echo "v$TARGET_VERSION wrote $post_upgrade_thread."
}

declare_failure() {
  printf 'v%s declared failed at %s after it wrote %s; recovering to recovery point %s.\n' \
    "$1" "$(utc_now)" "$post_upgrade_thread" "$2" | tee "$work/declared-failure.txt"
}

serve_restored() {
  local port base
  port="$(free_port)"
  base="http://127.0.0.1:$port"
  start_server "$launcher" "$home" "$port" "$work/restored-serve.log"
  curl -fsS --max-time 10 "$base/.well-known/t3/environment" >"$work/restored-environment.json"
  (
    umask 077
    run_t3 "$launcher" "$home" auth session issue --base-dir "$home" \
      --scope orchestration:read --ttl 15m --token-only >"$work/restored-token"
  )
  dump_thread_events "$db" "$work/restored-events.json"
  node "$admission/readback.ts" --stage seeded --base-url "$base" \
    --token-file "$work/restored-token" --fixtures "$fixtures" \
    --seeded-events "$work/restored-events.json" --out "$work/restored-readback.json"
  rm -f "$work/restored-token"
  stop_server
}

echo "::group::Choose the prior and check its t3 recover"
curl -fsSL --retry 3 -o "$work/target-admission.json" "$base_url/v$TARGET_VERSION/ADMISSION.json"
prior_version="$(node -e 'const record = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (record.version !== process.argv[2]) throw new Error(`ADMISSION.json is for ${record.version}`);
console.log(record.priorVersion);' "$work/target-admission.json" "$TARGET_VERSION")"
[[ "$prior_version" =~ $fork_version ]] \
  || fail "v$TARGET_VERSION's ADMISSION.json names the prior '$prior_version', not a fork version"
[[ "$prior_version" != "$TARGET_VERSION" ]] || fail "v$TARGET_VERSION's prior is itself"
prior_archive="$(fetch_release "$prior_version" "$work/download/prior")"
target_archive="$(fetch_release "$TARGET_VERSION" "$work/download/target")"
prior_check_t3="$(extract_archive "$prior_archive" "$work/prior-check")"
mkdir -p "$work/prior-check-home"
if ! env -i HOME="$work/prior-check-home" T3CODE_HOME="$work/prior-check-home" \
  TMPDIR="$work/prior-check-home" PATH="$tool_path" "$prior_check_t3" recover --help \
  >"$work/prior-recover-help.log" 2>&1; then
  cat "$work/prior-recover-help.log" >&2
  fail "v$prior_version's \`t3 recover --help\` failed, so it cannot be recovered to; nothing was installed"
fi
echo "Upgrading v$prior_version to v$TARGET_VERSION."
echo "::endgroup::"

: >"$actions_file"
action install-prior "${TOOL_ENV[@]}" T3CODE_VERSION="$prior_version" \
  T3CODE_INSTALL_BIN_DIR="$bin_dir" sh "$installer"
[[ "$(launcher_version)" == "$prior_version" ]] || fail "the launcher does not run v$prior_version"

action seed-prior write_prior_history "$launcher" "$home" "$work" "$fixtures"
pre_upgrade_environment_id="$(tr -d '[:space:]' <"$home/userdata/environment-id")"
[[ -n "$pre_upgrade_environment_id" ]] || fail "the prior left no environment id"

action update "${TOOL_ENV[@]}" "$launcher" update "$TARGET_VERSION" --yes
point_id="$(sed -n 's/^  Kept recovery point \([^ ]*\) (.*/\1/p' "$work/actions/update.log" | head -n 1)"
[[ -n "$point_id" ]] || fail "t3 update kept no recovery point"
[[ "$(launcher_version)" == "$TARGET_VERSION" ]] || fail "the launcher does not run v$TARGET_VERSION"

action post-upgrade-work write_post_upgrade_work
action declare-failure declare_failure "$TARGET_VERSION" "$point_id"

action recover "${TOOL_ENV[@]}" "$launcher" recover "$point_id"
# Before anything opens the restored database again.
restored_sha256="$(sha256sum "$db" | cut -d' ' -f1)"
displaced_path="$(sed -n 's/^  moved the current database to \(.*\)$/\1/p' "$work/actions/recover.log" | head -n 1)"
[[ -n "$displaced_path" ]] || fail "t3 recover did not say where it moved the database"
[[ "$(launcher_version)" == "$prior_version" ]] || fail "the launcher does not run v$prior_version"
tar -czf "$out/drilled-home.tar.gz" -C "$drill_root" home bin

action start-prior serve_restored

node "$here/record.ts" \
  --drill-id "${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(date -u +%Y%m%dT%H%M%SZ)" \
  --commit "$DRILL_COMMIT" \
  --host "$(uname -srm) on ${RUNNER_NAME:-$(hostname)}" \
  --prior-version "$prior_version" \
  --prior-archive "$prior_archive" \
  --target-version "$TARGET_VERSION" \
  --target-archive "$target_archive" \
  --home "$home" \
  --launcher "$launcher" \
  --point-id "$point_id" \
  --restored-sha256 "$restored_sha256" \
  --pre-upgrade-environment-id "$pre_upgrade_environment_id" \
  --displaced-path "$displaced_path" \
  --prior-readback "$work/prior-seeded.json" \
  --restored-readback "$work/restored-readback.json" \
  --restored-environment "$work/restored-environment.json" \
  --actions "$actions_file" \
  --out "$out"
