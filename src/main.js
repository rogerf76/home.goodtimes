'use strict';

const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { loadConfig } = require('./config');
const { scan } = require('./scanner');
const { groupIntoEvents } = require('./grouping');
const { geocodeEvents } = require('./geocode');

const args = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const settingsArg = args.find((a) => !a.startsWith('-') && a !== '.');

let cfg;
let win;
let library = null;

function log(...m) { console.log('[goodtimes]', ...m); }

function toClientLibrary(events) {
  return {
    generatedAt: Date.now(),
    events: events.map((ev) => ({
      id: ev.id, unit: ev.unit, album: ev.album, start: ev.start, end: ev.end, place: ev.place, lat: ev.lat, lon: ev.lon,
      items: ev.items.map((it) => ({
        url: pathToFileURL(it.path).href,
        type: it.type,
        name: it.name,
        date: it.date,
        aspect: it.width && it.height ? it.width / it.height : null,
        lat: it.lat, lon: it.lon,
      })),
    })),
  };
}

async function buildLibrary() {
  const t0 = Date.now();
  const items = await scan(cfg, (p) => {
    if (p.phase === 'found') log(`found ${p.total} media files`);
    if (p.phase === 'reading') log(`read metadata ${p.done}/${p.total}`);
    win?.webContents.send('status', p);
  });
  const events = groupIntoEvents(items, cfg);
  log(`${items.length} items in ${events.length} events (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  library = toClientLibrary(events);
  win?.webContents.send('library', library);

  if (cfg.geocoding.enabled && cfg.captions.enabled && cfg.captions.showPlace) {
    geocodeEvents(events, cfg, (id, place) => {
      if (library.events[id]) library.events[id].place = place;
      win?.webContents.send('place', { id, place });
    }).catch((e) => log('geocoding error', e.message));
  }
}

function createWindow() {
  const displays = screen.getAllDisplays();
  const d = displays[cfg.display.screen] || screen.getPrimaryDisplay();
  const windowed = !!flag('windowed') || !cfg.display.fullscreen;
  const b = d.bounds;

  win = new BrowserWindow({
    x: windowed ? b.x + 60 : b.x,
    y: windowed ? b.y + 60 : b.y,
    width: windowed ? Math.round(b.width * 0.7) : b.width,
    height: windowed ? Math.round(b.height * 0.7) : b.height,
    fullscreen: !windowed,
    autoHideMenuBar: true,
    backgroundColor: cfg.display.background,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Dev helper: --capture=<folder> saves a screenshot every 2 seconds.
  const cap = flag('capture');
  if (cap) {
    const dir = path.resolve(cap.split('=')[1] || 'captures');
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    setInterval(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `shot-${String(n++).padStart(3, '0')}.png`), img.toPNG());
      } catch { /* window not ready yet */ }
    }, 2000);
  }
  const quitAfter = flag('quit-after');
  if (quitAfter) setTimeout(() => app.quit(), +quitAfter.split('=')[1] * 1000);
}

app.whenReady().then(async () => {
  try {
    cfg = loadConfig(settingsArg);
    log(`settings: ${cfg._file}`);
  } catch (e) {
    // A missing settings.local.yaml is a setup step, not a fault: print the sample to the console.
    if (e.code === 'NO_LOCAL_SETTINGS') console.error(e.message);
    else dialog.showErrorBox('GoodTimes settings error', e.message);
    app.exit(1);
    return;
  }

  ipcMain.handle('get-config', () => cfg);
  ipcMain.handle('get-library', () => library);
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('log', (_e, ...m) => log('renderer:', ...m));
  ipcMain.on('error', (_e, ...m) => console.error('[goodtimes] ERROR', ...m));

  if (cfg.display.preventSleep) powerSaveBlocker.start('prevent-display-sleep');

  createWindow();
  await buildLibrary().catch((e) => log('scan failed', e));

  if (cfg.rescanMinutes > 0) {
    setInterval(() => buildLibrary().catch((e) => log('rescan failed', e)), cfg.rescanMinutes * 60000);
  }
});

app.on('window-all-closed', () => app.quit());
