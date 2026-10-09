---
name: develop-t3-personal-android
description: Build and maintain a fork-safe, standalone T3 Code Android app that coexists with the official and development variants, embeds JavaScript so Metro and Expo credentials are unnecessary, uses stable signing, avoids upstream Expo updates, installs through wired or wireless ADB, and connects to a reachable T3 environment. Use when adding the personal app variant, testing fork changes on Android, producing or reinstalling a personal release APK, diagnosing development-client versus standalone behavior, or preparing Galaxy foldable daily-use builds.
---

# Develop T3 Personal Android

Maintain two deliberately different apps:

| App                                      | Purpose                        | Metro          |
| ---------------------------------------- | ------------------------------ | -------------- |
| `T3 Code Dev` / `com.t3tools.t3code.dev` | Fast iteration and live reload | Required       |
| `T3 Code Personal` / `com.elvis.t3code`  | Stable daily-use fork          | Never required |

Treat the personal app as a locally distributed release product. Keep its identity and signing key stable so reinstalling an update preserves app data and environment credentials.

## Preserve the architecture boundary

Distinguish the two servers:

- Metro serves development JavaScript only. A personal release must embed its JavaScript bundle and launch while Metro is absent.
- The T3 server owns projects, threads, providers, and agent processes. Mobile remains a client, so daily use still requires a reachable T3 environment on the Mac or another host.

Use T3 Connect, Tailscale, or another explicitly configured remote path for away-from-home access. Never bake a LAN origin into the app.

## Enable T3 Connect without Expo updates

A fresh clone intentionally omits cloud configuration. Create the ignored repository-root `.env` from `.env.example` when the development or personal app must use the production T3 Connect deployment. The Clerk publishable key, JWT template name, CLI OAuth client ID, and relay URL in that example are public identifiers, not server secrets.

Verify the resolved mobile config contains the relay URL, Clerk publishable key, and Clerk JWT template. When any is absent, the mobile app deliberately omits T3 Connect discovery and account UI while leaving manual environment pairing available.

Keep these concepts separate:

- Preserve the T3 Connect public configuration in the personal build so account sign-in and relay discovery work.
- Disable `expo-updates` and omit maintainer EAS ownership in the personal build so upstream JavaScript cannot replace the fork.
- Never place Clerk secret keys, relay deployment secrets, or observability write tokens into a client `.env`.

## Inspect before changing anything

Read `AGENTS.md`, `apps/mobile/app.config.ts`, `apps/mobile/eas.json`, and `apps/mobile/package.json`. Inspect the current diff and preserve unrelated work.

Read [`../test-t3-mobile/SKILL.md`](../test-t3-mobile/SKILL.md) before launching Metro, building a development client, pairing an environment, or driving a device. Use that skill for the integrated test pass; use this skill for personal variant and release decisions.

Classify the requested change:

- For JavaScript, TypeScript, or assets, reuse `T3 Code Dev` with Metro for iteration. Rebuild the personal APK only at the handoff point.
- For native source, dependencies, Expo config, config plugins, or signing, regenerate the personal native project and rebuild before testing.
- For server-only changes, do not rebuild Android unless the wire contract or mobile client also changed.

## Establish the personal variant once

If `APP_VARIANT=personal` is missing, add it with these stable defaults:

```text
appName: T3 Code Personal
scheme: t3code-personal
androidPackage: com.elvis.t3code
```

Extend `AppVariant`, `resolveAppVariant`, and `VARIANT_CONFIG` in `apps/mobile/app.config.ts`. Add only the minimal personal scripts or build profile needed by the local workflow. Preserve the values above after the first installed build; changing the package creates a different app.

Do not use `com.t3tools.t3code`: it is the official Play Store identity and a locally signed build cannot update it. Do not repurpose `preview`; it is a maintainer-owned distribution surface.

Make the personal variant independent of maintainer infrastructure:

- Set `updates.enabled` to `false` for `personal` so the embedded fork cannot be replaced by an update from `u.expo.dev`.
- Omit the maintainer `owner` and `extra.eas.projectId` from the resolved personal config.
- Do not require EAS or Expo login for local personal builds.
- Preserve the existing update configuration for development, preview, and production.

Verify the resolved config from `apps/mobile` before generating native files:

```bash
cd apps/mobile
APP_VARIANT=personal vp exec expo config --type public
```

Confirm the app name, scheme, Android package, and disabled update behavior. Treat any `pingdotgg` owner, maintainer EAS project ID, or enabled upstream update URL in the personal config as a blocker.

## Keep signing durable and private

Use one dedicated personal Android keystore and retain it for the lifetime of `com.elvis.t3code`.

- Store the keystore outside Git and outside generated `apps/mobile/android` files.
- Store passwords in the macOS Keychain or another secret store, not source files, shell history, skill files, or chat.
- Commit only configuration that reads signing values from environment variables or untracked Gradle properties.
- Back up the keystore securely. Losing it prevents future in-place updates.
- Never generate or replace an existing personal key without explicit user approval.
- Never fall back silently to a maintainer key or a newly generated throwaway key.

Before installing an update, compare its signing certificate with the installed personal app. If Android reports an incompatible signature, stop. Do not uninstall automatically because uninstalling destroys local app data and stored environment credentials.

This checkout's permanent Android identity is stored locally as follows:

```text
keystore: ~/Library/Application Support/T3 Code Personal/signing/t3-code-personal.jks
alias: t3-code-personal
Keychain service: T3 Code Personal Android Keystore Password
Keychain service: T3 Code Personal Android Key Password
SHA-1: A2:D5:2B:3C:01:6E:3C:CF:4E:AB:88:24:31:E8:D8:FC:1F:00:DF:91
SHA-256: 8B:E8:CE:45:32:95:85:4E:A7:D2:5A:CE:67:08:1D:D5:9A:92:4E:C1:AE:8A:E1:11:72:1E:8C:24:46:B3:7E:8E
```

The fingerprints are public certificate identifiers and are safe to record. The passwords are not. Use [`scripts/build-personal-apk.sh`](scripts/build-personal-apk.sh) to read them from Keychain and build without placing them in shell history.

## Respect the hosted identity boundary

T3 Connect uses the maintainers' Clerk and Google OAuth deployments. A fork can reuse their public Clerk and relay identifiers, but it cannot make a new Android package/signing certificate trusted by those deployments.

When Google sign-in fails, capture a narrowly filtered device log and distinguish these cases:

- Google's `android application is not registered to use OAuth2.0` means the package name and signing SHA-1 are not registered for the Google OAuth Android client.
- Clerk's `redirect url ... does not match an authorized redirect URI` means the native callback is absent from that Clerk instance's allowlist.
- Missing `EXPO_PUBLIC_CLERK_GOOGLE_*_CLIENT_ID` values are a separate source-build configuration problem.

For `com.elvis.t3code`, the permanent SHA-1 above and Clerk callback `clerk://com.elvis.t3code.callback` would need to be registered by the owners of those dashboards. Do not fabricate client IDs or copy signing keys. If dashboard access is unavailable, use Clerk's email verification flow with the same Gmail address or pair an environment manually; both avoid native Google OAuth.

### Reuse the production T3 account through email

This workflow is confirmed on the personal Galaxy Fold build:

1. Open **T3 Account** in `T3 Code Personal`.
2. Enter the same Gmail address used by the production T3 account.
3. Choose the email verification/code flow rather than **Continue with Google**.
4. Complete the code sent to Gmail.

This authenticates against the same production Clerk account; it does not create a separate fork-only identity. The official and personal Android packages still have separate application sandboxes, so an existing session in `com.t3tools.t3code` cannot be read or transferred into `com.elvis.t3code`. Sign in once inside the personal app and let its secure storage retain its own session.

Do not interpret successful Gmail email verification as fixing native Google OAuth. **Continue with Google** remains unavailable to the personal package until the Google Android client and Clerk callback registrations described above are added by their owners.

## Release APKs and the versionCode

The fork's release workflow builds the signed personal APK: `fork-server-release.yml`'s `build-android` job signs it with this key and checks its package, versionCode, and certificate against the SHA-256 recorded above (`scripts/fork-android-identity.ts`) before uploading it. Prefer that artifact for daily use.

Android installs an update only when its versionCode is not lower than the installed one. `apps/mobile/app.config.ts` derives the personal versionCode from `T3CODE_RELEASE_VERSION` (`X.Y.Z-atli.N`) through `scripts/lib/android-version-code.ts`, so each release grows it. A personal build without a release version carries versionCode 1, the floor, and is not an update path over a CI-built APK: Android refuses the downgrade, and getting past it means uninstalling, which destroys app data. Build locally with `--release-version` set to the release the installed APK came from, or a later one, when the result must install over it.

## Build a standalone APK locally

On this Mac, prefer the skill helper from the repository root. It verifies the key exists, retrieves its passwords from Keychain, regenerates the personal Android project, and builds an ARM64 release APK:

```bash
.agents/skills/develop-t3-personal-android/scripts/build-personal-apk.sh
```

Pass `--release-version <X.Y.Z-atli.N>`, or set `T3CODE_RELEASE_VERSION`, to give the build that release's versionCode. Prebuild writes the versionCode, so the script refuses a release version together with `--no-prebuild`.

Pass `--no-prebuild` only when the generated Android project is already personal and no native/config input changed. Pass `--universal` when the APK must support architectures beyond the Galaxy Fold's ARM64 processor.

The equivalent manual workflow follows for diagnosing individual phases.

Install dependencies from the repository root, then inspect the app config from `apps/mobile`:

```bash
vp install --frozen-lockfile
cd apps/mobile
APP_VARIANT=personal vp exec expo config --type public
```

Use the existing generated Android project only when its `applicationId` is `com.elvis.t3code` and no native/config inputs changed. Otherwise regenerate it:

```bash
cd apps/mobile
APP_VARIANT=personal T3CODE_RELEASE_VERSION=<X.Y.Z-atli.N> EXPO_NO_GIT_STATUS=1 \
  vp exec expo prebuild --clean --platform android --no-install
```

Omit `T3CODE_RELEASE_VERSION` only for a build that will not install over a release APK.

Build a release APK with the personal variant present during JavaScript export. Limit native compilation to the Fold's ARM64 architecture for a phone-only artifact; omit the property when a universal APK is required.

```bash
cd android
APP_VARIANT=personal ./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a
```

Do not call a debug Gradle task for the daily-use artifact. A debug APK launches the Expo development client and depends on Metro; a release APK embeds the production JavaScript bundle.

## Verify before installing

Locate the actual output under `apps/mobile/android/app/build/outputs/apk/release/`; do not assume a successful command produced the expected identity. Use the project-compatible Android SDK tools to verify:

```bash
"$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" \
  manifest application-id <personal-apk>
"$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" \
  manifest version-name <personal-apk>
"$ANDROID_HOME/build-tools/36.0.0/apksigner" \
  verify --print-certs <personal-apk>
```

Require all of the following:

- Application ID is exactly `com.elvis.t3code`.
- The versionCode is not lower than the installed personal app's (`adb shell dumpsys package com.elvis.t3code | grep versionCode`).
- The manifest is not debuggable.
- The APK contains an embedded JavaScript/update bundle and required assets.
- The signing certificate matches the previous personal build when one is installed.
- The official and development packages remain untouched.

Run the smallest relevant mobile typecheck or tests. Do not run repository-wide checks.

## Install on the physical phone

List devices and select the Fold's exact serial; do not rely on `-d` when more than one target exists:

```bash
adb devices -l
adb -s <fold-serial> install -r <personal-apk>
adb -s <fold-serial> shell pm path com.elvis.t3code
```

Wireless ADB is valid. Pairing usually persists, while the phone's IP and connect port may rotate. Let ADB rediscover the paired device through mDNS and use `adb connect` only when automatic reconnection fails.

Launch `T3 Code Personal` without a Metro URL. Verify it reaches the real T3 interface rather than the Expo launcher, then connect it to a reachable T3 environment with a fresh single-use pairing credential. Never include pairing tokens in logs, screenshots, commits, or final responses.

## Iterate and promote changes

Use this loop:

1. Make a focused change in the fork.
2. Test it in `T3 Code Dev` through the `test-t3-mobile` workflow.
3. Run targeted checks for the affected mobile code.
4. Build and verify a new personal release APK.
5. Install with `adb install -r` so the stable package and signing key preserve data.
6. Confirm the standalone app launches without Metro and reconnects to the intended T3 environment.

Because personal Expo updates are disabled, JavaScript-only changes also require rebuilding and reinstalling the personal APK. Configure a separate owner-controlled Expo project later only if the user explicitly wants OTA updates.

## Guardrails

- Never start a T3 server against live `~/.t3/userdata` during testing.
- Never overwrite the Play Store package or maintainer preview package.
- Never commit keystores, passwords, pairing credentials, Clerk secrets, or Expo credentials.
- Never uninstall an app, clear its data, revoke pairings, or rotate signing keys without explicit approval.
- Never claim the app works anywhere merely because Metro is gone; verify the T3 backend is remotely reachable.
- Keep `apps/mobile/android` generated and ignored unless repository policy changes explicitly.
- Stop only Metro or backend processes started and tracked by the current task.
