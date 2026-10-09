#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s [--release-version <X.Y.Z-atli.N>] [--no-prebuild] [--universal]\n' "$0"
}

prebuild=1
architectures='arm64-v8a'
release_version="${T3CODE_RELEASE_VERSION:-}"

while (($# > 0)); do
  case "$1" in
    --no-prebuild)
      prebuild=0
      ;;
    --universal)
      architectures=''
      ;;
    --release-version)
      if (($# < 2)) || [[ -z "$2" ]]; then
        usage >&2
        exit 2
      fi
      release_version="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# app.config.ts derives the personal versionCode from the release version at
# prebuild, so a build that skips prebuild cannot carry it.
if [[ -n "$release_version" ]] && ((!prebuild)); then
  printf -- '--release-version needs prebuild to write the versionCode; drop --no-prebuild.\n' >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
mobile_dir="$repo_root/apps/mobile"
android_dir="$mobile_dir/android"
apk_path="$android_dir/app/build/outputs/apk/release/app-release.apk"

keystore_path='/Users/elvisnievesmiranda/Library/Application Support/T3 Code Personal/signing/t3-code-personal.jks'
key_alias='t3-code-personal'
keychain_account="$(id -un)"
store_service='T3 Code Personal Android Keystore Password'
key_service='T3 Code Personal Android Key Password'

if [[ ! -f "$keystore_path" ]]; then
  printf 'Personal Android keystore not found: %s\n' "$keystore_path" >&2
  exit 1
fi
if ! command -v security >/dev/null 2>&1; then
  printf 'macOS Keychain command not found.\n' >&2
  exit 1
fi
if ! command -v vp >/dev/null 2>&1; then
  printf 'vp is required but was not found on PATH.\n' >&2
  exit 1
fi

export T3CODE_PERSONAL_ANDROID_KEYSTORE_FILE="$keystore_path"
export T3CODE_PERSONAL_ANDROID_KEY_ALIAS="$key_alias"
export T3CODE_PERSONAL_ANDROID_KEYSTORE_PASSWORD
export T3CODE_PERSONAL_ANDROID_KEY_PASSWORD
T3CODE_PERSONAL_ANDROID_KEYSTORE_PASSWORD="$(
  security find-generic-password -a "$keychain_account" -s "$store_service" -w
)"
T3CODE_PERSONAL_ANDROID_KEY_PASSWORD="$(
  security find-generic-password -a "$keychain_account" -s "$key_service" -w
)"
trap 'unset T3CODE_PERSONAL_ANDROID_KEYSTORE_PASSWORD T3CODE_PERSONAL_ANDROID_KEY_PASSWORD' EXIT

if [[ -n "$release_version" ]]; then
  export T3CODE_RELEASE_VERSION="$release_version"
  printf 'Building release %s; prebuild derives its versionCode.\n' "$release_version"
else
  unset T3CODE_RELEASE_VERSION
  printf 'No release version: this build carries versionCode 1 (the floor) and cannot install\n'
  printf 'over a CI-built release APK, because Android refuses a versionCode downgrade.\n'
fi

if ((prebuild)); then
  (
    cd "$mobile_dir"
    APP_VARIANT=personal EXPO_NO_GIT_STATUS=1 vp exec expo prebuild \
      --clean --platform android --no-install
  )
elif ! grep -qE "namespace ['\"]com\\.elvis\\.t3code['\"]" "$android_dir/app/build.gradle"; then
  printf 'Generated Android project is not the personal variant; rerun without --no-prebuild.\n' >&2
  exit 1
fi

gradle_args=(:app:assembleRelease)
if [[ -n "$architectures" ]]; then
  gradle_args+=("-PreactNativeArchitectures=$architectures")
fi

(
  cd "$android_dir"
  APP_VARIANT=personal ./gradlew "${gradle_args[@]}"
)

if [[ ! -f "$apk_path" ]]; then
  printf 'Gradle completed but the personal APK was not found: %s\n' "$apk_path" >&2
  exit 1
fi

printf 'Personal APK: %s\n' "$apk_path"
