# macOS release

The Mac app uses the same viewer and MCP implementation as Windows. Build on an Apple Silicon Mac with Node 24 and the UnlikeOtherAI Developer ID Application certificate (team `23B7GTLBN7`). Camera permission is requested by macOS when the app first opens a camera.

Install dependencies with `npm ci`, then run `npm run typecheck`, `npm test`, `npm run build`, and `node scripts/e2e.mjs --fake`.

Unlock the existing signing keychain and set `CSC_KEYCHAIN` to its path if it is outside the default keychain search list. Load the protected notarization environment into the shell; it must define `APP_STORE_CONNECT_API_KEY_PATH`, `APP_STORE_CONNECT_API_KEY_ID`, and `APP_STORE_CONNECT_API_ISSUER_ID`. Keep credentials outside the repository and disable shell tracing. From a clean committed worktree, run:

```sh
bash scripts/release-macos.sh
```

The script builds an arm64 app, verifies the UnlikeOtherAI signature, submits it to Apple, staples the accepted ticket, checks Gatekeeper, and writes a ZIP, source revision, byte count, and SHA-256 under `release/`. It does not upload or publish the package.

Test the signed app with the physical microscope, using its camera-list label:

```sh
ELECTROSCOPE_EXE="$PWD/release/mac-arm64/Electroscope.app/Contents/MacOS/Electroscope" \
  ELECTROSCOPE_CAMERA='GENERAL - UVC' node scripts/e2e.mjs
```

Allow camera access in the macOS prompt. The suite selects the named camera and checks the live viewer, all MCP tools, drawing with Command-Z, image pixels, and saving full-resolution photos. It writes screenshots and captures to `test-output/real/`. Synthetic-camera checks are separate from physical-camera verification.

Copy the verified app to `/Applications/Electroscope.app`, then repeat the hardware suite with `ELECTROSCOPE_EXE` pointing inside the installed bundle. Launch the installed app normally and select the microscope; the choice persists across launches. Keep release artifacts and test evidence outside disposable worktrees before cleanup.
