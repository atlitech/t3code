const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withPersonalAndroidProfileable(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];

    if (application == null) {
      throw new Error(
        "AndroidManifest.xml is missing the application element required for profileable configuration.",
      );
    }

    application.profileable ??= [{ $: {} }];
    if (application.profileable.length !== 1) {
      throw new Error(
        "AndroidManifest.xml must contain at most one profileable element in the application.",
      );
    }
    application.profileable[0].$ ??= {};
    application.profileable[0].$["android:shell"] = "true";

    return nextConfig;
  });
};
