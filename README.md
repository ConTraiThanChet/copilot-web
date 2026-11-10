# Copilot Web

Run the **GitHub Copilot desktop app** in a regular browser. On a Codespace (or
any Linux host), Copilot Web starts only the Copilot backend and a small web
server. The backend runs headless: it gets no visible window, and the full
React UI is not loaded on the host. You then use the complete app UI (sessions,
subagents, images, browser preview, canvases, terminal, settings) from any
browser, including through the Codespaces port forwarding URL.

> This repository contains only tooling. The app itself is downloaded from the
> official release (`github/app`) at install time, and its web frontend is
> extracted locally. Neither is committed here.

## Quick start

Run this in any Codespace (or Linux machine) terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/ConTraiThanChet/copilot-web/main/setup.sh | bash
```

The script will:

1. download the latest GitHub Copilot desktop app (Linux AppImage, x64 or arm64);
2. extract and patch the web UI, install the dependencies it needs (Xvfb,
   xdotool, gnome-keyring, …), and build the relay;
3. enable **autostart**, so Copilot Web starts whenever the codespace opens;
4. start Copilot Web and print its URL, for example
   `https://<codespace>-8787.app.github.dev/`.

Running the same command again updates Copilot Web and the app.

Options: `... | COPILOT_WEB_PASSWORD=secret COPILOT_WEB_PORT=8787 bash`, or pass
`bash -s -- --no-start` / `--no-autostart`.

### Codespace for this repository

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/ConTraiThanChet/copilot-web)

Opening a codespace on this repository sets everything up automatically. Port
8787 opens in the browser when it is ready.

### From a private copy (e.g. GitHub Enterprise)

```bash
gh repo clone <owner>/copilot-web ~/copilot-web && ~/copilot-web/setup.sh
```

`setup.sh` uses the checkout it runs from. Set `COPILOT_WEB_REPO` to make
`curl … | bash` installs clone from your copy.

### Signing in

The first time you open the web UI, sign in the same way as in the desktop app:

* **Continue as @user**: if the host already has GitHub credentials (for
  example a `gh auth login` session on the codespace), the app offers to reuse
  them.
* **Use a different account / GitHub Enterprise (\*.ghe.com)**: the device
  sign-in page opens in a new browser tab. Approve it there, then return to the
  web UI.

Credentials are stored on the host, in its keyring and `~/.copilot`, and are
shared with the desktop app if it runs on the same host.

### Security

Keep the Codespaces port **Private** (the default); GitHub then requires your
sign-in to reach it. Anyone who can open the URL controls Copilot on that host.
On other hosts, set `COPILOT_WEB_PASSWORD` or put Copilot Web behind your own
authentication.

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
* **Lazy session history:** for long sessions the backend would otherwise
  stream the complete history (it can be gigabytes) through the tunnel.
  `server/history-proxy.mjs` sends the browser only the recent tail, captures
  the full history into a local cache, and serves older pages of the main
  conversation as you scroll up. Use **Load complete history** in the app to
  get every subagent detail. The proxy also acknowledges history frames
  locally and compresses traffic to the browser. Stale "queued message
  recovery" records, which force a full history load, are dropped at startup.
* **Native views:** the agent browser preview and extension canvases are native
  webviews on the host. The server captures them with the app's own
  screenshot command, sending a frame only when the content changes. The
  browser draws each frame at the bounds the app requested. Mouse, wheel,
  keyboard, and pasted or IME text (Vietnamese Telex included) are replayed
  into the view as real X input with `xdotool`.
* **Display/keyring:** the backend runs on its own Xvfb display, with a private
  D-Bus session and gnome-keyring for stored credentials.

## Commands

| Command | Description |
|---|---|
| `copilot-web install [--appimage PATH\|URL] [--latest]` | Get the app (downloads the latest release if needed) and build the web app |
| `copilot-web update` | Download the latest app release, rebuild, and restart |
| `copilot-web start [--port N] [--password P] [--replace]` | Start the backend and the web server (`--replace` stops a running desktop app) |
| `copilot-web stop` / `restart` | Stop / restart everything |
| `copilot-web status` / `url` | Status and web URL |
| `copilot-web logs [backend\|server] [-f]` | Logs |
| `copilot-web autostart enable\|disable` | Start when the codespace opens or a shell starts |

Data lives in `~/.copilot` (shared with the desktop app) and
`~/.local/share/copilot-web`. Codespaces keep the home directory across
stop/start, but a **rebuild** resets it.

Requirements: Linux x86_64 or arm64, Node.js 20+. On Debian or Ubuntu,
`install` adds Xvfb, xdotool, dbus-x11, gnome-keyring, and gcc with apt.

## Limitations

* The first scroll-up in a long session after the web server starts waits
  until the history cache is built. The cache lives in `/tmp` (on Codespaces a
  local scratch disk that is not exported on shutdown) and is rebuilt after a
  restart.

* Native views (browser preview and extension canvases) are streamed as images.
  They update a few times per second when their content changes. Text inside
  them cannot be selected from your browser, and the image follows the
  browser's zoom level.
* Folder pickers ask for a path on the host instead of opening a native dialog.
* Global keyboard shortcuts, tray, and dock integrations are disabled.
