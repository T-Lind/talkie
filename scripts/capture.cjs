/**
 * Development-only visual capture. Loads the built Electron renderer in a
 * hidden window, joins a room, and writes review PNGs to docs/.
 *
 *   node scripts/capture.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');
const profile = path.join(os.tmpdir(), `talkie-capture-${Date.now()}`);
const WS_URL = 'ws://localhost:8787/ws';

fs.mkdirSync(docs, { recursive: true });
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '2');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let settings = {
    alwaysOnTop: true,
    hideFromCapture: true,
    closeToTray: true,
    launchAtLogin: false,
    bounds: null,
  };
  const windowState = {
    alwaysOnTop: true,
    hideFromCapture: true,
    captureSupported: true,
    contentProtected: true,
    visible: true,
    minimized: false,
    platform: 'win32',
    isPackaged: false,
    version: '0.1.0',
  };

  ipcMain.handle('talkie:window-state', () => windowState);
  ipcMain.handle('talkie:settings-get', () => settings);
  ipcMain.handle('talkie:settings-set', (_event, patch) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  ipcMain.handle('talkie:deep-link-take', () => null);
  ipcMain.handle('talkie:clipboard-write', () => undefined);
  ipcMain.handle('talkie:open-external', () => undefined);

  let win = null;
  ipcMain.on('talkie:window-height', (_event, height) => {
    if (!win || win.isDestroyed() || typeof height !== 'number') return;
    const [width, current] = win.getContentSize();
    const target = Math.max(110, Math.min(640, Math.round(height)));
    if (Math.abs(current - target) < 2) return;
    win.setContentSize(width, target);
  });

  win = new BrowserWindow({
    width: 400,
    height: 760,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#07080d',
    webPreferences: {
      preload: path.join(root, 'apps/desktop/out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
      offscreen: true,
    },
  });

  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const capture = async (name) => {
    await sleep(350);
    const image = await win.webContents.capturePage();
    const file = path.join(docs, name);
    fs.writeFileSync(file, image.toPNG());
    console.log(`captured ${file}`);
  };
  const waitFor = async (needle, timeoutMs = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = await exec('document.body.innerText');
      if (String(text).includes(needle)) return true;
      await sleep(120);
    }
    throw new Error(`Timed out waiting for: ${needle}`);
  };

  await win.loadFile(path.join(root, 'apps/desktop/out/renderer/index.html'));
  await exec(`(() => {
    document.documentElement.style.background = 'radial-gradient(700px 500px at 15% 8%, #f7f8fa 0%, transparent 60%), radial-gradient(620px 520px at 92% 92%, #8e95a1 0%, transparent 60%), linear-gradient(135deg, #cfd4da 0%, #a9b0ba 58%, #e7e9ec 100%)';
    document.body.style.background = 'transparent';
    return true;
  })()`);
  await waitFor('Talkie');
  await waitFor('localhost:8787');
  await capture('preview-onboarding.png');

  await exec(`(() => {
    const set = (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    set('#talkie-name', 'Maya Chen');
    set('#talkie-room', 'Design sync');
    document.querySelector('form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('No hands raised');

  const prefs = JSON.parse(await exec(`localStorage.getItem('talkie.prefs.v1')`));
  const code = prefs.lastRoom.code;
  console.log('room', code);

  const { WebSocket } = require('ws');
  const names = ['Priya Shah', 'Sam Lee', 'Jordan Kim', 'Ava Patel', 'Noah Williams', 'Elena Rossi', 'Theo Park'];
  const clients = [];
  await Promise.all(
    names.map(
      (name, index) =>
        new Promise((resolve) => {
          const ws = new WebSocket(WS_URL);
          clients.push(ws);
          ws.on('open', () =>
            ws.send(
              JSON.stringify({
                t: 'join',
                mode: 'enter',
                code,
                name,
                clientId: `capture-member-${index + 1}`,
                protocol: 2,
              }),
            ),
          );
          ws.on('message', (raw) => {
            const message = JSON.parse(String(raw));
            if (message.t === 'joined') {
              if (index < 4) {
                setTimeout(
                  () => ws.send(JSON.stringify({ t: 'intent', intent: 'queued' })),
                  250 + index * 220,
                );
              }
              resolve();
            }
          });
          ws.on('error', resolve);
        }),
    ),
  );

  await waitFor('8 people here');
  await waitFor('Priya Shah');
  await sleep(900);
  const beforeSettings = win.getContentSize();
  await capture('preview-room.png');

  await exec(`document.querySelector('.room-actions .icon-btn').click()`);
  await waitFor('SOUND');
  await sleep(350);
  const afterSettings = win.getContentSize();
  console.log('room size', beforeSettings, 'settings size', afterSettings);
  await capture('preview-settings.png');

  for (const ws of clients) ws.close();
  await sleep(100);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
