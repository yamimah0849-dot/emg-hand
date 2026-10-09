// Web Serial wrapper: port picking, line parsing, and friendly error messages.

const KNOWN_BOARDS = {
  0x2341: 'Arduino', 0x2a03: 'Arduino', 0x1a86: 'CH340 (Arduino clone)',
  0x0403: 'FTDI', 0x10c4: 'CP210x', 0x239a: 'Adafruit',
};

export function portLabel(port, i) {
  const info = port.getInfo?.() ?? {};
  const name = KNOWN_BOARDS[info.usbVendorId] ?? 'Serial device';
  const ids = info.usbVendorId != null
    ? ` (${hex(info.usbVendorId)}:${hex(info.usbProductId)})` : '';
  return `${i + 1}. ${name}${ids}`;
}
const hex = n => (n ?? 0).toString(16).padStart(4, '0');

export const serialSupported = () => 'serial' in navigator;

export class SerialLink {
  constructor({ onValue, onStatus }) {
    this.onValue = onValue;       // (number) => void
    this.onStatus = onStatus;     // ({state, message}) => void   state: idle|connecting|connected|nodata|error
    this.port = null;
    this.reader = null;
    this.keepReading = false;
    this.lastDataAt = 0;
    this._watchdog = null;
    if (serialSupported()) {
      navigator.serial.addEventListener('disconnect', e => {
        if (e.target === this.port || e.port === this.port) {
          this._status('error', 'Device was unplugged. Reconnect the USB cable, then press Connect.');
          this._teardown();
        }
      });
    }
  }

  async knownPorts() {
    if (!serialSupported()) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  // Opens the browser's native port chooser. Returns the port or null if the user cancelled.
  async requestPort() {
    try {
      return await navigator.serial.requestPort();
    } catch (e) {
      if (e.name === 'NotFoundError') {
        this._status('error',
          'No port selected. If your Arduino is not in the list: use a data-capable USB cable, ' +
          'install the CH340 driver for clone boards, and make sure no other program is using the port.');
        return null;
      }
      if (e.name === 'SecurityError') {
        this._status('error',
          'This page is not allowed to use serial ports. ' +
          'To connect your sensor, run the app on your PC with “Start EMG Hand.bat”. Demo mode still works.');
        return null;
      }
      this._status('error', `Could not open the port chooser: ${e.message}`);
      return null;
    }
  }

  async connect(port, baudRate = 9600) {
    await this.disconnect();
    this.port = port;
    this._status('connecting', 'Opening port…');
    try {
      await port.open({ baudRate });
    } catch (e) {
      this.port = null;
      const busy = /already open|Failed to open|Access denied/i.test(e.message) || e.name === 'NetworkError';
      this._status('error', busy
        ? 'Could not open the port — it is probably in use. Close the Arduino IDE Serial Monitor/Plotter (or any other serial program) and try again.'
        : `Could not open the port: ${e.message}`);
      return false;
    }
    this._status('connected', 'Connected — waiting for data (the Uno resets when the port opens)…');
    this.keepReading = true;
    this.lastDataAt = performance.now();
    this._readLoop();
    this._watchdog = setInterval(() => {
      const silent = performance.now() - this.lastDataAt;
      if (this.port && silent > 3000) {
        this._status('nodata', 'Connected, but no numbers are arriving. Check the baud rate matches your sketch (9600) and that it prints one value per line.');
      }
    }, 1000);
    return true;
  }

  async _readLoop() {
    let buffer = '';
    let gotData = false;
    while (this.port?.readable && this.keepReading) {
      const decoder = new TextDecoderStream();
      const closed = this.port.readable.pipeTo(decoder.writable).catch(() => {});
      this.reader = decoder.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buffer += value;
          let nl;
          while ((nl = buffer.search(/[\r\n]/)) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const m = line.match(/-?\d+(?:\.\d+)?/);  // tolerate "EMG: 512" style lines
            if (!m) continue;
            const v = parseFloat(m[0]);
            if (!Number.isFinite(v)) continue;
            this.lastDataAt = performance.now();
            if (!gotData) { gotData = true; this._status('connected', 'Receiving data.'); }
            else if (this._lastState === 'nodata') this._status('connected', 'Receiving data.');
            this.onValue(v);
          }
          if (buffer.length > 4096) buffer = '';  // garbage guard (wrong baud rate)
        }
      } catch (e) {
        if (this.keepReading) this._status('error', `Read error: ${e.message}`);
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
      await closed;
      if (!this.keepReading) break;
    }
  }

  async disconnect() {
    this.keepReading = false;
    clearInterval(this._watchdog);
    const port = this.port;
    this.port = null;
    if (this.reader) { try { await this.reader.cancel(); } catch {} }
    if (port) {
      // Give pipeTo a moment to release the stream lock before closing.
      for (let i = 0; i < 20; i++) {
        try { await port.close(); break; } catch { await new Promise(r => setTimeout(r, 25)); }
      }
    }
    if (this._lastState !== 'error') this._status('idle', 'Disconnected.');
  }

  _teardown() {
    this.keepReading = false;
    clearInterval(this._watchdog);
    this.port = null;
  }

  _status(state, message) {
    this._lastState = state;
    this.onStatus?.({ state, message });
  }

  get connected() { return !!this.port; }
}
