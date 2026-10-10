# Fork server releases (atlitech/t3code)

Fork-only runbook. `atli` is upstream `main` plus our commits.
[`fork-server-release.yml`](../../.github/workflows/fork-server-release.yml)
publishes the same self-contained Linux x64 server archive an official release
ships, so a VM that already runs the official background service can switch to
our build and keep its T3 Connect link. Each release also carries the unsigned
Mac arm64 desktop app and the personal Android arm64-v8a APK, built from the
same commit.

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
runtime is keyed by its version and is never downloaded again. After an
upstream update moves `package.json` to a new version, use the new next patch
and restart `<n>` at 1.

## One-time repository setup

- **Settings → Secrets and variables → Actions → Variables**: add these
  public values from `.env.example`. The workflow stops if one is missing.

  | Variable                           | Value                          |
  | ---------------------------------- | ------------------------------ |
  | `T3CODE_CLERK_PUBLISHABLE_KEY`     | `pk_live_Y2xlcmsudDMuY29kZXMk` |
  | `T3CODE_CLERK_JWT_TEMPLATE`        | `t3-relay`                     |
  | `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` | `hzxSgY2cH10sDU2r`             |
  | `T3CODE_RELAY_URL`                 | `https://relay.t3.codes`       |

- **Settings → Environments**: create `personal-android-signing` and, under
  **Deployment branches and tags**, allow only the `atli` branch. Only the
  Android build job uses it, and it runs only from `atli`. Add:

  | Kind             | Name                                        | Value                                                   |
  | ---------------- | ------------------------------------------- | ------------------------------------------------------- |
  | Secret           | `T3CODE_PERSONAL_ANDROID_KEYSTORE_BASE64`   | the personal keystore, `base64 < keystore.jks`          |
  | Secret           | `T3CODE_PERSONAL_ANDROID_KEYSTORE_PASSWORD` | the keystore password                                   |
  | Secret           | `T3CODE_PERSONAL_ANDROID_KEY_PASSWORD`      | the key password                                        |
  | Variable         | `T3CODE_PERSONAL_ANDROID_KEY_ALIAS`         | the key alias                                           |
  | Secret, optional | `GOOGLE_SERVICES_JSON_BASE64`               | `base64 < google-services.json`, for push notifications |

  Use the key the installed personal app is signed with, or `adb install -r`
  refuses the CI APK. Without `GOOGLE_SERVICES_JSON_BASE64` the APK builds
  without push notifications.

- Optional, under **Variables**: `T3CODE_CLERK_GOOGLE_ANDROID_CLIENT_ID`, the
  Google Android OAuth client ID. Only when it is set does the APK offer native
  Google sign-in.

- Disable upstream's **Release** workflow:
  `gh workflow disable Release -R atlitech/t3code`. Its `v*.*.*` tag filter
  also matches `v*-atli.*`, and it runs on a schedule. It needs upstream's
  runners and secrets, so it cannot succeed in the fork. Disable any other
  upstream workflow you do not use in the same way.

## Cutting a release

Dispatch the workflow from `atli`; nothing else starts a release:

```sh
gh workflow run fork-server-release.yml -R atlitech/t3code --ref atli -f version=0.0.46-atli.1
```

A guard job runs before any build. It refuses a dispatch from any other ref, a
version whose tag or release already exists, and an `atli` tip without a
passing `Check` run (CI runs on every push to `atli`). Every build checks out
the commit the guard approved, and the publish job creates the tag and the
release together, with every asset at once. A release publishes only when the
Linux server, the Mac desktop app, and the Android APK all build. The Android
job checks the app's public config before it builds, and the APK's package,
signing certificate, and versionCode before it uploads.

The result is the prerelease `v0.0.46-atli.1` with
`t3-0.0.46-atli.1-linux-x64.tar.gz`, `T3-Code-0.0.46-atli.1-arm64.dmg`,
`T3-Code-0.0.46-atli.1-android-arm64-v8a.apk`, `SHA256SUMS`, and
`manifest.json`, which names the source commit, the version, and each asset's
platform, arch, size, and sha256. Each of those files has a build provenance
attestation:

```sh
gh attestation verify t3-0.0.46-atli.1-linux-x64.tar.gz -R atlitech/t3code
```

A published release never changes. Do not re-run a failed release: dispatch
again, and once a version has a tag or release, use the next atli number.

Owner action, once: enable immutable releases on atlitech/t3code
(**Settings → General → Releases**), so GitHub also refuses to change a
published release's assets or move its tag.

## Switching the VM to a fork build

A fork version installs only once it is admitted: its release carries the
`ADMISSION.json` the release workflow's admission job publishes, naming that
version and the sha256 of its Linux x64 archive. `install.sh`, `t3 update`, and
the in-app update all check it, and refuse a version without a record or whose
record does not match the archive, before anything changes. Official versions
need no record. Below, `<version>` is an admitted fork version, such as the
newest fork release.

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
     | T3CODE_VERSION=<version> sh
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
checks the admission record, migrates a scratch copy of the database with the
new version, repoints `t3`, and restarts the service. If that migration fails,
it refuses and the service keeps the current version; the in-app update does
the same. Run it with the base URL exported in your shell, because `t3 update`
reads the shell's environment, not the unit's.

```sh
T3CODE_RELEASE_BASE_URL=https://github.com/atlitech/t3code/releases/download t3 update <version> --yes
```

`0.0.46-atli.1`, `0.0.46-atli.2`, and `0.0.46-atli.3` were released before
admission existed and have no record. Use them only for an owner rollback,
with `t3 update <version> --allow-unadmitted`, which accepts only those three
versions and logs the override. Any other unadmitted version is refused even
with the flag. The in-app update (a client's Update button) and `install.sh`
have no override.

## Installing the macOS desktop app

Every release carries the Mac arm64 desktop app as an unsigned DMG, with the
same version as the server. Download it and check it before installing:

```sh
gh release download v0.0.46-atli.2 -R atlitech/t3code -p 'T3-Code-*-arm64.dmg' -p SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify T3-Code-0.0.46-atli.2-arm64.dmg -R atlitech/t3code
```

Copy the app out of the DMG:

```sh
hdiutil attach T3-Code-0.0.46-atli.2-arm64.dmg -nobrowse -readonly -mountpoint /tmp/t3-dmg
ditto "/tmp/t3-dmg/T3 Code (Alpha).app" "T3 Code (Alpha).app"
hdiutil detach /tmp/t3-dmg
```

The unsigned app keeps Electron's default signature, which does not verify.
Sign it ad hoc before installing:

```sh
codesign --force --deep --sign - "T3 Code (Alpha).app"
codesign --verify --deep --strict "T3 Code (Alpha).app"
```

Then quit T3 Code and replace the app in `/Applications`. The bundle ID matches
the official app, so `~/.t3/userdata` carries over. An agent running inside the
app ends when it quits, so an agent doing the swap must hand it to a detached
process. The build has no update feed and never replaces itself. macOS may ask
once for Keychain access to "T3 Code Safe Storage" because every ad hoc build
has a new signature.

### Building it locally

When a release cannot be used, build the same DMG from `atli`. Use the same
version as the server release. Builds read T3 Connect's public identifiers from
the repository `.env`; without it the app builds with T3 Connect left out:

```sh
cp -n .env.example .env
T3CODE_DESKTOP_VERSION=0.0.46-atli.2 vp run dist:desktop:dmg:arm64
```

The DMG lands in `release/`. The build compiles the bundled resource monitor,
which needs Rust (`rustup target add aarch64-apple-darwin`). Without Rust, and
only while `native/resource-monitor` is unchanged since the installed app was
built, reuse the installed binary:

```sh
mkdir -p native/resource-monitor/target/aarch64-apple-darwin/release
cp "/Applications/T3 Code (Alpha).app/Contents/Resources/resource-monitor/t3-resource-monitor" \
  native/resource-monitor/target/aarch64-apple-darwin/release/
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1 T3CODE_DESKTOP_VERSION=0.0.46-atli.2 vp run dist:desktop:dmg:arm64
```

Copy the app out, sign it ad hoc, and install it as above.

## Installing the personal Android app

Every release carries the personal app (`com.elvis.t3code`) as an arm64-v8a
APK signed with the personal key. Download it, check it, and install it over
the existing app:

```sh
gh release download v0.0.46-atli.2 -R atlitech/t3code -p 'T3-Code-*-android-arm64-v8a.apk' -p SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify T3-Code-0.0.46-atli.2-android-arm64-v8a.apk -R atlitech/t3code
adb devices -l
adb -s <device-serial> install -r T3-Code-0.0.46-atli.2-android-arm64-v8a.apk
```

The APK's versionCode is derived from the release version, so each release
installs over the one before it, and Android refuses to install an older
release over a newer one.

### Building it locally

When a release cannot be used, use the `develop-t3-personal-android` skill. Its
script reads the signing passwords from the macOS Keychain and builds a
standalone release APK:

```sh
.agents/skills/develop-t3-personal-android/scripts/build-personal-apk.sh
adb devices -l
adb -s <device-serial> install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

After an upstream update, run it without `--no-prebuild` when dependencies or
native config changed. `install -r` keeps the app's data only when the APK is signed
with the same key as the installed app; the skill describes how to check. A local
build without `--release-version` carries versionCode 1, so it cannot update
over an APK from a release; uninstall the app first, which deletes its data.

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
database. An official build keeps no recovery point, so back up
`~/.t3/userdata` before the first switch from it to a fork build.

### Recovering a failed update

Before `t3 update` or the in-app update switches this home to another server
version, it keeps a recovery point under `~/.t3/recovery/points/`: a backup of
the database and a record of the version it came from. The newest three
points are kept. List them, then restore one by its id:

```sh
t3 recover --list
t3 recover <id>
```

`t3 recover <id>` puts back that point's database and the prior runtime it
records. When this home's background service serves it, recover stops the
service first, then points it at the prior runtime and restarts it; otherwise
it changes only the database and the `t3` launcher. The database it replaces
is kept under `~/.t3/recovery/displaced/` and never pruned, so later work is
not lost. Recover refuses before changing anything when the backup or the
prior runtime does not match the point's record, or while a server started by
hand runs on this home. A prior runtime installed without a recorded archive
sha256 is restored only with `--allow-unverified-runtime`, which the point's
`recovery.json` records.

Revocations made after the point was kept are carried over into the restored
database: before anything moves, recover copies the point's backup beside the
database and applies to that copy every session and pairing-link revocation,
and every pairing-link use, the current database records. A session created
after the point is not in the restored database at all. When those
revocations cannot be read, recover refuses with the current database in
place.

## Updating `atli` from upstream

`atli` takes upstream changes only through a merge, so it keeps upstream's
history as an ancestor. The ruleset on `atli` refuses force pushes, so never
rewrite it. `origin` is `atlitech/t3code` and `upstream` is `pingdotgg/t3code`.

Freeze the upstream commit first, so the update does not move while you work
on it, then build a candidate branch from `atli` plus a merge of that commit:

```sh
git fetch origin atli
git fetch upstream main
upstream_sha="$(git rev-parse upstream/main)"
branch="update/upstream-${upstream_sha:0:12}"
git switch -c "$branch" origin/atli
git merge --no-ff "$upstream_sha" -m "Merge upstream ${upstream_sha:0:12} into atli"
git push origin "$branch"
gh pr create --repo atlitech/t3code --base atli --head "$branch" \
  --title "Merge upstream ${upstream_sha:0:12} into atli" \
  --body "Merges upstream commit $upstream_sha. Merge with a merge commit."
```

When the fork's CI passes, merge the pull request with a merge commit, never
squash or rebase. Either loses upstream's commits as ancestors of `atli`, and
the next update conflicts again on everything this one resolved:

```sh
gh pr merge <pr> --repo atlitech/t3code --merge
```

### Conflicts

Two files are known to conflict. Resolve them in the candidate branch, then
`git add` them and `git commit` to finish the merge:

- `pnpm-workspace.yaml`: both sides add entries to `patchedDependencies`.
  Keep both sides' entries.
- `pnpm-lock.yaml`: never hand-merge it. Take either side, then regenerate it
  with `pnpm install` once `pnpm-workspace.yaml` is resolved.

Any other conflict stops the update. Run `git merge --abort`, delete the
candidate branch, and leave the update for the owner.

Then cut a release. If `apps/server/package.json` moved, use its new next patch
with `-atli.1`.
