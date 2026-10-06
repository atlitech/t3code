# Fork server releases (atlitech/t3code)

Fork-only runbook. `atli` is upstream `main` plus our commits.
[`fork-server-release.yml`](../../.github/workflows/fork-server-release.yml)
publishes the same self-contained Linux x64 server archive an official release
ships, so a VM that already runs the official background service can switch to
our build and keep its T3 Connect link.

## Versions

Fork versions are `<next upstream patch>-atli.<n>`, for example `0.0.46-atli.1`
while `apps/server/package.json` says `0.0.45`. That is the same core upstream
nightlies use (`0.0.46-nightly.<date>.<run>`).

- It sorts above the official stable the VM came from. Switching needs no
  `--allow-downgrade`, and clients never offer the older stable as an update.
- It sorts below the next official stable (`0.0.46`). Clients offer that once it
  ships; see [Updates offered by clients](#updates-offered-by-clients).
- `atli.<n>` compares numerically, so `atli.10` is newer than `atli.9`.
- It sorts below `0.0.46-nightly.*`. A VM on a nightly needs
  `--allow-downgrade` to switch.

Increase `<n>` for every release and never reuse a version. Each installed
runtime is keyed by its version and is never downloaded again. After a rebase
moves `package.json` to a new version, use the new next patch and restart `<n>`
at 1.

## One-time repository setup

- **Settings → Secrets and variables → Actions → Variables**: add these
  public values from `.env.example`. The workflow stops if one is missing.

  | Variable                           | Value                          |
  | ---------------------------------- | ------------------------------ |
  | `T3CODE_CLERK_PUBLISHABLE_KEY`     | `pk_live_Y2xlcmsudDMuY29kZXMk` |
  | `T3CODE_CLERK_JWT_TEMPLATE`        | `t3-relay`                     |
  | `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` | `hzxSgY2cH10sDU2r`             |
  | `T3CODE_RELAY_URL`                 | `https://relay.t3.codes`       |

- Disable upstream's **Release** workflow:
  `gh workflow disable Release -R atlitech/t3code`. Its `v*.*.*` tag filter
  also matches `v*-atli.*`, and it runs on a schedule. It needs upstream's
  runners and secrets, so it cannot succeed in the fork. Disable any other
  upstream workflow you do not use in the same way.

## Cutting a release

Use a dispatch. The workflow creates the tag on the commit it built:

```sh
gh workflow run fork-server-release.yml -R atlitech/t3code --ref atli -f version=0.0.46-atli.1
```

Pushing a tag works too:

```sh
git tag v0.0.46-atli.1 atli && git push atlitech v0.0.46-atli.1
```

The result is the prerelease `v0.0.46-atli.1` with
`t3-0.0.46-atli.1-linux-x64.tar.gz` and `SHA256SUMS`. A dispatch refuses an
existing tag. To retry a failed tag build, re-run its workflow run.

## Switching the VM to a fork build

These steps assume the official service runs as your user with the default
home, `~/.t3`. The service keeps the same home, database, and secrets, so the
T3 Connect link carries over. If the service's unit sets a different
`T3CODE_HOME`, export that value first.

1. Point the service's own downloads at the fork. `t3 service install` writes
   the systemd **user** unit `~/.config/systemd/user/t3code.service` and
   rewrites only that file, so a drop-in survives updates and reinstalls:

   ```sh
   mkdir -p ~/.config/systemd/user/t3code.service.d
   printf '[Service]\nEnvironment=T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/t3code/releases/download\n' \
     > ~/.config/systemd/user/t3code.service.d/fork.conf
   systemctl --user daemon-reload
   ```

2. Install the archive. This unpacks it into
   `~/.t3/runtime/versions/<version>` and repoints `~/.local/bin/t3`. It does
   not touch the running service.

   ```sh
   export T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/t3code/releases/download
   curl -fsSL https://raw.githubusercontent.com/atlitech/t3code/atli/scripts/install.sh \
     | T3CODE_VERSION=0.0.46-atli.1 sh
   ```

3. Switch the service. This uses the runtime unpacked in step 2, rewrites the
   unit, and restarts the service:

   ```sh
   t3 service install
   ```

4. Check the result:

   ```sh
   t3 --version
   t3 service status
   t3 connect status
   systemctl --user show t3code.service -p Environment
   ```

To move to a newer fork build later, run one command. It downloads, verifies,
repoints `t3`, and restarts the service. Run it with the base URL exported in
your shell, because `t3 update` reads the shell's environment, not the unit's.

```sh
T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/t3code/releases/download t3 update 0.0.46-atli.2 --yes
```

## Pull request watcher

Fork builds ship with the pull request watcher off (`enablePullRequestWatch`
defaults to `false`). To turn it on for a server, set the top-level key in
`~/.t3/userdata/settings.json`, or use **Settings → Source control** from any
client. The server watches the file and applies edits without a restart. Write
to a temporary file, then rename it, so the server never reads a half-written
file:

```sh
f=~/.t3/userdata/settings.json
[ -f "$f" ] || echo '{}' > "$f"
tmp="$(mktemp "$f.XXXXXX")" && jq '.enablePullRequestWatch = true' "$f" > "$tmp" && mv "$tmp" "$f"
```

Only fork builds have this setting. Official builds do not read it and always
watch.

## Updates offered by clients

Clients check upstream's releases, never the fork's. While the fork version is
ahead of upstream stable, nothing is offered. Plain `t3 update` also refuses,
because the newest upstream stable is older than the fork version. After
upstream ships `0.0.46`, clients offer it. With the drop-in in place, the
service downloads from the fork, gets a 404, and keeps running the fork build.
To take the official version, follow [Rolling back](#rolling-back-to-an-official-version).

## Rolling back to an official version

Remove the drop-in, then update without the fork base URL. The official
version is lower than the fork version, so the update needs `--allow-downgrade`.
If that runtime is still in `~/.t3/runtime/versions`, `t3 update` reuses it.

```sh
rm ~/.config/systemd/user/t3code.service.d/fork.conf
systemctl --user daemon-reload
unset T3CODE_RELEASE_BASE_URL
t3 update 0.0.45 --allow-downgrade --yes
```

A fork build may already have run database migrations from upstream `main`
against `~/.t3/userdata`, and an older official build may not run on that
database. Back up `~/.t3/userdata` before the first switch to a fork build.

## Rebasing `atli` on upstream

```sh
git fetch upstream
git switch atli
git rebase upstream/main
git push --force-with-lease atlitech atli
```

Then cut a release. If `apps/server/package.json` moved, use its new next patch
with `-atli.1`.
