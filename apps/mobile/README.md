# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

For simulator/emulator development, select and boot a device, then ensure its native client matches
this checkout before starting Metro:

```bash
node ../../scripts/mobile-native-client.ts ensure ios <simulator-udid>
# Or: node ../../scripts/mobile-native-client.ts ensure android <emulator-serial>
vp run dev:client
```

The helper compares a local Expo fingerprint and the installed binary with its last successful
build record. It builds and installs missing, stale, or unverified clients and reuses matching ones.
Use `check` instead of `ensure` for a read-only decision: exit 0 means compatible, 2 means a build is
needed, and 1 means an operational error. Run it on the simulator host; no EAS login is required.
An externally installed client is unverified until the helper builds it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## Install a personal build on your iPhone

You need a Mac with full Xcode and its iOS SDK installed, CocoaPods (`brew install cocoapods`),
the repository's Node version and Vite+, and an iPhone running iOS 18 or newer. A free Apple
account works; no Expo account or paid Apple Developer membership is required.

1. Clone the repository and run `vp i` from its root.
2. Open Xcode once to finish installing its components. In **Xcode > Settings > Accounts**, add
   your Apple account. Select your Personal Team, open **Manage Certificates**, and create an
   **Apple Development** certificate if you do not have one.
3. Connect and unlock your iPhone by USB. Accept the trust prompts on both devices. Enable
   **Settings > Privacy & Security > Developer Mode** on the iPhone and restart it if requested.
4. From the repository root, run:

   ```bash
   vp run ios:personal --bundle-id com.yourname.t3code
   ```

Choose your own unique identifier, then choose your physical iPhone and Personal Team when
prompted. With several devices, pass `--device "Your iPhone"` or its UDID. If iOS requests trust
for the developer, enable it under **Settings > General > VPN & Device Management**.

To prepare the native workspace before connecting a phone, add `--prepare-only`. It generates
the project and installs Pods without requiring a signing certificate or device. The command
regenerates `apps/mobile/ios`; put persistent native changes in Expo config/plugins. If signing
needs manual attention, open the generated `.xcworkspace` in Xcode, choose your Personal Team
under Signing & Capabilities, select the phone, and set the scheme's Run configuration to Release.

The installed **T3 Code Personal** app includes its JavaScript and works without Metro. It still
needs a running T3 server: pair it using the server's connection URL or QR code over your LAN or
Tailscale. `localhost` on the phone refers to the phone, not your Mac. T3 Connect is optional and
requires separate configuration; it is not required for direct connections.

Personal builds omit push notifications, widgets/Live Activities, the incoming share extension,
and native Sign in with Apple. They use a separate app identity and do not receive official OTA
updates. Install source updates by pulling the repository, running `vp i`, and rerunning the command.

Free Personal Team provisioning expires after **seven days**. Rerun the install command with the
**same bundle identifier and Apple team**, without deleting the app, to renew it and preserve local
settings. Keep the identifier in the root's gitignored `.env.local` if you prefer a shorter command:

```dotenv
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.yourname.t3code
```

Then use `vp run ios:personal` for subsequent installs. If Apple reports the identifier is unavailable,
choose another identifier for the first installation. See [Apple's Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account/).

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
