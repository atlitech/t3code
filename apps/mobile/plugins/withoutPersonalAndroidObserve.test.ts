import * as NodeModule from "node:module";
import type { ConfigPlugin, ExportedConfig } from "expo/config-plugins";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = require("./withoutPersonalAndroidObserve.cjs") as ConfigPlugin;

it("excludes native Observe before registration and preserves existing exclusions on repeat prebuilds", async () => {
  const config = plugin({ name: "Personal", slug: "personal" }) as ExportedConfig;
  const mod = config.mods?.android?.settingsGradle;
  if (!mod) throw new Error("Missing settings.gradle mod");
  const input = {
    ...config,
    modRawConfig: config,
    modResults: {
      path: "/tmp/personal/android/settings.gradle",
      language: "groovy" as const,
      contents: 'expoAutolinking.exclude = ["another-module"]\nexpoAutolinking.useExpoModules()\n',
    },
    modRequest: {
      projectRoot: "/tmp/personal",
      platformProjectRoot: "/tmp/personal/android",
      projectName: "Personal",
      platform: "android" as const,
      modName: "settingsGradle",
      introspect: false,
    },
  };
  const result = await mod(input);
  expect(result.modResults.contents).toContain(
    'expoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ["expo-observe"]\nexpoAutolinking.useExpoModules()',
  );
  expect(result.modResults.contents).toContain('["another-module"]');
  expect((await mod(result)).modResults.contents).toBe(result.modResults.contents);
});
