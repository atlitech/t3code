import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const environment = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => environment.values,
}));

afterEach(() => {
  environment.values = {};
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function config(values: Record<string, string>) {
  environment.values = values;
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  return (await import("./app.config.ts")).default;
}

describe("personal iOS configuration", () => {
  it("isolates signing, keychain, links and updates from the official app", async () => {
    const result = await config({
      APP_VARIANT: "development",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.personal",
      T3CODE_MOBILE_UPDATES_ENABLED: "1",
    });
    expect(result.name).toBe("T3 Code Personal");
    expect(result.scheme).toBe("t3code-com.example.personal");
    expect(result.ios?.bundleIdentifier).toBe("com.example.personal");
    expect(result.ios?.appleTeamId).toBeUndefined();
    expect(result.ios?.associatedDomains).toEqual([]);
    expect(result.ios?.entitlements?.["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)com.example.personal",
    ]);
    expect(result.updates?.enabled).toBe(false);
    expect(result.updates?.url).toBeUndefined();
    expect(result.owner).toBeUndefined();
    expect(result.extra?.eas).toBeUndefined();
    const plugins = result.plugins?.map((plugin) =>
      typeof plugin === "string" ? plugin : plugin[0],
    );
    expect(plugins).not.toContain("expo-widgets");
    expect(plugins).toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");
  });

  it("preserves the official production identity and update service", async () => {
    const result = await config({ APP_VARIANT: "production" });
    expect(result.ios?.bundleIdentifier).toBe("com.t3tools.t3code");
    expect(result.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
    expect(result.scheme).toBe("t3code");
    expect(result.updates?.enabled).toBe(true);
    expect(result.extra?.eas?.projectId).toBe("d763fcb8-d37c-41ea-a773-b54a0ab4a454");
  });

  it.each(["", "not a bundle", "com..example"])(
    "rejects invalid personal identifier %j",
    async (id) => {
      await expect(
        config({
          T3CODE_IOS_PERSONAL_TEAM: "1",
          T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: id,
        }),
      ).rejects.toThrow("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID");
    },
  );
});
