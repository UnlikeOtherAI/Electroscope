# What a USB microscope can actually be told to do

Most USB microscopes are plain UVC cameras. The browser engine Electroscope is built on
decides which of their controls an app can reach, and it is far less than the
[MediaStream Image Capture][spec] vocabulary suggests. This page records what is real, so
the window never shows a slider that does nothing.

## The short version

| Control | macOS | Windows 11 |
| --- | --- | --- |
| `zoom`, `pan`, `tilt` | Only on cameras with real UVC PTZ, and only when the USB video-control interface can be opened | Yes |
| `focusMode`, `focusDistance` | **Never** | Yes |
| `exposureMode`, `exposureTime`, `exposureCompensation` | **Never** | Yes |
| `brightness`, `contrast`, `saturation`, `sharpness` | **Never** | Yes |
| `whiteBalanceMode`, `colorTemperature` | **Never** | Yes |
| `iso`, `torch` | Never | Never |
| Resolution and frame rate | Yes | Yes |

Chromium reaches these controls through `IAMVideoProcAmp` and `IAMCameraControl` on
Windows (`media/capture/video/win/video_capture_device_mf_win.cc`). On macOS it goes
through IOUSBLib (`media/capture/video/mac/uvc_control_mac.mm`), where
`UvcControl::GetControlSupport()` only ever reports **zoom, pan and tilt** — the other UVC
selectors are defined but never surfaced — and even those need `USBInterfaceOpen` to
succeed on a camera the system's own UVC driver has already claimed. `iso` has no mapping
on either platform and `torch` is hardcoded off, so Electroscope does not offer them at all.

## Measured on real hardware

On a Mac (Electron 45 / Chromium), two USB cameras, including the microscope this app was
built for:

- **GENERAL - UVC (1b3f:2002)**, a Generalplus-chipset microscope, max 1280×720 —
  `getCapabilities()` returns only `aspectRatio, deviceId, facingMode, frameRate, groupId,
  height, resizeMode, width`. **No image controls at all.**
- **UGREEN Camera 4K (eba4:6579)**, max 4000×3000 — the same: no image controls.

`ImageCapture.getPhotoCapabilities()` adds nothing beyond image width and height.

## What Electroscope does about it

1. **It offers only controls the camera really obeys.** The listed controls are filtered to
   those Chromium reports, and then each numeric one is nudged once when the camera opens
   and put back. Cheap UVC cameras commonly accept a setting and ignore it; those are
   marked `responsive: false`, hidden in the window, and reported as such to agents.
2. **It says why when there are none,** instead of silently showing an empty panel.
3. **It does brightness, contrast and saturation itself.** The Picture panel, and the
   `set_image_adjustments` tool, apply to the live view and to every captured image, so
   they work on every camera on both platforms. `focus_score` and `brightness` in capture
   metadata are measured *before* these adjustments, so they still describe what the sensor
   delivered.

Focus on these microscopes is mechanical: turn the ring. The live focus meter in the window
is there for exactly that — turn until it peaks.

[spec]: https://w3c.github.io/mediacapture-image/
