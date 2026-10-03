// The file shelf tab. Drag files (or text) over the dock and it jumps here with a "Drop to Snappy"
// target; drop and they're kept in memory for this session. Swipe back to this tab any time, drag
// the item out again, or use the three dots for remove / copy path / copy.

const filesPage = document.getElementById('page-files');
const thumbEl = filesPage.querySelector('.fl-thumb');
const nameEl = filesPage.querySelector('.fl-name');
const metaEl = filesPage.querySelector('.fl-meta');
const prevBtn = filesPage.querySelector('[data-act="prev"]');
const nextBtn = filesPage.querySelector('[data-act="next"]');
const copyPill = filesPage.querySelector('.fl-pill[data-act="copy"]');

const DROP_HOLD_MS = 3200;  // how long the shelf stays up after a drop, before going back to your tab
const DRAG_IDLE_MS = 260;   // no dragover for this long means the drag has left the dock
const FLASH_MS = 1600;      // how long "Path copied" and friends stay up

let items = [];   // what's on the shelf, in the order dropped
let index = 0;    // which item is showing
let mode = 'view'; // 'view' | 'menu' | 'drop'
let dragging = false;
let internalDrag = false; // dragging one of our own items out; don't treat it as a new drop
let dragTimer;
let flashTimer;

// ---------- showing an item ----------

function setShelfMode(next) {
  mode = next;
  filesPage.dataset.mode = next;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function describeItem(item) {
  const what = item.isDirectory ? 'Folder' : item.kind === 'text' ? 'Text' : formatSize(item.size);
  return items.length > 1 ? `${index + 1} of ${items.length} · ${what}` : what;
}

function setMeta(text, ok = false) {
  metaEl.textContent = text;
  metaEl.classList.toggle('ok', ok);
}

// Shows a short confirmation in place of the item's details, then puts the details back.
function flash(text) {
  setMeta(text, true);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => items[index] && setMeta(describeItem(items[index])), FLASH_MS);
}

function render({ pop = false } = {}) {
  const item = items[index];
  if (!item) return;

  clearTimeout(flashTimer);
  thumbEl.style.backgroundImage = item.thumb ? `url("${item.thumb}")` : '';
  nameEl.textContent = item.name;
  setMeta(describeItem(item));
  prevBtn.hidden = nextBtn.hidden = items.length < 2;
  copyPill.textContent = item.kind === 'text' ? 'Copy text' : 'Copy file';

  if (pop) {
    thumbEl.classList.remove('pop');
    void thumbEl.offsetWidth;
    thumbEl.classList.add('pop');
  }
}

// ---------- the buttons ----------

const actions = {
  prev() {
    index = (index - 1 + items.length) % items.length;
    render({ pop: true });
  },

  next() {
    index = (index + 1) % items.length;
    render({ pop: true });
  },

  menu() {
    setShelfMode('menu');
  },

  close() {
    setShelfMode('view');
  },

  // Only takes it off the shelf. A real file on disk is never touched.
  async remove() {
    const item = items[index];
    await window.snappy.files.remove(item.id);
    items.splice(index, 1);
    setShelfMode('view');

    if (items.length) {
      index = Math.min(index, items.length - 1);
      render({ pop: true });
    }
    setFileCount(items.length); // the tab goes away when the shelf is empty
  },

  async 'copy-path'() {
    await window.snappy.files.copyPath(items[index].id);
    setShelfMode('view');
    flash('Path copied');
  },

  async copy() {
    const item = items[index];
    const ok = await window.snappy.files.copy(item.id);
    setShelfMode('view');
    flash(ok ? (item.kind === 'text' ? 'Text copied' : 'File copied') : "Couldn't copy");
  },
};

filesPage.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (button && items.length) actions[button.dataset.act]?.();
});

// Drag the item back out into Explorer, a chat, an editor...
thumbEl.addEventListener('dragstart', (event) => {
  event.preventDefault(); // the real (native) drag is started by the main process
  const item = items[index];
  if (!item) return;

  internalDrag = true;
  setTimeout(() => { internalDrag = false; }, 1500);
  window.snappy.files.startDrag(item.id);
});

// Leave the options open behind your back and they'd still be there when you swipe back.
window.addEventListener('pagechange', (event) => {
  if (event.detail.name !== 'files' && mode === 'menu') setShelfMode('view');
});

// ---------- dropping things on the dock ----------

function droppable(dataTransfer) {
  return !!dataTransfer && [...dataTransfer.types].some((type) => type === 'Files' || type === 'text/plain' || type === 'text/uri-list');
}

function beginDrag() {
  if (dragging) return;
  dragging = true;
  setShelfMode('drop');
  setDragActive(true); // jumps to this tab, whichever one you were on
}

function endDrag() {
  clearTimeout(dragTimer);
  if (!dragging) return;

  dragging = false;
  if (mode === 'drop') setShelfMode('view');
  setDragActive(false); // back to where you were
}

document.addEventListener('dragenter', (event) => {
  if (internalDrag || !droppable(event.dataTransfer)) return;
  event.preventDefault();

  beginDrag();
  clearTimeout(dragTimer);
  dragTimer = setTimeout(endDrag, DRAG_IDLE_MS * 4); // a safety net if no dragover ever follows
});

// dragover keeps firing while you hover; when it stops, the drag has left.
document.addEventListener('dragover', (event) => {
  if (internalDrag || !droppable(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';

  beginDrag();
  clearTimeout(dragTimer);
  dragTimer = setTimeout(endDrag, DRAG_IDLE_MS);
});

document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) {
    clearTimeout(dragTimer);
    dragTimer = setTimeout(endDrag, 80); // a later dragover cancels this if it was a false alarm
  }
});

document.addEventListener('drop', (event) => {
  event.preventDefault(); // never let the window navigate to a dropped file
  if (!dragging) return;
  clearTimeout(dragTimer);
  handleDrop(event.dataTransfer);
});

async function handleDrop(dataTransfer) {
  // The DataTransfer is only readable during the event, so take everything out of it first.
  const files = [...dataTransfer.files];
  const text = files.length ? '' : dataTransfer.getData('text/plain') || dataTransfer.getData('text/uri-list');

  const paths = [];
  const withoutPath = [];
  for (const file of files) {
    const filePath = window.snappy.files.pathFor(file);
    if (filePath) paths.push(filePath);
    else withoutPath.push(file); // e.g. an image dragged out of a web page
  }

  const added = [];
  try {
    if (paths.length) added.push(...(await window.snappy.files.addPaths(paths)));
    for (const file of withoutPath) added.push(await window.snappy.files.addBytes(file.name, await file.arrayBuffer()));
    if (text) added.push(await window.snappy.files.addText(text));
  } catch {
    // fall through: nothing added
  }

  finishDrop(added);
}

function finishDrop(added) {
  const fresh = added.filter((item) => !item.duplicate);
  if (!added.length) return endDrag();

  if (fresh.length) {
    index = items.length;
    items.push(...fresh);
  } else {
    index = Math.max(0, items.findIndex((item) => item.id === added[0].id));
  }

  setShelfMode('view');
  render({ pop: true });
  if (!fresh.length) flash('Already on the shelf');

  setFileCount(items.length);
  showTabFor('files', DROP_HOLD_MS); // stay on the shelf a moment so you see it landed...
  dragging = false;
  setDragActive(false);              // ...then go back to your tab
}

// Pick up anything already on the shelf (e.g. after the window reloads).
window.snappy.files.list().then((existing) => {
  if (!existing.length) return;
  items = existing;
  index = items.length - 1;
  render();
  setFileCount(items.length);
});
