const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const shelf = require('./shelf');

const DOCK_MARGIN = 4; // visible gap between the dock and the screen/taskbar edges
const SHADOW_PAD = 4; // extra transparent room around the dock for its shadow (keep in sync with --pad in styles.css)
const FALLBACK_TASKBAR_THICKNESS = 48; // used when the taskbar's size can't be worked out
const SIDE_DOCK_HEIGHT = 48; // the dock's height on a vertical taskbar
const TASKBAR_WAIT_MS = 2500; // how long to wait for the taskbar watcher before showing the dock anyway
const FLOAT_TILE = 40; // the tile's width when the dock floats where you put it (with the 40px height, a square)
const MOVE_FRAME_MS = 16; // how often the dock follows the pointer while you drag it
const MOVE_MAX_MS = 60 * 1000; // a drag that never ends (a lost mouse-up) is dropped after this
const MIN_DOCK_WIDTH = 24;
const MAX_DOCK_WIDTH = 720;

let win;
let dockWidth = 240; // the renderer reports the real width once it has laid out
let lastBluetooth = null;
let lastMedia = null;
let mediaWatcher = null;
let taskbarReport = null; // { edge, size, tray } from taskbar-watch.ps1, once it has reported
let sentPlacement = null; // the edge/anchor/tile last told to the page
let customPosition = null; // { x, y, anchor } where you dropped the dock, or null to follow the taskbar
let moving = null; // { dx, dy, timer, started } while you're dragging the dock

// ---------- saved position ----------

// Where you put the dock is kept in settings.json in Electron's user data folder.
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const { position } = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {};
    const valid = position && Number.isFinite(position.x) && Number.isFinite(position.y)
      && (position.anchor === 'left' || position.anchor === 'right');
    customPosition = valid ? position : null;
  } catch {
    customPosition = null; // first run, or unreadable: follow the taskbar
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ position: customPosition }, null, 2));
  } catch {
    // not fatal: the position just won't survive a restart
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// Which edge of the primary display the taskbar is on, how thick it is, and where its tray (clock,
// tray icons) starts along it (null if unknown), in Electron's units.
function getTaskbar() {
  const { bounds, workArea } = screen.getPrimaryDisplay();

  // The watcher asks Windows directly, so it also knows where an auto-hidden taskbar is.
  if (taskbarReport) {
    const { edge, size, tray } = taskbarReport;
    const vertical = edge === 'left' || edge === 'right';
    const thickness = Math.round(size * (vertical ? bounds.width : bounds.height));
    const trayStart = tray > 0
      ? Math.round(vertical ? bounds.y + tray * bounds.height : bounds.x + tray * bounds.width)
      : null;
    if (thickness > 0) return { edge, thickness, tray: trayStart };
  }

  // Until then: the taskbar is on the side where the work area stops short of the screen.
  const gaps = {
    bottom: bounds.y + bounds.height - (workArea.y + workArea.height),
    top: workArea.y - bounds.y,
    left: workArea.x - bounds.x,
    right: bounds.x + bounds.width - (workArea.x + workArea.width),
  };
  const edge = Object.keys(gaps).reduce((best, side) => (gaps[side] > gaps[best] ? side : best));
  if (gaps[edge] > 0) return { edge, thickness: gaps[edge], tray: null };
  return { edge: 'bottom', thickness: FALLBACK_TASKBAR_THICKNESS, tray: null }; // auto-hidden: assume the default
}

// Where the dock goes, which side it's anchored to (it grows away from that side), and on a vertical
// taskbar how wide its collapsed tile is.
// On a horizontal taskbar it sits inside the taskbar's left end, as tall as the taskbar. On a vertical
// taskbar it sits inside the taskbar too, just above the tray, as a small tile as wide as the taskbar.
// Hover it (or let something happen, like a new track) and it opens outwards over the desktop:
// rightwards from a left taskbar, leftwards from a right one. The page decides when it's a tile.
// If you've dragged the dock somewhere else, it floats there instead, as a tile that opens on hover.
// The window is SHADOW_PAD larger than the dock on every side; the page insets the dock by the
// same amount, so the dock itself stays DOCK_MARGIN from the edges and its shadow has room.
function getPlacement() {
  const { bounds } = screen.getPrimaryDisplay();
  const { edge, thickness, tray } = getTaskbar();
  const inset = DOCK_MARGIN - SHADOW_PAD;
  const width = dockWidth + SHADOW_PAD * 2;
  const screenRight = bounds.x + bounds.width;
  const screenBottom = bounds.y + bounds.height;

  // Where you put it. `x` is the anchored side: the dock grows away from it, towards the middle of
  // the screen, and it's kept on screen if the resolution changes.
  if (customPosition) {
    const { x, y, anchor } = customPosition;
    const height = SIDE_DOCK_HEIGHT - inset * 2;
    return {
      edge: 'float',
      anchor,
      tile: FLOAT_TILE,
      bounds: {
        x: clamp(anchor === 'left' ? x : x - width, bounds.x, screenRight - width),
        y: clamp(y, bounds.y, screenBottom - height),
        width,
        height,
      },
    };
  }

  if (edge === 'top' || edge === 'bottom') {
    return {
      edge,
      anchor: 'left',
      tile: null,
      bounds: {
        x: bounds.x + inset,
        y: edge === 'top' ? bounds.y + inset : screenBottom - thickness + inset,
        width,
        height: thickness - inset * 2,
      },
    };
  }

  // Just above the tray, so it doesn't cover the clock; in the bottom corner if the tray wasn't found.
  const tileBottom = tray !== null && tray > bounds.y + SIDE_DOCK_HEIGHT ? tray : screenBottom;

  return {
    edge,
    anchor: edge,
    tile: Math.max(MIN_DOCK_WIDTH, thickness - DOCK_MARGIN * 2),
    bounds: {
      x: edge === 'left' ? bounds.x + inset : screenRight - inset - width,
      y: tileBottom - SIDE_DOCK_HEIGHT + inset,
      width,
      height: SIDE_DOCK_HEIGHT - inset * 2,
    },
  };
}

// Moves the dock to where it belongs right now, and tells the page if its edge, anchor or tile changed.
function placeDock() {
  if (!win || win.isDestroyed()) return;

  const { edge, anchor, tile, bounds } = getPlacement();
  if (moving) {
    // Mid-drag the pointer decides where it is; only its size follows the page.
    win.setBounds({ ...bounds, x: moving.x, y: moving.y });
  } else {
    win.setBounds(bounds);
  }

  if (!sentPlacement || sentPlacement.edge !== edge || sentPlacement.anchor !== anchor || sentPlacement.tile !== tile) {
    sentPlacement = { edge, anchor, tile };
    win.webContents.send('dock:placement', sentPlacement);
  }
}

// ---------- moving the dock ----------

// Press and hold the dock, then drag (the page starts and ends it). While you drag, the window follows
// the pointer. Drop it on the taskbar and it goes back to following the taskbar; drop it anywhere
// else and it stays there, anchored to whichever side is nearer the edge of the screen.
function overTaskbar({ x, y }) {
  const { bounds } = screen.getPrimaryDisplay();
  const { edge, thickness } = getTaskbar();
  if (edge === 'left') return x < bounds.x + thickness;
  if (edge === 'right') return x >= bounds.x + bounds.width - thickness;
  if (edge === 'top') return y < bounds.y + thickness;
  return y >= bounds.y + bounds.height - thickness;
}

function followPointer() {
  if (!moving || !win || win.isDestroyed()) return;
  if (Date.now() - moving.started > MOVE_MAX_MS) return finishMove();

  // Size and position come from our own numbers, never read back from the window: on a scaled display
  // (125%, say) win.getSize()/getPosition() can be a pixel off, and feeding that back in every frame
  // made the dock grow taller the longer it was dragged. setPosition drifts the same way, so it's
  // setBounds with a known size.
  const cursor = screen.getCursorScreenPoint();
  const x = Math.round(cursor.x - moving.dx);
  const y = Math.round(cursor.y - moving.dy);
  if (x === moving.x && y === moving.y) return; // the pointer hasn't moved: nothing to redraw
  moving.x = x;
  moving.y = y;
  const { width, height } = getPlacement().bounds;
  win.setBounds({ x, y, width, height });
}

function startMove() {
  if (!win || win.isDestroyed() || moving) return;
  const cursor = screen.getCursorScreenPoint();
  const { x, y } = getPlacement().bounds; // where we put it, not what the window reports
  moving = { x, y, dx: cursor.x - x, dy: cursor.y - y, started: Date.now(), timer: setInterval(followPointer, MOVE_FRAME_MS) };
}

function finishMove() {
  if (!moving) return;
  clearInterval(moving.timer);
  const { x, y } = moving; // where the drag left it (see followPointer for why not win.getPosition())
  moving = null;
  if (!win || win.isDestroyed()) return;

  if (overTaskbar(screen.getCursorScreenPoint())) {
    customPosition = null;
  } else {
    const { bounds } = screen.getPrimaryDisplay();
    const { width } = getPlacement().bounds;
    const anchor = x + width / 2 < bounds.x + bounds.width / 2 ? 'left' : 'right';
    customPosition = { x: anchor === 'left' ? x : x + width, y, anchor };
  }

  saveSettings();
  placeDock();
}

ipcMain.on('dock:move-start', startMove);
ipcMain.on('dock:move-end', finishMove);

// The dock shows once the page is ready and we know where the taskbar is (so it doesn't appear in
// one place and jump to another), and hides while something is full-screen.
let windowReady = false;
let taskbarKnown = false;
let fullscreen = false;

function updateVisibility() {
  if (!win || win.isDestroyed()) return;
  const show = windowReady && taskbarKnown && !fullscreen;
  if (show && !win.isVisible()) win.showInactive();
  else if (!show && win.isVisible()) win.hide();
}

function createWindow() {
  win = new BrowserWindow({
    ...getPlacement().bounds,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // the dock is never focused; keep animations running
      autoplayPolicy: 'no-user-gesture-required', // so the timer's chime can play without a click
    },
  });

  // 'screen-saver' is the level that stays above the Windows taskbar.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);

  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    windowReady = true;
    updateVisibility();
  });
  // If the taskbar watcher is slow (or can't run), show the dock where Electron thinks the taskbar is.
  setTimeout(() => {
    taskbarKnown = true;
    updateVisibility();
  }, TASKBAR_WAIT_MS);

  // The page needs to know which side the dock grows from; resend it after every (re)load.
  win.webContents.on('did-finish-load', () => {
    sentPlacement = null;
    placeDock();
  });

  // Windows can knock us behind the taskbar when it takes focus; reassert.
  win.on('blur', () => win.setAlwaysOnTop(true, 'screen-saver'));

  // Clicking the taskbar raises it above topmost windows, so keep pushing the dock back up.
  setInterval(() => {
    if (!win.isDestroyed() && win.isVisible()) win.moveTop();
  }, 1000);
}

// Runs a PowerShell helper from scripts/ and calls onLine for each line it prints.
// The helper exits by itself if this process dies; we also kill it on quit.
function runWatcher(script, onLine) {
  const watcher = spawn(
    'powershell.exe',
    [
      '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'scripts', script),
      '-ParentPid', String(process.pid),
    ],
    { windowsHide: true }
  );

  let buffer = '';
  watcher.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach((line) => line.trim() && onLine(line.trim()));
  });

  // Kill it on quit, and stop listening once it's gone (watchers can be started and stopped repeatedly).
  const killOnQuit = () => watcher.kill();
  app.on('will-quit', killOnQuit);
  watcher.once('exit', () => app.removeListener('will-quit', killOnQuit));
  return watcher;
}

// Hide the dock while something is full-screen, bring it back afterwards.
// The check is Windows' SHQueryUserNotificationState.
function watchFullscreen() {
  runWatcher('fullscreen-watch.ps1', (line) => {
    if (line !== '1' && line !== '0') return;
    fullscreen = line === '1';
    updateVisibility();
  });
}

// Which edge the taskbar is on and how thick it is. Moving or resizing the taskbar re-docks.
function watchTaskbar() {
  runWatcher('taskbar-watch.ps1', (line) => {
    let report;
    try {
      report = JSON.parse(line);
    } catch {
      return;
    }
    if (!report || !['top', 'bottom', 'left', 'right'].includes(report.edge) || !(report.size > 0)) return;

    taskbarReport = report;
    taskbarKnown = true;
    placeDock();
    updateVisibility();
  });
}

// Connected Bluetooth devices and their battery, pushed to the renderer on every change.
function watchBluetooth() {
  runWatcher('bluetooth-watch.ps1', (line) => {
    try {
      lastBluetooth = JSON.parse(line);
    } catch {
      return;
    }
    if (win && !win.isDestroyed()) win.webContents.send('bluetooth:update', lastBluetooth);
  });
}

// What's playing (title, artist, artwork, position), pushed to the renderer on every change.
function watchMedia() {
  mediaWatcher = runWatcher('media-watch.ps1', (line) => {
    let media;
    try {
      media = JSON.parse(line);
    } catch {
      return;
    }

    // Artwork is only sent when the track changes; carry it over for position/state updates.
    if (media && !media.art && lastMedia && lastMedia.key === media.key) media.art = lastMedia.art;

    lastMedia = media;
    if (win && !win.isDestroyed()) win.webContents.send('media:update', media);
  });
}

// System glance (CPU, memory, network speed). Only sampled while the System tab is open: the page
// tells us when it's showing, so nothing runs the rest of the time.
let systemTimer = null;
let networkWatcher = null;
let previousCpu = null;
let lastNetwork = { down: 0, up: 0 };

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    for (const time of Object.values(cpu.times)) total += time;
  }
  return { idle, total };
}

function sampleSystem() {
  if (!systemTimer || !win || win.isDestroyed()) return;

  const now = cpuTimes();
  const idle = now.idle - previousCpu.idle;
  const total = now.total - previousCpu.total;
  previousCpu = now;

  const memoryTotal = os.totalmem();
  const memoryUsed = memoryTotal - os.freemem();

  win.webContents.send('system:update', {
    cpu: total > 0 ? Math.round((1 - idle / total) * 100) : 0,
    ram: Math.round((memoryUsed / memoryTotal) * 100),
    ramUsed: memoryUsed,
    ramTotal: memoryTotal,
    down: lastNetwork.down,
    up: lastNetwork.up,
  });
}

function setSystemWatch(on) {
  if (on && !systemTimer) {
    previousCpu = cpuTimes();
    systemTimer = setInterval(sampleSystem, 2000);
    setTimeout(sampleSystem, 600); // a first reading quickly, rather than after two seconds
    networkWatcher = runWatcher('network-watch.ps1', (line) => {
      try {
        lastNetwork = JSON.parse(line);
      } catch {
        // ignore a garbled line
      }
    });
  } else if (!on && systemTimer) {
    clearInterval(systemTimer);
    systemTimer = null;
    if (networkWatcher) networkWatcher.kill();
    networkWatcher = null;
    lastNetwork = { down: 0, up: 0 };
  }
}

ipcMain.on('system:watch', (_event, on) => setSystemWatch(Boolean(on)));

ipcMain.handle('bluetooth:get', () => lastBluetooth);
ipcMain.handle('media:get', () => lastMedia);

// Play/pause, next and previous are forwarded to the media watcher, which applies them to the session.
ipcMain.on('media:command', (_event, command) => {
  if (!mediaWatcher || !mediaWatcher.stdin.writable) return;
  if (['toggle', 'next', 'prev'].includes(command)) mediaWatcher.stdin.write(`${command}\n`);
});

// The renderer sizes the dock to its content.
ipcMain.on('dock:set-width', (_event, width) => {
  if (!win || win.isDestroyed() || !Number.isFinite(width)) return;
  dockWidth = Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, Math.ceil(width)));
  placeDock();
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  watchTaskbar();
  watchFullscreen();
  watchBluetooth();
  watchMedia();
  shelf.register();

  // The dock is frameless and unfocusable, so give it a way out.
  globalShortcut.register('Control+Alt+Q', () => app.quit());

  // Re-dock if resolution, scaling or the taskbar's size or edge changes.
  screen.on('display-metrics-changed', placeDock);
  screen.on('display-added', placeDock);
  screen.on('display-removed', placeDock);
});

app.on('window-all-closed', () => app.quit());
