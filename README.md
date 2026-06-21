# Filedrop

A tiny, tray-resident app for sending files **directly between your own devices** on the
same network — Windows ⇆ Arch Linux (and any other Linux/macOS). No cloud, no accounts,
no size limits. Multi-GB files stream straight from disk to disk and **resume** if the
connection drops.

It lives in your system tray. Click the tray icon and a small panel pops up with two tabs:

- **Devices** — everyone running Filedrop on your LAN shows up automatically. Pick files
  (button or drag-and-drop), click a device, done. The other side gets an Accept/Decline
  prompt.
- **Settings** — start on login, hide IP addresses, stealth (invisible) mode, device name,
  and download folder.

## How it works (short version)

| Concern        | Approach                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| Discovery      | UDP multicast on your LAN — devices announce themselves by name.        |
| Transfer       | HTTPS, streamed in chunks (constant memory), resumable.                 |
| Security       | Self-signed TLS per device; the receiver's fingerprint is **pinned** by the sender, so traffic can't be intercepted. Every incoming transfer must be **accepted**. |
| Hide IPs       | The UI shows device names only and never displays raw IPs.              |
| Stealth        | Stop broadcasting — others can't discover you, but you can still send and can be reached by address. |
| Auto-start     | Windows login item / Linux XDG autostart (`~/.config/autostart`). Boots to the tray. |

Ports used: **UDP 53318** (discovery) and **TCP 53319+** (transfer). Open these in your
firewall on the *local/private* network if prompted.

## Run from source

```bash
npm install
npm run icon      # generates build/icon.png (also run automatically by the dist scripts)
npm start
```

> On **GNOME**, the system tray needs the
> [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/).
> KDE, XFCE, Cinnamon, etc. work out of the box.

## Build downloadable apps

```bash
npm run dist:win     # -> dist/Filedrop-1.0.0-portable.exe  + NSIS installer
npm run dist:linux   # -> dist/Filedrop-1.0.0.AppImage      + Arch pacman package
```

- **Windows:** the `*-portable.exe` is a single file — download and double-click, no install.
- **Arch Linux:** `sudo pacman -U filedrop-*.pacman`, or just `chmod +x *.AppImage && ./Filedrop-*.AppImage`.

### Automated builds

Push a tag (`git tag v1.0.0 && git push --tags`) and the included GitHub Actions workflow
(`.github/workflows/build.yml`) builds Windows + Linux artifacts and attaches them to a
GitHub Release — that's your "just download it" link.

## Using it

1. Open Filedrop on both machines (same Wi-Fi/LAN).
2. On the sender: click the tray icon → **Choose files…** (or drag files onto the window).
3. Click the target device.
4. On the receiver: **Accept** the prompt. Files land in your download folder.

To reach a device in **stealth** mode, use **+ by address** on the Devices tab and enter its
local IP.

### Chat & calls

- Click a device to open a **chat** (history is saved per device).
- In a chat, hit **📞 Call** for a voice call. In the call window you can **mute**, **deafen**,
  toggle your **camera**, and **share your screen** (pick a screen/window, choose **FPS** and
  **quality**, adjustable live). The other side gets an Accept/Decline ring.

## Auto-update

Installed builds check a **GitHub Releases** feed and update themselves. The flow you ship:

1. **One-time:** create a public GitHub repo and set it in two places — `publish:` in
   `electron-builder.yml` and `homepage`/`repository` in `package.json` (currently
   `vkavelashvili/filedrop` — change to yours). Push the code.
2. **Every release:** make your changes, bump the version (`npm version patch` → e.g. 1.1.1),
   and push the tag:
   ```bash
   npm version patch
   git push --follow-tags
   ```
   GitHub Actions builds Windows + Linux and uploads the installers **and the update metadata**
   (`latest.yml` / `latest-linux.yml`) to a **draft** GitHub Release. Open the release on GitHub
   and click **Publish**.
3. Every installed app then notices the new version (on launch, every 6 h, or instantly if a peer
   on your LAN is already newer), shows an **“Update available”** banner + notification, and on
   **Update now** downloads it and relaunches into the new version.

Notes:
- Auto-update needs the **installer** (`Filedrop Setup …exe`) on Windows or the **AppImage** on
  Linux. The portable `.exe` and the Arch `.pacman` don't self-update.
- The build is unsigned, so the very first install shows a SmartScreen warning, but updates are
  still integrity-checked (electron-updater verifies each download's SHA-512 against `latest.yml`).
- `Settings → Updates → Check` forces a check any time.

## License

MIT
