# Camera permission on macOS

A camera macOS has not released does not fail. It succeeds, and then sends nothing.

```
getUserMedia({ video: { deviceId } })   ->  resolves
track.readyState                        ->  "live"
track.muted                             ->  false
track.getSettings()                     ->  { width: 1280, height: 720, frameRate: 30 }
video.videoWidth                        ->  0, forever
```

Reading the track directly with `MediaStreamTrackProcessor` — no `<video>` element in the way —
produces zero `VideoFrame`s as well, so nothing in the web platform can tell this apart from a
microscope with its light switched off. Measured on macOS 27 with Electron 45.2.1 (Chromium 156)
against two UVC cameras, at every resolution each one advertises.

The same cameras deliver frames immediately once `systemPreferences.getMediaAccessStatus('camera')`
reads `granted`.

## What Electroscope does about it

At startup the main process reads the status and, when it is `not-determined`, asks for access
without making the window wait on the answer (`src/main/permissions.ts`). The result reaches the
renderer over `IPC.cameraAccess`, and the panel over the picture says which of the two situations
the black rectangle is:

| State | What the window says |
| --- | --- |
| `granted` | nothing; the picture arrives |
| `asking` | waiting for you to allow camera access |
| `denied` | the OS is blocking it, with a button to the privacy pane |
| `undecided` | macOS never asked, with a button to the privacy pane |
| `unknown` | nothing up front — Windows rejects `getUserMedia` outright, which is already explained |

While access is blocked the automatic reopen loop stands down. Cycling a camera the OS will not
release only wears out the message.

## Why `npm start` goes through `open`

macOS attributes a permission request to the process **responsible** for the launch, not to the
binary that makes it. Spawn Electron from a shell and the shell is responsible — it can hold no
camera grant, so macOS declines to show the prompt at all: `askForMediaAccess` returns `false`
immediately and leaves the status at `not-determined`.

Measured, stock `node_modules/electron`, nothing re-signed:

| How it was launched | `askForMediaAccess` | Frames |
| --- | --- | --- |
| `electron .` from a shell | `false`, no prompt | 0 |
| `open -n Electron.app --args <root>` | prompt shown, `true` | ~24 fps |

So `npm start` runs `scripts/start.mjs`, which uses `open` on macOS and spawns the binary directly
everywhere else. `open` opens the output path itself, so an inherited pipe such as `/dev/stdout`
fails the launch with `-10810`; the script points it at a temporary file and tails that, which
keeps the console log in the terminal. A granted permission does **not** rescue a shell launch afterwards: the grant
belongs to the app, while attribution still lands on the shell.

Re-signing the development build is not needed. The ad-hoc, linker-signed bundle npm downloads
prompts correctly once launchd is responsible for it.

Packaged builds are unaffected — Finder and launchd start them — and `build/entitlements.mac.plist`
plus the `NSCameraUsageDescription` in `package.json` already carry what the prompt needs.

The end-to-end suite uses Chromium's synthetic camera, which needs no permission, so none of this
applies to it.
