#!/usr/bin/env bash
set +x
set -euo pipefail

cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Run this script on macOS.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit source changes before releasing.' >&2; exit 1; }
revision="$(git rev-parse HEAD)"

identity='UnlikeOtherAI s.r.o. (23B7GTLBN7)'
: "${APP_STORE_CONNECT_API_KEY_PATH:?Set the notarization API key path.}"
: "${APP_STORE_CONNECT_API_KEY_ID:?Set the notarization API key ID.}"
: "${APP_STORE_CONNECT_API_ISSUER_ID:?Set the notarization API issuer ID.}"
[[ -f "$APP_STORE_CONNECT_API_KEY_PATH" ]] || { echo 'Notarization key is unavailable.' >&2; exit 1; }

# The caller unlocks its signing keychain; no passwords enter this script or repository.
export CSC_NAME="$identity"
export CSC_IDENTITY_AUTO_DISCOVERY=true
npm run build
npx electron-builder --mac dir --arm64 --config.mac.notarize=false

app='release/mac-arm64/Electroscope.app'
codesign --verify --strict --deep "$app"
signature="$(codesign -dv --verbose=4 "$app" 2>&1)"
grep -Fq "Authority=Developer ID Application: $identity" <<< "$signature"
grep -Fq 'TeamIdentifier=23B7GTLBN7' <<< "$signature"

[[ "$(git rev-parse HEAD)" == "$revision" && -z "$(git status --porcelain)" ]] || {
  echo 'Source changed during the build; rebuild from a clean revision.' >&2; exit 1;
}
version="$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")"
out="release/Electroscope-$version-mac-arm64-${revision:0:7}"
[[ ! -e "$out.zip" ]] || { echo 'This release already exists.' >&2; exit 1; }
ditto -c -k --keepParent "$app" "$out-submission.zip"
xcrun notarytool submit "$out-submission.zip" \
  --key "$APP_STORE_CONNECT_API_KEY_PATH" \
  --key-id "$APP_STORE_CONNECT_API_KEY_ID" \
  --issuer "$APP_STORE_CONNECT_API_ISSUER_ID" \
  --wait --output-format json > "$out-notary.json"
node --input-type=module - "$out-notary.json" <<'JS'
import { readFileSync } from 'node:fs';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (result.status !== 'Accepted') throw new Error(`Notarization ${result.status}: ${result.id}`);
console.log(`Notarization accepted: ${result.id}`);
JS
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --strict --deep "$app"
spctl --assess --type execute --verbose=4 "$app"
ditto -c -k --keepParent "$app" "$out.zip"
printf 'Source: %s\n' "$revision" > "$out-manifest.txt"
stat -f 'Bytes: %z' "$out.zip" >> "$out-manifest.txt"
shasum -a 256 "$out.zip" >> "$out-manifest.txt"
cat "$out-manifest.txt"
