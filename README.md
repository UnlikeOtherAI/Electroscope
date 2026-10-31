# Electroscope

<p align="center"><img src="build/icon-256.png" alt="Electroscope icon" width="128" /></p>

A live viewer for your electronics microscope that Claude can look through, over MCP.

A camera can usually be opened by one app at a time. If you are watching the microscope, Claude cannot also have a stream. Electroscope owns the camera, shows you the live view in a native window, and hands Claude still frames only when it asks. You keep looking at your board; Claude can still look at it too.

![Electroscope showing an ESP32 module, with the frames Claude has captured](docs/screenshot.png)

## What you get

- **Live view** with wheel-zoom, drag-pan, grid and crosshair overlays, freeze, rotate and mirror, and a live **sharpness meter** to find best focus.
- **Every camera on the machine**, listed and switchable. Hardware controls (focus, zoom, exposure and so on) appear when the camera supports them.
- **An MCP server** with tools to capture a frame, take a sequence, crop a full-resolution close-up of any region, look at exactly what you have zoomed to, and adjust the camera.
- **Visible and in your control.** A switch pauses Claude's access. Every frame Claude takes shows up in a strip under the viewer, and the live view flashes when it captures.
- **Share with Claude**: pin a frame with a note ("U3 gets hot right after power-on") and ask Claude to look at it.

## Install and run

Electroscope is an Electron app. Windows 11 is the primary target; macOS builds from the same code.

```bash
git clone https://github.com/UnlikeOtherAI/Electroscope.git
cd Electroscope
npm install
npm start
```

Then connect Claude Code:

```bash
claude mcp add --transport http electroscope http://127.0.0.1:7821/mcp
```

Ask Claude something like "look at the board under the microscope and tell me if the solder joints on U2 look bridged". See [docs/mcp.md](docs/mcp.md) for the tools, arguments and security model, and for connecting other clients.

If the app says the camera is busy, another program has it. Close the Windows Camera app, Teams, or a browser tab using the camera. Electroscope keeps retrying and connects as soon as it is free.

### Build a package

```bash
npm run dist            # unpacked app in release/win-unpacked
npm run dist:installer  # NSIS installer and portable exe
```

Builds are unsigned.

## Develop

```bash
npm run typecheck
npm test                # unit tests for the MCP server, transport, settings and bridge
npm run test:e2e        # launches the app and drives it over MCP with your real camera
node scripts/e2e.mjs --fake   # same, with Chromium's synthetic camera (what CI runs)
npm run icons           # re-render build/icon.* from build/icon.svg
```

The end-to-end script writes the app window and every image Claude would receive to `test-output/`.

How it fits together:

- `src/main`: Electron main process and the MCP server (`mcp/tools.ts` defines the tools, `mcp/http.ts` is the Streamable HTTP transport).
- `src/renderer`: the window. It owns the camera, draws the live view, and answers capture and control requests from the main process.
- `src/shared`: types and IPC channel names used by both.

## Status

Tested on Windows 11 with a UVC microscope camera (end to end over MCP, 16 checks) and with the synthetic camera. The macOS build is configured but has not been run on a Mac yet.

## License

[MIT](LICENSE)
