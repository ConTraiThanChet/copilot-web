# Copilot Web

Run the **GitHub Copilot desktop app** in a regular browser. On a Codespace (or
any Linux host), Copilot Web starts only the Copilot backend and a small web
server. The backend runs headless: it gets no visible window, and the full
React UI is not loaded on the host. You then use the complete app UI (sessions,
subagents, images, canvases, terminal, settings) from any browser, including
through the Codespaces port forwarding URL.

> This repository contains only tooling. The app itself (its binary and web
> frontend) is extracted at install time from your own copy of the official
> GitHub Copilot AppImage, and is never committed here.

## How it works

```
 Browser ──HTTPS──► Codespaces port 8787 ──► copilot-web server (Node)
   │                                            │  static UI (extracted from the AppImage)
   │  /__ws      backend WebSocket  ───────────►│──► Copilot backend (Rust, headless, Xvfb)
   │  /__bridge  Tauri IPC (invoke/events) ────►│──► relay.js in the backend's hidden webview
```

* **Frontend:** `lib/extract-assets.mjs` reads the asset table that Tauri embeds
  in `usr/bin/github` and decompresses it. `lib/patch-web.mjs` routes the
  backend WebSocket through the server and loads `web/copilot-web.js`.
* **Tauri IPC in the browser:** `web/copilot-web.js` implements
  `window.__TAURI_INTERNALS__` (invoke, callbacks, channels, events). Calls are
  forwarded to the real backend, so app features behave as they do on the
  desktop. A few calls act on your browser instead of the host: opening links,
  file pickers (files are uploaded to the host), clipboard, notifications, and
  window controls.
* **Headless backend:** `native/relay-inject.so` (`LD_PRELOAD`) does two
  things in the app's webview:
  * it appends `native/relay.js` to Tauri's IPC init script;
  * it loads the empty `/blank.html` instead of the app UI.

  The webview only hosts the IPC relay, which keeps memory use low.
* **Native views:** the agent browser preview and extension canvases are native
  webviews on the host. The server captures them with the app's own
  screenshot command, sending a frame only when the content changes. The
  browser draws each frame at the bounds the app requested. Mouse, wheel,
  keyboard, and pasted or IME text (Vietnamese Telex included) are replayed
  into the view as real X input with `xdotool`.
* **Display/keyring:** the backend runs on its own Xvfb display, with a private
  D-Bus session and gnome-keyring for stored credentials.

## Install on a Codespace

```bash
git clone https://daengboost.ghe.com/WWM/copilot-web ~/copilot-web
~/copilot-web/bin/copilot-web install --appimage ~/apps/GitHub-Copilot.AppImage   # path or URL
~/copilot-web/bin/copilot-web start
```

Without `--appimage`, `install` looks in `~/apps`, `~/Applications`,
`~/.local/bin`, and `~/Downloads`. To copy an AppImage from your machine:

```bash
gh codespace cp -c <codespace> ./GitHub-Copilot-linux-x64.AppImage 'remote:~/apps/GitHub-Copilot.AppImage'
```

Open the printed URL, for example
`https://<codespace>-8787.app.github.dev/`. Keep the port **Private**:
Codespaces then requires your GitHub sign-in. For extra protection, add
`--password <secret>`.

If the desktop app is already running on that host, stop it, or run
`copilot-web start --replace`. Both use the same `~/.copilot` data, so your
sessions, projects, and settings carry over.

## Commands

| Command | Description |
|---|---|
| `copilot-web install [--appimage PATH\|URL]` | Extract the AppImage, build the web app and relay |
| `copilot-web start [--port N] [--password P] [--replace]` | Start backend and web server |
| `copilot-web stop` / `restart` | Stop / restart everything |
| `copilot-web status` / `url` | Status and web URL |
| `copilot-web logs [backend\|server] [-f]` | Logs |
| `copilot-web autostart enable\|disable` | Start when a shell opens (survives Codespace restarts) |

To update the app, run `install` again with the new AppImage, then `restart`.

Requirements: Linux x86_64, Node.js 20+, Xvfb, xdotool, dbus-x11, gnome-keyring, gcc.
On Debian or Ubuntu, `install` installs missing packages with apt.

## Limitations

* Native views (browser preview and extension canvases) are streamed as images.
  They update a few times per second when their content changes. Text inside
  them cannot be selected from your browser, and the image follows the
  browser's zoom level.
* Folder pickers ask for a path on the host instead of opening a native dialog.
* Global keyboard shortcuts, tray, and dock integrations are disabled.
