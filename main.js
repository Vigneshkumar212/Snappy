const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const shelf = require('./shelf');

const DOCK_MARGIN = 4; // visible gap between the dock and the screen/taskbar edges
const SHADOW_PAD = 4; // extra transparent room around the dock for its shadow (keep in sync with --pad in styles.css)
const FALLBACK_TASKBAR_HEIGHT = 48; // used when the taskbar is auto-hidden
const MIN_DOCK_WIDTH = 40;
const MAX_DOCK_WIDTH = 720;

let win;
let dockWidth = 240; // the renderer reports the real width once it has laid out
let lastBluetooth = null;
let lastMedia = null;
let mediaWatcher = null;

// Bounds that sit inside the left end of the taskbar, bottom-left of the primary display.
// The window is SHADOW_PAD larger than the dock on every side; the page insets the dock by the
// same amount, so the dock itself stays DOCK_MARGIN from the edges and its shadow has room.
function getDockBounds() {
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const taskbarHeight = bounds.height - workArea.height || FALLBACK_TASKBAR_HEIGHT;
  const inset = DOCK_MARGIN - SHADOW_PAD;

  return {
    x: bounds.x + inset,
    y: bounds.y + bounds.height - taskbarHeight + inset,
    width: dockWidth + SHADOW_PAD * 2,
    height: taskbarHeight - inset * 2,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...getDockBounds(),
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
  win.setBounds(getDockBounds());
});

app.whenReady().then(() => {
  createWindow();
  watchFullscreen();
  watchBluetooth();
  watchMedia();
  shelf.register();

  // The dock is frameless and unfocusable, so give it a way out.
  globalShortcut.register('Control+Alt+Q', () => app.quit());

  // Re-dock if resolution, scaling or taskbar size changes.
  const redock = () => win && win.setBounds(getDockBounds());
  screen.on('display-metrics-changed', redock);
  screen.on('display-added', redock);
  screen.on('display-removed', redock);
});

app.on('window-all-closed', () => app.quit());
