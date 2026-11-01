# GitHub releases

Push a version tag after its changes have merged to `main`. The tag must match `package.json` exactly:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The **Release** GitHub Actions workflow builds and tests both apps on GitHub-hosted Windows and Mac runners. It publishes these stable filenames, which the README download buttons follow through `releases/latest/download/`:

- `Electroscope-Windows-x64-Setup.exe`
- `Electroscope-Windows-x64-Portable.exe`
- `Electroscope-macOS-arm64.dmg`
- `Electroscope-macOS-arm64.zip`
- `SHA256SUMS.txt`

Windows executables and installers use the existing UnlikeOtherAI Azure Artifact Signing Public Trust profile. Each signature must be valid, timestamped, and match the legal publisher and profile-specific EKU. The NSIS installer is installed on the runner; the installed app runs the full synthetic-camera end-to-end suite.

The Mac app uses the UnlikeOtherAI Developer ID Application identity, hardened runtime, and Apple notarization. The workflow extracts the final ZIP, verifies its signature, stapled ticket, and Gatekeeper acceptance, then runs the packaged app's synthetic-camera suite. It also mounts and verifies the app inside the DMG. Hosted tests use a synthetic camera; they do not claim physical-microscope verification.

Publication waits for both platform jobs. It requires exactly the four expected download files, generates SHA-256 checksums, stages a draft release, uploads every asset, and only then makes the release public. Build, test, signing, or upload failures leave the new release unpublished. Rerunning can resume an unpublished draft; it refuses to replace an already published release. The final step downloads every asset through its public URL without authentication and checks its SHA-256 against the manifest.

## Signing configuration

The GitHub `release` environment permits only `v*` tags. The source validation job also requires the tagged commit to belong to `main` and match the package version. Pull requests and manual branch runs cannot reach signing credentials. Actions are pinned to commit SHAs.

Environment secrets:

- `MAC_CERTIFICATE_P12`: base64-encoded Developer ID certificate and private key.
- `MAC_CERTIFICATE_PASSWORD`: encryption password for that P12.
- `APPLE_API_KEY`: App Store Connect notarization key contents.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: its identifiers.

Environment variables:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
- `WINDOWS_ARTIFACT_SIGNING_ENDPOINT`, `WINDOWS_ARTIFACT_SIGNING_ACCOUNT`, `WINDOWS_ARTIFACT_SIGNING_PROFILE`.
- `WINDOWS_SIGNER_EKU`: the profile-specific enhanced key usage.

Electroscope uses its own Azure managed identity, federated only to `repo:UnlikeOtherAI/Electroscope:environment:release`, with the certificate-profile signer role on the existing profile. It does not reuse Nessie's federated identity or alter Nessie's release environments. Windows private signing keys are held by Azure; no PFX is required.

Keys are configured through GitHub environment secrets, never through committed files or workflow logs. The Mac runner writes the notarization key to a temporary owner-only file and removes it when the job finishes. Electron Builder imports the certificate into a temporary keychain.

To rerun a failed release, use **Re-run failed jobs** in Actions, or dispatch **Release** with the existing version tag selected. Tags and published artifacts should not be moved or overwritten; use a new patch version for corrections.

The [manual Mac guide](macos-release.md) remains available for local signed builds and physical-camera checks.
