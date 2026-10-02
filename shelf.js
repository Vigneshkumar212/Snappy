// The file shelf: things dropped on the dock are kept here (in memory, for this session) so they can
// be swiped back to and dragged out again. Real files are only referenced, never copied. Dropped
// text and files that don't live on disk (an image dragged out of a web page) are saved into a temp
// folder so they have a path to copy and drag out; that folder is cleared when Snappy quits.

const { app, clipboard, ipcMain, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DROPS_DIR = path.join(os.tmpdir(), 'snappy-drops');
const THUMB_SIZE = 96;
// A 1x1 transparent PNG, used as the drag icon when an item has no thumbnail.
const BLANK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const items = new Map(); // id -> item (see describe())
let nextId = 1;

function safeName(name) {
  return String(name || 'dropped-file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'dropped-file';
}

// Writes bytes/text into the drops folder under a name that doesn't clash, and returns its path.
async function saveTemp(name, data) {
  await fs.promises.mkdir(DROPS_DIR, { recursive: true });

  const { name: base, ext } = path.parse(safeName(name));
  let candidate = path.join(DROPS_DIR, `${base}${ext}`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(DROPS_DIR, `${base} (${n})${ext}`);

  await fs.promises.writeFile(candidate, data);
  return candidate;
}

async function thumbnailFor(filePath) {
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, { width: THUMB_SIZE, height: THUMB_SIZE });
    if (!image.isEmpty()) return image.toDataURL();
  } catch {
    // no preview for this kind of file; fall through to its icon
  }
  try {
    const icon = await app.getFileIcon(filePath, { size: 'large' });
    if (!icon.isEmpty()) return icon.toDataURL();
  } catch {
    // ignore
  }
  return null;
}

// What the renderer is allowed to see of an item.
function publicItem(item) {
  const { id, name, size, isDirectory, kind, thumb } = item;
  return { id, name, size, isDirectory, kind, thumb, path: item.path };
}

async function describe(filePath, { temp = false, kind = 'file', text = null } = {}) {
  // Dropping the same thing twice shouldn't pile up duplicates.
  for (const existing of items.values()) {
    if (!temp && existing.path === filePath) return { ...publicItem(existing), duplicate: true };
  }

  const stat = await fs.promises.stat(filePath);
  const item = {
    id: String(nextId++),
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    isDirectory: stat.isDirectory(),
    kind,
    temp,
    text,
    thumb: await thumbnailFor(filePath),
  };
  items.set(item.id, item);
  return publicItem(item);
}

// Puts a real file on the clipboard the way Explorer does (so it can be pasted into a folder).
// Electron has no API for that, so PowerShell does it. It needs an STA thread.
function copyFileToClipboard(filePath) {
  return new Promise((resolve) => {
    // The path goes in through the environment: -Command doesn't hand extra arguments to the script.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-STA', '-Command', 'Set-Clipboard -LiteralPath $env:SNAPPY_COPY_PATH'],
      { windowsHide: true, env: { ...process.env, SNAPPY_COPY_PATH: filePath } }
    );
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

function register() {
  ipcMain.handle('files:list', () => [...items.values()].map(publicItem));

  // Files dropped from Explorer: reference them by path.
  ipcMain.handle('files:add-paths', async (_event, paths) => {
    const added = [];
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) continue;
      try {
        added.push(await describe(filePath));
      } catch {
        // gone or unreadable: skip it
      }
    }
    return added;
  });

  // Files with no path on disk (an image dragged out of a browser): keep the bytes.
  ipcMain.handle('files:add-bytes', async (_event, { name, bytes }) => {
    const saved = await saveTemp(name, Buffer.from(bytes));
    return describe(saved, { temp: true });
  });

  // Dropped text or links.
  ipcMain.handle('files:add-text', async (_event, text) => {
    const body = String(text);
    const title = safeName(body.trim().split(/\r?\n/)[0].slice(0, 28)) || 'Text';
    const saved = await saveTemp(`${title}.txt`, body);
    return describe(saved, { temp: true, kind: 'text', text: body });
  });

  ipcMain.handle('files:remove', async (_event, id) => {
    const item = items.get(id);
    if (!item) return false;

    items.delete(id);
    if (item.temp) await fs.promises.rm(item.path, { force: true }).catch(() => {});
    return true;
  });

  ipcMain.handle('files:copy-path', (_event, id) => {
    const item = items.get(id);
    if (!item) return false;
    clipboard.writeText(item.path);
    return true;
  });

  // Text items copy their text; everything else is copied as a file.
  ipcMain.handle('files:copy', async (_event, id) => {
    const item = items.get(id);
    if (!item) return false;

    if (item.kind === 'text' && item.text !== null) {
      clipboard.writeText(item.text);
      return true;
    }
    return copyFileToClipboard(item.path);
  });

  // Drag an item back out of the dock into Explorer, a chat, an editor...
  ipcMain.on('files:start-drag', (event, id) => {
    const item = items.get(id);
    if (!item) return;

    let icon = item.thumb ? nativeImage.createFromDataURL(item.thumb) : nativeImage.createFromDataURL(BLANK_ICON);
    if (!icon.isEmpty()) icon = icon.resize({ width: 48 });
    event.sender.startDrag({ file: item.path, icon });
  });

  app.on('will-quit', () => {
    fs.rmSync(DROPS_DIR, { recursive: true, force: true });
  });
}

module.exports = { register };
