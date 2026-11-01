# Electroscope MCP reference

Electroscope serves MCP over Streamable HTTP at `http://<ip>:7821/mcp`. The exact address is in the app's title bar; **Copy prompt for agent** puts it, with connection instructions and the tool list, on your clipboard.

If the port is taken it tries the next nine, then any free port. The default is 7821 and can be changed in Settings. `GET /health` returns `{"name":"electroscope","ok":true}`.

The app owns the camera and a human may be watching the same live view, so agents never open the camera themselves: they ask for still frames and drive the app's controls.

## Connect a client

```bash
claude mcp add --transport http electroscope http://<ip>:7821/mcp   # Claude Code
```

Any client that supports remote HTTP MCP servers can use the URL. For clients that only start local stdio servers:

```json
{ "mcpServers": { "electroscope": { "command": "npx", "args": ["-y", "mcp-remote", "http://<ip>:7821/mcp"] } } }
```

## Coordinates

Positions are normalised **0..1 in the oriented frame**: `x` across, `y` down, `(0,0)` top-left, after any rotation or mirroring. Capture `region`s, marks, and the view centre all use them, so an agent can look at a frame and then point at exactly what it saw. Sizes are fractions of the frame width unless noted.

## Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Active camera, resolution, fps, orientation, view (zoom, centre, overlays, colours, frozen), current marks, live focus score, the picture adjustments, and every camera control with its range. Controls marked `responsive: false` are accepted by the camera but do nothing. When there are none, `controls_note` says why. |
| `list_cameras` | Rescan and list every camera. |
| `select_camera` | Switch the live view to another camera, optionally at a resolution. Clears marks. |
| `capture_snapshot` | One still image plus metrics and hints. |
| `capture_sequence` | 2-6 frames at an interval (default `max_width` 800). |
| `save_photo` | Save a full-resolution PNG in `Pictures/Electroscope` on the computer running Electroscope; returns the path, no image. |
| `set_camera_controls` | Set focus, zoom, exposure, brightness and so on — **only where the camera and platform really support it**, which is often nowhere; see [camera controls](camera-controls.md). Setting a manual value (`focusDistance`, `exposureTime`, `colorTemperature`) switches the matching mode to manual first. Anything the camera ignores comes back in `rejected`. |
| `set_image_adjustments` | Brightness, contrast and saturation, done by Electroscope rather than the camera, so they work everywhere. 1 is the camera's own picture; 0.25-2.5 allowed. Changes the window and every capture, but not `focus_score` or `brightness` in capture metadata. |
| `set_orientation` | Rotate 0/90/180/270 and mirror. Affects the window and captures. Clears marks. |
| `set_view` | Zoom (1-12), pan (`center_x`, `center_y`), `grid`, `crosshair`, `grid_color`, `crosshair_color` (any CSS colour), `frozen`. Captures always read the live camera, even while frozen. |
| `annotate` | Draw marks on the live view (below). |
| `clear_annotations` | Remove marks by `ids`, or all of them. |

### `capture_snapshot` and `save_photo` arguments

| Argument | Default | Meaning |
| --- | --- | --- |
| `camera` | active camera | Camera id or part of its name. A non-active camera is opened just long enough for one frame. |
| `max_width` | 1280 (`save_photo`: 8192) | Longest-edge budget in pixels, 160-3840. Never upscales. |
| `format` | `jpeg` (`save_photo`: `png`) | `jpeg` or `png`. |
| `quality` | 85 | JPEG quality, 30-100. |
| `region` | whole frame | `{x, y, width, height}`. Taken from the full-resolution frame, so a small region is a real close-up, not an upscale. |
| `follow_user_view` | false | Capture exactly the area the human has zoomed and panned to. Overrides `region`. |
| `include_annotations` | false | Burn the current marks into the image. |

Captures carry the picture adjustments set with `set_image_adjustments`; the metrics below are measured before them, so they always describe what the sensor sent.

The text result carries `focus_score` (variance of the Laplacian on a normalised copy; compare only within one scene), `brightness` (0-255), `overexposed_fraction`, `underexposed_fraction`, `source_resolution`, `region`, `orientation`, `captured_at`, `saved_to`, and `hints` such as blown highlights, a dark image, or very low focus.

### `annotate`

`annotate({annotations: [...]})` adds or replaces marks. Each mark:

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | all | `circle`, `crosshair`, `rect`, `arrow`, `text` |
| `id` | all | Optional. Reusing an id replaces that mark, so you can move or restyle it. |
| `x`, `y` | all | circle/crosshair: centre; rect: top-left; arrow: tail; text: left edge. |
| `radius` | circle | Fraction of frame width, default 0.04. |
| `size` | crosshair | Half-length of each arm, fraction of frame width, default 0.03. |
| `width`, `height` | rect | Fractions of the frame. |
| `to_x`, `to_y` | arrow | The point it points at. |
| `text`, `font_size` | text | The words; height as a fraction of frame height, default 0.04. |
| `label` | non-text | A caption beside the mark. |
| `color` | all | Any CSS colour: `"#ff3b30"`, `"red"`, `"rgb(0 200 255)"`. Default red. |
| `thickness` | all | Line width in thousandths of the frame width, default 3. |
| `fill` | circle, rect | Usually translucent: `"rgba(255,0,0,0.2)"`. |
| `background` | text, labels | Colour behind the words, default translucent black; `"none"` for none. |

Marks are drawn on the live view and stay on their feature when the human zooms or pans. They are cleared when the camera or orientation changes. Marks the human draws in the window are in the same list, so an agent sees them in `get_status` and can restyle or remove them. Invalid colours and out-of-range coordinates are rejected with a message saying what to fix.

## Security

- The server listens on every network interface by default so agents on other computers can reach it; turn this off in Settings to listen on `127.0.0.1` only. `ELECTROSCOPE_HOST` overrides the bind address.
- There is no authentication. Anyone who can reach the port can look through the camera and control it. Use a network you trust.
- Requests whose `Host` is not an IP address, `localhost`, or this computer's own name are refused (`403`), and requests carrying a cross-site `Origin` are refused. This blocks DNS-rebinding and drive-by requests from web pages.
- Only the app's bundled page can use the camera; the renderer is sandboxed with context isolation and a strict content security policy.
- Frames returned to agents are kept under the app data folder (newest 200). `save_photo` and **Save photo** write to `Pictures/Electroscope`.
