/**
 * Electron preload script — runs in a sandboxed context with access to both
 * the renderer (window) and Node/IPC, bridging them securely via contextBridge.
 *
 * Exposes  window.printerAPI  to the Angular renderer:
 *   openSettings()                → asks main to focus/navigate to settings
 *   printRaw(host, port, b64)     → sends raw ESC/POS bytes over TCP (Node net)
 *   testConnection(host, port)    → TCP connect-only test (no data sent)
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printerAPI', {

  /** Notify main process to focus the settings area / main window. */
  openSettings: () =>
    ipcRenderer.invoke('printer:open-settings'),

  /**
   * Sends raw ESC/POS bytes to a network printer via TCP (port 9100).
   * @param host   Printer IP address, e.g. '192.168.0.206'
   * @param port   Raw print port, typically 9100
   * @param b64    ESC/POS bytes encoded as Base64 string
   */
  printRaw: (host, port, b64) =>
    ipcRenderer.invoke('printer:print-raw', { host, port, data: b64 }),

  /**
   * Tests TCP reachability without sending any print data.
   * Resolves with { ok: true } on success, rejects with an Error on failure.
   */
  testConnection: (host, port) =>
    ipcRenderer.invoke('printer:test-connection', { host, port }),

  /**
   * Lists USB printers currently attached to the Windows PC.
   * Returns an array of UsbDevice-compatible objects (deviceName = port name e.g. 'USB001').
   */
  listUsbPrinters: () =>
    ipcRenderer.invoke('printer:list-usb'),

  /**
   * Sends raw ESC/POS bytes to a USB printer on Windows.
   * @param deviceName  Windows port name, e.g. 'USB001'
   * @param b64         ESC/POS bytes encoded as Base64 string
   */
  printUsbRaw: (deviceName, b64) =>
    ipcRenderer.invoke('printer:print-usb', { deviceName, data: b64 }),
});
