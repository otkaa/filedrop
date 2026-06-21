'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

/**
 * Cross-platform "start on login".
 *
 *  - Windows/macOS: Electron's native login-item API.
 *  - Linux: write an XDG autostart .desktop file (handles AppImage too).
 *
 * In every case we pass --hidden so the app boots straight to the tray.
 */

function isLinux() {
  return process.platform === 'linux';
}

function linuxAutostartFile() {
  const dir = path.join(os.homedir(), '.config', 'autostart');
  return { dir, file: path.join(dir, 'filedrop.desktop') };
}

function linuxExecPath() {
  // AppImage exposes its own path via APPIMAGE; otherwise use the binary.
  return process.env.APPIMAGE || process.execPath;
}

function setEnabled(enabled) {
  try {
    if (isLinux()) {
      const { dir, file } = linuxAutostartFile();
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        const exec = linuxExecPath();
        const content = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Filedrop',
          'Comment=LAN file transfer',
          `Exec="${exec}" --hidden`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          'Categories=Utility;',
          '',
        ].join('\n');
        fs.writeFileSync(file, content);
      } else {
        try {
          fs.unlinkSync(file);
        } catch (_) {}
      }
      return true;
    }

    // Windows / macOS. For the Windows *portable* build, process.execPath is a
    // temp-extraction path that's deleted on exit; PORTABLE_EXECUTABLE_FILE is
    // the real on-disk .exe, so register that instead (mirrors the AppImage
    // handling above). It's unset for installed/NSIS builds, where execPath is
    // already the stable location.
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      args: ['--hidden'],
    });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[autostart] failed:', err.message);
    return false;
  }
}

function isEnabled() {
  try {
    if (isLinux()) {
      return fs.existsSync(linuxAutostartFile().file);
    }
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
}

module.exports = { setEnabled, isEnabled };
