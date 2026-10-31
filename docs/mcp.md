# Electroscope MCP reference

Electroscope runs an MCP server inside the app, over Streamable HTTP, on `http://127.0.0.1:47821/mcp`.
If that port is taken it tries the next nine; the live address is always shown in the app. You can change the port in Settings.

The app owns the camera. Claude never opens it, so the live view in the window keeps running while Claude asks for stills.

## Connect a client

```bash
# Claude Code
claude mcp add --transport http electroscope http://127.0.0.1:47821/mcp
```

Any client that speaks Streamable HTTP can use the same URL. For clients that only launch local stdio servers (Claude Desktop), bridge it:

```json
{
  "mcpServers": {
    "electroscope": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:47821/mcp"] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Active camera, resolution, fps, orientation, live focus score, adjustable controls with ranges, and whether the human has paused Claude. Works even while paused. |
| `list_cameras` | Rescans and lists every camera on the machine. Works even while paused. |
| `capture_snapshot` | One still frame, returned as an image plus metrics and hints. |
| `capture_sequence` | 2-6 frames at a fixed interval, to watch an LED blink or a part heat up. |
| `select_camera` | Switch the live view to another camera, optionally at a given resolution. |
| `set_camera_controls` | Set focus, zoom, exposure, brightness and so on, where the camera supports them. |
| `set_orientation` | Rotate (0/90/180/270) and/or mirror. Affects the human's view and Claude's captures. |
| `get_shared_frames` | Frames the human pinned with **Share with Claude**, with their notes. |

### `capture_snapshot` arguments

| Argument | Default | Meaning |
| --- | --- | --- |
| `camera` | active camera | Camera id or part of its name. A non-active camera is opened just long enough for one frame. |
| `max_width` | 1280 | Longest-edge budget in pixels (160-3840). Never upscales. |
| `format` | `jpeg` | `jpeg` or `png`. |
| `quality` | 85 | JPEG quality (30-100). |
| `region` | whole frame | `{x, y, width, height}`, normalised 0..1 in the oriented frame. The crop is taken from the full-resolution frame, so a small region is a real close-up, not an upscale. |
| `follow_user_view` | false | Capture exactly the area the human has zoomed and panned to in the window. Overrides `region`. |

The text part of the result carries:

- `focus_score`: variance of the Laplacian on a normalised copy of the image. Higher is sharper. Compare scores of the same scene, not across scenes.
- `brightness` (0-255), `overexposed_fraction`, `underexposed_fraction`.
- `source_resolution`, `region`, `orientation`, `captured_at`, `saved_to` (the file on disk).
- `hints`: plain-language warnings such as blown highlights, a dark image, or very low focus.

### Controls

`get_status` lists the controls the camera exposes, for example `focusMode`, `focusDistance`, `zoom`, `exposureMode`, `exposureTime`, `brightness`, `contrast`, `saturation`, `sharpness`, `colorTemperature`, `torch`. Setting a manual value (`focusDistance`, `exposureTime`, `colorTemperature`) switches the matching mode to manual first.

Many inexpensive UVC microscope cameras accept a control without applying it. Electroscope reads the value back; if the camera ignored the change, the tool reports that in `rejected` and marks the control `"responsive": false` in `get_status`.

## What the human controls

- **Claude access** switch (also the pill in the title bar). When off, every tool except `get_status` and `list_cameras` returns an error telling Claude to ask the human to resume.
- **Claude's view** strip lists every frame Claude captured, with time, camera and size. Click a frame to open the saved file. A coral ring and flash show on the live view whenever Claude captures.
- **Share with Claude** pins the current frame (or the zoomed view) with a note. Claude picks it up with `get_shared_frames`.

## Security model

- The server binds to `127.0.0.1` only.
- Requests whose `Host` is not localhost, or whose `Origin` is not a localhost origin, get `403`. This blocks DNS-rebinding and drive-by requests from web pages.
- Only the app's bundled page can use the camera. The renderer is sandboxed with context isolation and a strict content security policy.
- Claude's captures are saved under the app data folder (`%APPDATA%\Electroscope\captures` on Windows) and pruned to the newest 200. Frames you shared are kept separately. Photos you save yourself go to `Pictures\Electroscope`.
- There is no authentication token. Anything running as you on this machine can reach the port. Pause Claude access when you do not want frames available.
