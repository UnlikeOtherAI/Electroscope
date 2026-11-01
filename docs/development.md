# Develop Electroscope

Use Node 24. The Windows and Mac apps share the viewer and MCP server.

```sh
git clone https://github.com/UnlikeOtherAI/Electroscope.git
cd Electroscope
npm ci
npm start
```

```sh
npm run typecheck
npm test
npm run test:e2e              # real camera
node scripts/e2e.mjs --fake  # synthetic camera, after npm run build
npm run icons
```

The end-to-end suite drives the app through its UI and MCP endpoint, checks annotation pixels, and writes screenshots and captured images to `test-output/`. `ELECTROSCOPE_EXE` selects a packaged executable; `ELECTROSCOPE_CAMERA` selects a physical camera by label.

- `src/main`: Electron process, camera-command bridge, and MCP server.
- `src/renderer`: live camera, viewer, annotations, and command handlers.
- `src/shared`: types, IPC channel names, and the agent prompt.

`npm run dist:win` and `npm run dist:mac` create local development packages. Public downloads use the signed [release workflow](releases.md). The [manual Mac release guide](macos-release.md) covers a local signed build and physical-microscope checks.
