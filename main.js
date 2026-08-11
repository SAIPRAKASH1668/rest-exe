const { app, BrowserWindow, ipcMain, shell, Tray, Menu, powerSaveBlocker } = require('electron');
const path         = require('path');
const net          = require('net');
const fs           = require('fs');
const { execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');

const TCP_TIMEOUT_MS = 10_000;

// The order alarm must sound on a freshly booted, untouched machine — without
// this switch Chromium blocks audio until the first user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// A second launch (double-clicked shortcut while hidden in tray) must focus the
// existing window, not spawn a second polling instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function runPowerShellEncoded(script, timeout = 15000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execSync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { encoding: 'utf8', timeout }
  ).trim();
}

function escapePsSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

async function writeRawViaSpoolerByPort(portName, dataBuf) {
  const tempFile = path.join(app.getPath('temp'), `yumdude-raw-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  fs.writeFileSync(tempFile, dataBuf);

  const psPort = escapePsSingleQuoted(portName);
  const psFile = escapePsSingleQuoted(tempFile);
  const script = `
$ErrorActionPreference = 'Stop'
$port = '${psPort}'
$file = '${psFile}'

$printers = Get-Printer -ErrorAction SilentlyContinue |
  Where-Object { $_.PortName -eq $port } |
  Select-Object -ExpandProperty Name

if (-not $printers -or $printers.Count -eq 0) {
  throw "No printer mapped to port: $port"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RawPrinterHelper {
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFO di);

  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  static extern bool WritePrinter(IntPtr hPrinter, byte[] bytes, int count, out int written);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
    try {
      var di = new DOCINFO { pDocName = "YumDude Receipt", pDataType = "RAW" };
      if (!StartDocPrinter(hPrinter, 1, di)) return false;
      try {
        if (!StartPagePrinter(hPrinter)) return false;
        try {
          int written;
          return WritePrinter(hPrinter, bytes, bytes.Length, out written) && written == bytes.Length;
        } finally {
          EndPagePrinter(hPrinter);
        }
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($file)
$lastErr = $null
foreach ($printer in $printers) {
  try {
    $ok = [RawPrinterHelper]::SendBytesToPrinter($printer, $bytes)
    if ($ok) {
      "OK:$printer"
      return
    }
    $lastErr = "RAW spooler send returned false for printer: $printer"
  } catch {
    $lastErr = $_.Exception.Message
  }
}

throw "RAW spooler send failed on port $port. Last error: $lastErr"
`;

  try {
    const out = runPowerShellEncoded(script, 20000);
    console.log(`[Electron] USB spooler print OK → port ${portName} (${dataBuf.length} bytes) ${out}`);
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tempFile); } catch (_) {}
  }
}

function writeRawToDevicePath(portPath, dataBuf) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(portPath, { flags: 'w' });
    stream.on('error', reject);
    stream.write(dataBuf, (writeErr) => {
      if (writeErr) {
        stream.destroy();
        reject(writeErr);
        return;
      }
      stream.end(resolve);
    });
  });
}

// ── Load mode toggle ──────────────────────────────────────────────────────────
// Set to true  → loads https://yumdude.com  (requires deployed POV code)
// Set to false → loads the locally-built Angular bundle from dist/
const USE_REMOTE = true;
const REMOTE_URL = 'https://yumdude.com';
const LOCAL_FILE = path.join(__dirname, 'dist', 'yumdude-restaurant', 'browser', 'index.html');

const RECONNECT_INTERVAL_MS = 10_000;

let mainWindow;
let tray;
let isQuitting = false;
let reconnectTimer = null;

// Shown while the remote app is unreachable. Falling back to the stale local
// bundle would silently run an outdated app version, so retry the live URL
// instead.
const RECONNECT_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
  <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff8f0">
  <div style="text-align:center"><h2>YumDude Restaurant</h2>
  <p>Connection lost — reconnecting automatically…</p>
  <p style="color:#888">Check the internet connection if this persists.</p></div>
  </body></html>`);

function loadRemote() {
  if (!mainWindow) return;
  console.log('[Electron] Loading remote URL:', REMOTE_URL);
  mainWindow.loadURL(REMOTE_URL).catch((err) => {
    console.error('[Electron] Remote load failed:', err.message);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer || isQuitting || !mainWindow) return;
  mainWindow.loadURL(RECONNECT_PAGE).catch(() => {});
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    loadRemote();
  }, RECONNECT_INTERVAL_MS);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'YumDude Restaurant',
    icon: path.join(__dirname, 'src/assets/icons/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // A minimized/covered window must keep its 20s order poll and alarm
      // timers at full rate — Chromium throttles hidden windows otherwise.
      backgroundThrottling: false,
    },
  });

  // ── Intercept external links → open in system browser ───────────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── Load remote or local ───────────────────────────────────────────────
  if (USE_REMOTE) {
    loadRemote();

    // Network drop / DNS failure after launch → reconnect loop, not the stale
    // local bundle. Code -3 (ERR_ABORTED) fires on ordinary re-navigation and
    // must be ignored; subframe failures don't take the app down either.
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      console.error(`[Electron] Page load failed (${code}): ${desc} — ${url}`);
      scheduleReconnect();
    });
  } else {
    console.log('[Electron] Loading local build:', LOCAL_FILE);
    mainWindow.loadFile(LOCAL_FILE);
  }

  // Log when preload bridge is ready
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page loaded. printerAPI bridge active via preload.');
  });

  // ── Close-to-tray ────────────────────────────────────────────────────────
  // X must not kill order alerts; the app keeps running in the tray and only
  // the tray menu (or app update) really quits it.
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'src/assets/icons/icon.ico'));
  tray.setToolTip('YumDude Restaurant — watching for orders');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open YumDude Restaurant', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit (stops order alerts)',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showWindow);
}

// ── Auto-update ──────────────────────────────────────────────────────────────
// Restaurants never reinstall on their own, so the app updates itself: it
// polls the generic provider (an S3 folder holding latest.yml + the
// installer), downloads in the background, and installs on a quiet moment.
//
// "Quiet" is the whole trick — restarting while an order is ringing or being
// accepted would be far worse than running yesterday's build, so the install
// waits until no alarm has surfaced for QUIET_PERIOD_MS.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000; // every 30 min
const QUIET_PERIOD_MS = 10 * 60_000;          // no order activity for 10 min
const QUIET_RECHECK_MS = 60_000;              // re-test the quiet window
const RESTART_COUNTDOWN_S = 10;               // visible warning before restart

let lastAlarmAt = 0;
let updateDownloaded = false;
let installTimer = null;
let updateWin = null;

// Small always-on-top progress panel. Staff must never see the app vanish
// with no explanation — they get the download bar, then a countdown, then
// the restart. Driven from the main process via executeJavaScript so it
// needs no preload and works whether the app UI is bundled or remote.
const UPDATE_UI = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<html><body style="margin:0;font-family:Segoe UI,sans-serif;background:#FFFDF7;color:#2b2b2b;
  display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="text-align:center;width:88%">
    <div style="font-size:20px;font-weight:700">
      <span style="color:#FFC52E">Yum</span><span style="color:#E8352A">Dude</span>
    </div>
    <div id="msg" style="margin:10px 0 14px;font-size:14px">Downloading update…</div>
    <div style="background:#F7F1DF;border-radius:99px;height:10px;overflow:hidden">
      <div id="fill" style="background:#E8352A;height:100%;width:0%;transition:width .25s"></div>
    </div>
    <div id="pct" style="margin-top:8px;font-size:12px;color:#8a8378">0%</div>
  </div>
  <script>
    function setProgress(p){
      document.getElementById('fill').style.width = p + '%';
      document.getElementById('pct').textContent = p + '%';
    }
    function setMessage(m){ document.getElementById('msg').textContent = m; }
  </script>
</body></html>`);

function showUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) return updateWin;
  updateWin = new BrowserWindow({
    width: 420, height: 220, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: false, title: 'YumDude update',
    icon: path.join(__dirname, 'src/assets/icons/icon.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  updateWin.setMenu(null);
  updateWin.loadURL(UPDATE_UI).catch(() => {});
  updateWin.on('closed', () => { updateWin = null; });
  return updateWin;
}

function updateUi(fn, arg) {
  if (!updateWin || updateWin.isDestroyed()) return;
  const js = typeof arg === 'string' ? `${fn}(${JSON.stringify(arg)})` : `${fn}(${arg})`;
  updateWin.webContents.executeJavaScript(js).catch(() => {});
}

function initAutoUpdater() {
  // The app is unsigned, so skip Windows publisher-signature validation —
  // integrity still comes from the sha512 in latest.yml.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try { autoUpdater.verifyUpdateCodeSignature = false; } catch (_) {}
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => console.log('[update] checking…'));
  autoUpdater.on('update-not-available', (i) => console.log('[update] up to date:', i?.version));

  autoUpdater.on('update-available', (i) => {
    console.log('[update] downloading', i?.version);
    showUpdateWindow();
    updateUi('setMessage', `Downloading update ${i?.version || ''}…`);
  });

  autoUpdater.on('error', (err) => {
    console.error('[update] error:', err?.message);
    // Never strand the panel on screen after a failed download.
    if (updateWin && !updateWin.isDestroyed()) updateWin.close();
    mainWindow?.setProgressBar(-1);
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = Math.round(p.percent);
    updateUi('setProgress', pct);
    mainWindow?.setProgressBar(pct / 100); // taskbar icon fills too
    if (pct % 25 === 0) console.log(`[update] ${pct}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[update] downloaded', info?.version, '— will install at the next quiet moment');
    updateDownloaded = true;
    mainWindow?.setProgressBar(-1);
    updateUi('setProgress', 100);
    updateUi('setMessage', 'Update ready — restarting when the counter is free…');
    scheduleQuietInstall();
  });

  const check = () => autoUpdater.checkForUpdates().catch((e) => console.error('[update] check failed:', e?.message));
  // Give the app a moment to finish loading before the first check.
  setTimeout(check, 20_000);
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

/** Install once the counter has been quiet; re-test every minute until then. */
function scheduleQuietInstall() {
  if (installTimer) return;

  const tryInstall = () => {
    if (!updateDownloaded) return;
    const quietFor = Date.now() - lastAlarmAt;
    if (quietFor <= QUIET_PERIOD_MS) {
      const mins = Math.ceil((QUIET_PERIOD_MS - quietFor) / 60_000);
      console.log('[update] order activity recently — postponing install');
      // Say *why* it is waiting: a panel that just sits there reads as stuck.
      updateUi('setMessage', `Update ready — restarting after orders settle (~${mins} min)`);
      return;
    }
    console.log('[update] quiet window — installing and restarting');
    if (installTimer) { clearInterval(installTimer); installTimer = null; }
    startRestartCountdown();
  };

  // Check straight away: on an idle counter there is nothing to wait for, and
  // making the operator watch a static panel for a minute looks like a hang.
  tryInstall();
  if (!updateDownloaded || installTimer) return;
  installTimer = setInterval(tryInstall, QUIET_RECHECK_MS);
}

/** Visible countdown, then swap and relaunch. */
function startRestartCountdown() {
  showUpdateWindow();
  let left = RESTART_COUNTDOWN_S;
  updateUi('setProgress', 100);
  const tick = () => {
    updateUi('setMessage', `Installing update — restarting in ${left}s…`);
    if (left <= 0) {
      clearInterval(timer);
      isQuitting = true; // let the close-to-tray handler through
      // isSilent=true (no installer UI), isForceRunAfter=true (relaunch after).
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    left -= 1;
  };
  const timer = setInterval(tick, 1000);
  tick();
}

// ── IPC: surface the window for a new order ──────────────────────────────────
// Desktop counterpart of the Android full-screen alarm: a minimised or
// tray-hidden app must put itself in front of whatever the counter PC is doing
// when an order lands, or the ringing has nothing to point at.
ipcMain.handle('alert:surface-window', async () => {
  if (!mainWindow) return { surfaced: false };
  // Doubles as the "an order is being worked right now" signal for the
  // updater, which must never restart the app mid-order.
  lastAlarmAt = Date.now();
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    // Windows refuses focus to a background process, so briefly pin the window
    // on top: that lifts it above the foreground app, then we drop the pin so
    // it behaves like a normal window once the operator is looking at it.
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    setTimeout(() => {
      try { mainWindow?.setAlwaysOnTop(false); } catch (_) {}
    }, 3000);
    // Taskbar highlight for the case where the operator is on another screen.
    mainWindow.flashFrame(true);
    return { surfaced: true };
  } catch (err) {
    console.error('[Electron] Could not surface window for order:', err.message);
    return { surfaced: false };
  }
});

// ── IPC: open settings ────────────────────────────────────────────────────────
ipcMain.handle('printer:open-settings', async () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return { ok: true };
});

// ── IPC: test TCP connection ──────────────────────────────────────────────────
// Opens a TCP socket to host:port and closes it immediately on connect.
// Used by the printer-settings "Test Connection" button.
ipcMain.handle('printer:test-connection', async (event, { host, port }) => {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve({ ok: true });
    };

    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.connect(port, host, () => done(null));
    socket.on('timeout', () => done(new Error(`Connection to ${host}:${port} timed out`)));
    socket.on('error',   (err) => done(err));
  });
});

// ── IPC: send raw ESC/POS bytes via TCP ───────────────────────────────────────
// Receives Base64-encoded bytes from the renderer, decodes them, and writes
// directly to the printer's raw print port (default 9100).
ipcMain.handle('printer:print-raw', async (event, { host, port, data }) => {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve({ ok: true });
    };

    const buf = Buffer.from(data, 'base64');

    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.connect(port, host, () => {
      socket.write(buf, (writeErr) => done(writeErr || null));
    });
    socket.on('timeout', () => done(new Error(`Print to ${host}:${port} timed out`)));
    socket.on('error',   (err) => done(err));
  });
});

// ── IPC: list USB printers (Windows only) ───────────────────────────────────
// Multi-strategy scan covers all common ways a USB thermal printer appears on
// Windows, including the RP3200 Plus, Epson TM-series, and similar devices:
//   Strategy 1 — Windows Spooler: any port name containing 'USB' (USB001, TMUSB001, USB_RP3200, …) or COMx
//   Strategy 2 — PnP class Printer (Device Manager, may not be in spooler)
//   Strategy 3 — USB-Serial COM ports (RS232-over-USB adapter, e.g. RP3200 RS232 interface)
//
// Uses -EncodedCommand (UTF-16LE base64) to avoid all CMD quoting issues.
ipcMain.handle('printer:list-usb', async () => {
  const psScript = `
$found = [System.Collections.Generic.Dictionary[string,object]]::new()

# Strategy 1 — Windows Spooler printers with any USB-related port name (USB001, TMUSB001, etc.) or COMx
try {
  $printers = Get-Printer -ErrorAction SilentlyContinue |
    Where-Object { $_.PortName -match 'USB' -or $_.PortName -match '^COM[0-9]+$' }
  foreach ($p in $printers) {
    if ($p.PortName -and -not $found.ContainsKey($p.PortName)) {
      $found[$p.PortName] = [PSCustomObject]@{
        deviceName  = $p.PortName
        productName = $p.Name
      }
    }
  }
} catch {}

# Strategy 2 — USB PnP Printer devices (Device Manager, may not be in spooler)
try {
  $usbPrinters = Get-PnpDevice -Class Printer -Status OK -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like 'USB*' }
  foreach ($p in $usbPrinters) {
    if (-not $p.FriendlyName) { continue }
    $port = (Get-Printer -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $p.FriendlyName } |
      Select-Object -ExpandProperty PortName -ErrorAction SilentlyContinue)
    if (-not $port) { $port = 'USB001' }
    if (-not $found.ContainsKey($port)) {
      $found[$port] = [PSCustomObject]@{
        deviceName  = $port
        productName = $p.FriendlyName
      }
    }
  }
} catch {}

# Strategy 3 — USB-Serial COM ports (RS232 over USB adapter, e.g. RP3200 Plus RS232 interface at 115200 bps)
try {
  $comPorts = Get-PnpDevice -Class Ports -Status OK -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like 'USB*' -and $_.FriendlyName -match 'COM[0-9]+' }
  foreach ($p in $comPorts) {
    if ($p.FriendlyName -match '\\((COM[0-9]+)\\)') {
      $com = $matches[1]
      if (-not $found.ContainsKey($com)) {
        $found[$com] = [PSCustomObject]@{
          deviceName  = $com
          productName = $p.FriendlyName
        }
      }
    }
  }
} catch {}

$found.Values | ConvertTo-Json -Compress
`;

  try {
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const raw = execSync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { encoding: 'utf8', timeout: 12000 }
    ).trim();

    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const items  = Array.isArray(parsed) ? parsed : [parsed];
    const results = items
      .filter(p => p && p.deviceName)
      .map(p => ({
        deviceName:       p.deviceName,
        productName:      p.productName || p.deviceName,
        manufacturerName: '',
        vendorId:         0,
        productId:        0,
        hasPermission:    true,
      }));
    console.log('[Electron] USB scan found:', results.map(r => `${r.deviceName} (${r.productName})`));
    return results;
  } catch (err) {
    console.error('[Electron] USB list failed:', err.message);
    throw new Error('USB_SCAN_FAILED');
  }
});

// ── IPC: send raw ESC/POS bytes to a USB printer port ────────────────────────
// deviceName is the Windows port name — 'USB001' for direct USB, 'COM3' for
// RS232-over-USB.  For COM ports, configures baud rate (115200) to match the
// RP3200 Plus RS232 interface before writing.
ipcMain.handle('printer:print-usb', async (event, { deviceName, data }) => {
  const portPath = '\\\\.\\' + deviceName;   // → \\.\USB001 or \\.\COM3
  const buf      = Buffer.from(data, 'base64');

  // For RS232 COM ports configure baud rate before sending ESC/POS bytes.
  if (/^COM\d+$/i.test(deviceName)) {
    try {
      execSync(`mode ${deviceName.toUpperCase()} BAUD=115200 PARITY=N DATA=8 STOP=1`,
        { encoding: 'utf8', timeout: 3000 });
    } catch (e) {
      console.warn(`[Electron] COM port config warning (${deviceName}):`, e.message);
    }
  }

  try {
    await writeRawToDevicePath(portPath, buf);
    console.log(`[Electron] USB direct print OK → ${portPath} (${buf.length} bytes)`);
    return { ok: true };
  } catch (directErr) {
    // Custom spooler port names (e.g. USB_RP3200 plus_1) may not map to a
    // writable device path; fallback to RAW print via Windows spooler.
    console.warn(`[Electron] USB direct print failed for ${deviceName}:`, directErr.message);
    return await writeRawViaSpoolerByPort(deviceName, buf);
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Reliability registrations FIRST — nothing below may depend on the tray or
  // window succeeding, so a UI failure can't cost us auto-start or anti-sleep.

  // Come back automatically after a reboot or power cut. Only register the
  // packaged exe — a dev run would pin electron.exe into the user's startup.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
    const { openAtLogin } = app.getLoginItemSettings();
    console.log('[Electron] openAtLogin registered:', openAtLogin);
  }

  // The 20s order poll must survive system idle — without this, Windows sleep
  // suspends the app and the restaurant silently stops receiving orders. The
  // display may still turn off; only app suspension is blocked.
  powerSaveBlocker.start('prevent-app-suspension');

  createWindow();

  // Only a packaged build has an installer to replace; a dev run would throw.
  if (app.isPackaged) initAutoUpdater();

  try {
    createTray();
  } catch (err) {
    // Without a tray, close-to-tray would strand an invisible app — the close
    // handler checks `tray` and quits normally instead.
    console.error('[Electron] Tray creation failed:', err.message);
    tray = null;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Relaunched from the shortcut while hidden in the tray → surface the window.
app.on('second-instance', showWindow);

app.on('before-quit', () => {
  isQuitting = true;
});

// The app lives in the tray; a destroyed window must not quit it (that would
// stop order alerts). Quitting is only via the tray menu.
app.on('window-all-closed', () => {});
