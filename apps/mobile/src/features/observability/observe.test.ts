import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: { extra: { appVariant: "personal", relay: { url: "https://relay.test" } } },
  },
}));
vi.mock("expo-observe", () => {
  throw new Error("Project ID is required to send observability metrics.");
});

it("starts without loading native observability when no Expo project is configured", async () => {
  vi.stubGlobal("__DEV__", false);
  try {
    const observe = await import("./observe");
    expect(observe.crashReportingAvailable).toBe(false);
    expect(() => observe.reportError(new Error("render failure"))).not.toThrow();
    await expect(observe.setCrashReportsEnabled(true)).resolves.toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});
