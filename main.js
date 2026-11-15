const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const shelf = require('./shelf');

const DOCK_MARGIN = 4; // visible gap between the dock and the screen/taskbar edges
const SHADOW_PAD = 4; // extra transparent room around the dock for its shadow (keep in sync with --pad in styles.css)
const FALLBACK_TASKBAR_THICKNESS = 48; // used when the taskbar's size can't be worked out
const SIDE_DOCK_HEIGHT = 48; // the dock's height when it sits beside a vertical taskbar
const MIN_DOCK_WIDTH = 40;
const MAX_DOCK_WIDTH = 720;

let win;
let dockWidth = 240; // the renderer reports the real width once it has laid out
let lastBluetooth = null;
let lastMedia = null;
let mediaWatcher = null;
let taskbarReport = null; // { edge, size } from taskbar-watch.ps1, once it has reported
let sentPlacement = null; // the edge/anchor last told to the page

// Which edge of the primary display the taskbar is on, and how thick it is (in Electron's units).
function getTaskbar() {
  const { bounds, workArea } = screen.getPrimaryDisplay();

  // The watcher asks Windows directly, so it also knows where an auto-hidden taskbar is.
  if (taskbarReport) {
    const { edge, size } = taskbarReport;
    const across = edge === 'left' || edge === 'right' ? bounds.width : bounds.height;
    const thickness = Math.round(size * across);
    if (thickness > 0) return { edge, thickness };
  }

  // Until then: the taskbar is on the side where the work area stops short of the screen.
  const gaps = {
    bottom: bounds.y + bounds.height - (workArea.y + workArea.height),
    top: workArea.y - bounds.y,
    left: workArea.x - bounds.x,
    right: bounds.x + bounds.width - (workArea.x + workArea.width),
  };
  const edge = Object.keys(gaps).reduce((best, side) => (gaps[side] > gaps[best] ? side : best));
  if (gaps[edge] > 0) return { edge, thickness: gaps[edge] };
  return { edge: 'bottom', thickness: FALLBACK_TASKBAR_THICKNESS }; // auto-hidden: assume the default
}

// Where the dock goes, and which side it's anchored to (it grows away from that side).
// On a horizontal taskbar it sits inside the taskbar's left end, as tall as the taskbar. A vertical
// taskbar is too narrow to hold it, so it sits on the desktop beside the taskbar, in the bottom
// corner, and grows away from it (rightwards from a left taskbar, leftwards from a right one).
// The window is SHADOW_PAD larger than the dock on every side; the page insets the dock by the
// same amount, so the dock itself stays DOCK_MARGIN from the edges and its shadow has room.
function getPlacement() {
  const { bounds } = screen.getPrimaryDisplay();
  const { edge, thickness } = getTaskbar();
  const inset = DOCK_MARGIN - SHADOW_PAD;
  const width = dockWidth + SHADOW_PAD * 2;
  const screenRight = bounds.x + bounds.width;
  const screenBottom = bounds.y + bounds.height;

  if (edge === 'top' || edge === 'bottom') {
    return {
      edge,
      anchor: 'left',
      bounds: {
        x: bounds.x + inset,
        y: edge === 'top' ? bounds.y + inset : screenBottom - thickness + inset,
        width,
        height: thickness - inset * 2,
      },
    };
  }

  return {
    edge,
    anchor: edge,
    bounds: {
      x: edge === 'left' ? bounds.x + thickness + inset : screenRight - thickness - inset - width,
      y: screenBottom - SIDE_DOCK_HEIGHT + inset,
      width,
      height: SIDE_DOCK_HEIGHT - inset * 2,
    },
  };
}

// Moves the dock to where it belongs right now, and tells the page if the side it grows from changed.
function placeDock() {
  if (!win || win.isDestroyed()) return;

  const { edge, anchor, bounds } = getPlacement();
  win.setBounds(bounds);

  if (!sentPlacement || sentPlacement.edge !== edge || sentPlacement.anchor !== anchor) {
    sentPlacement = { edge, anchor };
    win.webContents.send('dock:placement', sentPlacement);
  }
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
  win.once('ready-to-show', () => win.showInactive());

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
    if (!win || win.isDestroyed()) return;
    if (line === '1') win.hide();
    else if (line === '0') win.showInactive();
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
    placeDock();
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
