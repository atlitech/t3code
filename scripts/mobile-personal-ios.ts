#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Interactive CLI prints build instructions and delegates native work to Expo and Xcode.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { loadRepoEnv } from "./lib/public-config.ts";

const help = `Build and install T3 Code Personal on your iPhone (macOS only).

  vp run ios:personal --bundle-id com.yourname.t3code
  vp run ios:personal --bundle-id com.yourname.t3code --prepare-only

Options:
  --bundle-id <id>    Unique app identifier. Keep it unchanged when reinstalling.
                     Also reads T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID from root .env.local.
  --device <id/name>  Select an iPhone; otherwise Expo prompts for a device.
  --prepare-only     Generate the Xcode workspace and install Pods without a phone.
  --help             Show this help.

Before installation, add your Apple account in Xcode > Settings > Accounts and
create an Apple Development certificate under Manage Certificates. Connect and
unlock the iPhone, trust this Mac, and enable Settings > Privacy & Security >
Developer Mode. Free Personal Team installations expire after seven days.

This regenerates apps/mobile/ios, builds Release with bundled JavaScript, and
disables official OTA updates. No Expo account or Metro server is needed.
`;

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "bundle-id": { type: "string" },
      device: { type: "string" },
      "prepare-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher runs before any Effect runtime.
  if (process.platform !== "darwin") {
    throw new Error("Personal iOS builds require a Mac with Xcode installed.");
  }

  const repoEnv = loadRepoEnv();
  const bundleId = (values["bundle-id"] ?? repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID)?.trim();
  if (!bundleId || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
    throw new Error(
      "Pass --bundle-id with a unique reverse-DNS identifier, e.g. com.yourname.t3code.",
    );
  }
  if (bundleId.startsWith("com.t3tools.")) {
    throw new Error(
      "Choose your own bundle identifier instead of the official com.t3tools namespace.",
    );
  }
  const mobile = NodeURL.fileURLToPath(new URL("../apps/mobile/", import.meta.url));
  const expo = NodeURL.fileURLToPath(
    new URL("../apps/mobile/node_modules/expo/bin/cli", import.meta.url),
  );
  if (!NodeFS.existsSync(expo)) {
    throw new Error("Dependencies are missing. Run `vp i` from the repository root first.");
  }
  const env = {
    ...repoEnv,
    APP_VARIANT: "development",
    MOBILE_VERSION_POLICY: "appVersion",
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: bundleId,
    T3CODE_MOBILE_UPDATES_ENABLED: "0",
    EXPO_NO_DOTENV: "1",
    EXPO_NO_GIT_STATUS: "1",
  };

  function run(command: string, args: string[], hint: string, capture = false) {
    const result = NodeChildProcess.spawnSync(command, args, {
      cwd: mobile,
      env,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${hint}${result.error ? ` (${result.error.message})` : ""}`);
    }
    return result.stdout ?? "";
  }

  run(
    "xcrun",
    ["--sdk", "iphoneos", "--show-sdk-path"],
    "Install full Xcode, open it to finish setup, and select it with xcode-select.",
    true,
  );
  run("pod", ["--version"], "Install CocoaPods with `brew install cocoapods`.", true);

  if (!values["prepare-only"]) {
    run(
      "xcodebuild",
      ["-checkFirstLaunchStatus"],
      "Xcode setup is incomplete. Open Xcode and let it install its additional components, or run `sudo xcodebuild -runFirstLaunch` in your terminal, then retry.",
      true,
    );
    const identities = run(
      "security",
      ["find-identity", "-v", "-p", "codesigning"],
      "Unable to read signing identities from your login keychain.",
      true,
    );
    if (!/"(?:Apple Development|iPhone Developer):/.test(identities)) {
      throw new Error(
        "No Apple Development certificate found. In Xcode > Settings > Accounts, add your Apple account, select your Personal Team, then Manage Certificates > + > Apple Development. Rerun this command afterward, or use --prepare-only now.",
      );
    }
  }

  console.log(
    `Preparing T3 Code Personal (${bundleId}).\nRegenerating apps/mobile/ios; keep native changes in Expo config/plugins.`,
  );
  run(
    process.execPath,
    [expo, "prebuild", "--clean", "--platform", "ios", "--no-install"],
    "Expo prebuild failed. Fix the error above and rerun the same command.",
  );
  // Run Pods explicitly: --no-install keeps prebuild from reinstalling JS dependencies.
  run(
    "pod",
    ["install", "--project-directory=ios"],
    "CocoaPods installation failed. Fix the error above and rerun the same command.",
  );
  // Xcode launched from Finder must bundle the same personal manifest as the CLI.
  NodeFS.appendFileSync(
    `${mobile}/ios/.xcode.env`,
    `\nexport APP_VARIANT=development\nexport MOBILE_VERSION_POLICY=appVersion\nexport T3CODE_IOS_PERSONAL_TEAM=1\nexport T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=${bundleId}\nexport T3CODE_MOBILE_UPDATES_ENABLED=0\nexport EXPO_NO_DOTENV=1\n`,
  );

  if (values["prepare-only"]) {
    console.log(
      "\nReady. Connect your iPhone and rerun without --prepare-only.\nFor manual signing, open the .xcworkspace in apps/mobile/ios and select your Personal Team.",
    );
    return;
  }
  console.log(
    "\nChoose your physical iPhone and your Personal Team when prompted.\nThe first Release build can take several minutes.",
  );
  run(
    process.execPath,
    [
      expo,
      "run:ios",
      "--configuration",
      "Release",
      "--no-bundler",
      "--device",
      ...(values.device ? [values.device] : []),
    ],
    "Installation failed. Check the error above, unlock/trust the iPhone, and enable Developer Mode. For signing issues, open apps/mobile/ios/*.xcworkspace in Xcode, select your Personal Team and iPhone, then run the Release configuration. Keep the same bundle identifier when retrying.",
  );
  console.log(
    "\nInstalled T3 Code Personal. Metro is not needed. Pair with your running T3 server over LAN or Tailscale.\nReinstall with the same bundle identifier to renew free signing after seven days; do not delete the app first.",
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
