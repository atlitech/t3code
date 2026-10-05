const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING_HELPERS = `// T3 Code Personal signing; added by withPersonalAndroidSigning.
def t3PersonalSigningValue = { String name ->
    def value = System.getenv(name)
    if (value == null || value.trim().isEmpty()) {
        throw new GradleException("Missing required T3 Code Personal signing variable: " + name)
    }
    return value
}
`;

const PERSONAL_SIGNING_CONFIG = `        personal {
            storeFile file(t3PersonalSigningValue("T3CODE_PERSONAL_ANDROID_KEYSTORE_FILE"))
            storePassword t3PersonalSigningValue("T3CODE_PERSONAL_ANDROID_KEYSTORE_PASSWORD")
            keyAlias t3PersonalSigningValue("T3CODE_PERSONAL_ANDROID_KEY_ALIAS")
            keyPassword t3PersonalSigningValue("T3CODE_PERSONAL_ANDROID_KEY_PASSWORD")
        }
`;

function insertBefore(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withPersonalAndroidSigning: could not find ${description} in app/build.gradle; the Expo template changed, so update the plugin anchors.`,
    );
  }
  return contents.slice(0, index) + insertion + contents.slice(index);
}

module.exports = function withPersonalAndroidSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("withPersonalAndroidSigning: app/build.gradle must use Groovy.");
    }

    let contents = nextConfig.modResults.contents;
    if (contents.includes("t3PersonalSigningValue")) {
      return nextConfig;
    }

    contents = insertBefore(contents, "android {", SIGNING_HELPERS, "the android block");
    contents = insertBefore(
      contents,
      "        debug {\n            storeFile file('debug.keystore')",
      PERSONAL_SIGNING_CONFIG,
      "the debug signing config",
    );

    const releaseStart = contents.indexOf("        release {");
    const releaseEnd = contents.indexOf("        }", releaseStart);
    if (releaseStart === -1 || releaseEnd === -1) {
      throw new Error(
        "withPersonalAndroidSigning: could not find the release build type in app/build.gradle.",
      );
    }

    const releaseBlock = contents.slice(releaseStart, releaseEnd);
    const signedReleaseBlock = releaseBlock.replace(
      "signingConfig signingConfigs.debug",
      "signingConfig signingConfigs.personal",
    );
    if (signedReleaseBlock === releaseBlock) {
      throw new Error(
        "withPersonalAndroidSigning: could not replace the template release signing config.",
      );
    }

    nextConfig.modResults.contents =
      contents.slice(0, releaseStart) + signedReleaseBlock + contents.slice(releaseEnd);
    return nextConfig;
  });
};
