# shellcheck shell=bash
# Fork-only (atlitech/t3code). Sourced by run-admission.sh and
# record-fixture.sh: extracts a release archive and runs its `t3 serve` on a
# scratch T3 home, the way smoke-cli-archive.ts does, with no PATH and no
# ambient environment. Only the PID started here is ever signalled.

SERVER_PID=""

# extract_archive <archive> <dir>: prints the path of the extracted `t3`.
extract_archive() {
  local archive="$1" dir="$2" root
  mkdir -p "$dir"
  tar -xzf "$archive" -C "$dir"
  root="$(find "$dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$root" || ! -x "$root/t3" || ! -f "$root/client/index.html" ]]; then
    echo "::error::$archive does not hold <dir>/t3 and <dir>/client/index.html" >&2
    return 1
  fi
  printf '%s\n' "$root/t3"
}

free_port() {
  node -e 'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'
}

# isolated_env <home>: sets T3_ENV to the `env -i` prefix that runs the
# executable as an installer would, with only that home.
isolated_env() {
  T3_ENV=(env -i HOME="$1" USERPROFILE="$1" T3CODE_HOME="$1" TMPDIR="$1" PATH=)
}

# run_t3 <t3> <home> <args...>: runs a one-shot command in the foreground.
run_t3() {
  local t3="$1" home="$2"
  shift 2
  isolated_env "$home"
  "${T3_ENV[@]}" "$t3" "$@"
}

# start_server <t3> <home> <port> <log>: serves until GET / answers 200.
start_server() {
  local t3="$1" home="$2" port="$3" log="$4" attempt status
  mkdir -p "$home"
  isolated_env "$home"
  # A simple command, not a function, so $! is the server itself (env execs
  # it) rather than a subshell that SIGTERM would leave the server behind.
  "${T3_ENV[@]}" "$t3" serve --host 127.0.0.1 --port "$port" --no-browser >"$log" 2>&1 &
  SERVER_PID=$!
  # The same budget as smoke-cli-archive.ts: a probe every 250ms for 30s.
  for attempt in $(seq 1 120); do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/" || true)"
    if [[ "$status" == "200" ]]; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "::error::$t3 serve exited before answering; log follows" >&2
      cat "$log" >&2
      SERVER_PID=""
      return 1
    fi
    sleep 0.25
  done
  echo "::error::$t3 serve gave no 200 from / within 30s (attempt $attempt); log follows" >&2
  cat "$log" >&2
  stop_server || true
  return 1
}

# stop_server: SIGTERM, then up to 10s for the process to exit, so sqlite is
# closed before anything else opens the database.
stop_server() {
  local pid="$SERVER_PID" attempt
  [[ -n "$pid" ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for attempt in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      SERVER_PID=""
      return 0
    fi
    sleep 0.25
  done
  echo "::error::server $pid did not exit within 10s of SIGTERM (attempt $attempt)" >&2
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  SERVER_PID=""
  return 1
}
