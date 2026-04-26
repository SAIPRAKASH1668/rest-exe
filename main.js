const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path         = require('path');
const net          = require('net');
const fs           = require('fs');
const { execSync } = require('child_process');

const TCP_TIMEOUT_MS = 10_000;

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

let mainWindow;

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
    },
  });

  // ── Intercept external links → open in system browser ───────────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── Load remote or local ───────────────────────────────────────────────
  if (USE_REMOTE) {
    console.log('[Electron] Loading remote URL:', REMOTE_URL);
    mainWindow.loadURL(REMOTE_URL).catch((err) => {
      console.error('[Electron] Remote load failed, falling back to local build:', err.message);
      mainWindow.loadFile(LOCAL_FILE);
    });

    // If the remote page fails after initial load (network drop, etc.)
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[Electron] Page load failed (${code}): ${desc} — ${url}`);
      console.log('[Electron] Falling back to local build…');
      mainWindow.loadFile(LOCAL_FILE);
    });
  } else {
    console.log('[Electron] Loading local build:', LOCAL_FILE);
    mainWindow.loadFile(LOCAL_FILE);
  }

  // Log when preload bridge is ready
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page loaded. printerAPI bridge active via preload.');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
// Windows, including the RP3200 Plus and similar devices:
//   Strategy 1 — Windows Spooler: printers on USB* or COMx port names
//   Strategy 2 — PnP class Printer (Device Manager, may not be in spooler)
//   Strategy 3 — USB-Serial COM ports (RS232-over-USB adapter, e.g. RP3200 RS232 interface)
//
// Uses -EncodedCommand (UTF-16LE base64) to avoid all CMD quoting issues.
ipcMain.handle('printer:list-usb', async () => {
  const psScript = `
$found = [System.Collections.Generic.Dictionary[string,object]]::new()

# Strategy 1 — Windows Spooler printers with USB* or COMx port names
try {
  $printers = Get-Printer -ErrorAction SilentlyContinue |
    Where-Object { $_.PortName -match '^USB' -or $_.PortName -match '^COM[0-9]+$' }
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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
