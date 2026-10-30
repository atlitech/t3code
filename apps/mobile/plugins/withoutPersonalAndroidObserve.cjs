const { withSettingsGradle } = require("expo/config-plugins");

module.exports = function withoutPersonalAndroidObserve(config) {
  return withSettingsGradle(config, (nextConfig) => {
    const anchor = "expoAutolinking.useExpoModules()";
    const exclusion =
      'expoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ["expo-observe"]';
    if (!nextConfig.modResults.contents.includes(exclusion)) {
      if (!nextConfig.modResults.contents.includes(anchor)) {
        throw new Error("Cannot exclude Expo Observe: settings.gradle has no useExpoModules call.");
      }
      // Native module registration initializes Observe even when JavaScript never imports it.
      nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
        anchor,
        `${exclusion}\n${anchor}`,
      );
    }
    return nextConfig;
  });
};
