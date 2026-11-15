// Dock layout, tabs and page switching. The dock has tabs, shown one at a time: "media" (now
// playing, when something is playing), "bluetooth" (connected devices, when any are connected) and
// "files" (the drop shelf, once it holds something). Scrolling over the dock moves between them.
// A "notice" page (a device connecting or disconnecting) briefly takes over from whichever tab
// you're on, and dragging something over the dock jumps to the shelf so it can be dropped.

const dock = document.getElementById('dock');
const pages = {
  media: document.getElementById('page-media'),
  bluetooth: document.getElementById('page-bluetooth'),
  files: document.getElementById('page-files'),
  notice: document.getElementById('page-notice'),
  home: document.getElementById('page-home'),
  timer: document.getElementById('page-timer'),
  system: document.getElementById('page-system'),
  alarm: document.getElementById('page-alarm'),
};

let activePage = null;
let mediaPlaying = false;
let hasDevices = false;
let fileCount = 0;
let timerRunning = false;
let dragActive = false; // something is being dragged over the dock
let noticeActive = false;
let alarmActive = false; // the timer is ringing
let selectedTab = null; // the tab you last scrolled to (or that was last brought forward)
let holdTab = null;     // a tab that was asked to show for a while (a connect's battery, a fresh drop)
let holdUntil = 0;
let holdTimer;

// ---------- window sizing ----------

const BOUNCE_PX = 12;       // how far the dock overshoots its new width before settling
const BOUNCE_LIFT_PX = 4;   // how much taller it gets mid-bounce (the window has 4px of room above and below)
const BOUNCE_MS = 950;

// Tell the window how wide the dock is. It gets extra room while the dock is mid-bounce (so the
// overshoot isn't clipped), never shrinks during the animation, then settles on the exact width.
let sentWidth = 0;
let settleTimer;

function sendWidth(width) {
  if (width === sentWidth) return;
  sentWidth = width;
  window.snappy.setDockWidth(width);
}

function reportWidth(width) {
  clearTimeout(settleTimer);
  sendWidth(Math.max(sentWidth, width + BOUNCE_PX + 4));
  settleTimer = setTimeout(() => sendWidth(width), BOUNCE_MS + 100);
}

// Springy resize: runs past the new width, a touch the other way, then settles. The height
// swells and relaxes with it.
let bounceAnim;
let lastTarget = null;

function bounceDock(from, to) {
  if (bounceAnim) bounceAnim.cancel(); // so the height we read below is the resting one

  const height = dock.offsetHeight;
  const dir = to >= from ? 1 : -1;
  const lift = BOUNCE_LIFT_PX;
  const ease = 'cubic-bezier(0.25, 0.9, 0.4, 1)';

  bounceAnim = dock.animate(
    [
      { width: `${from}px`, height: `${height}px`, transform: 'translateY(0)', easing: ease },
      { width: `${to + dir * BOUNCE_PX}px`, height: `${height + lift}px`, transform: `translateY(${-lift / 2}px)`, offset: 0.4, easing: ease },
      { width: `${to - dir * 4}px`, height: `${height - 1.5}px`, transform: 'translateY(0.75px)', offset: 0.72, easing: ease },
      { width: `${to}px`, height: `${height}px`, transform: 'translateY(0)' },
    ],
    { duration: BOUNCE_MS }
  );
}

// ---------- the tile (vertical taskbar) ----------

// On a vertical taskbar the dock rests as a small tile inside the taskbar, showing just the active
// tab's "face" (the cover, a battery ring, the timer's gauge...). It opens out over the desktop while
// you hover it, and on its own when something takes over the dock (a new track, a device connecting,
// a drop, a notice, the alarm), closing again once that's over. `tileWidth` is null on a horizontal
// taskbar, where the dock is always open.
let tileWidth = null;
let hovering = false;
let hoverTimer;
let tileFace = null;

const HOVER_CLOSE_MS = 400; // how long the pointer can stray off the dock before it closes again

// The one element each tab keeps showing in the tile, centred.
const TILE_FACES = {
  home: '.home-mark',
  media: '.cover',
  bluetooth: '.chip .gauge',
  files: '.fl-thumb',
  timer: '.tm-gauge',
  system: '.sys-gauge',
};

function isOpen() {
  if (tileWidth === null) return true;
  if (hovering || moveActive || dragActive || alarmActive || activePage === 'notice') return true;
  return Date.now() < holdUntil && activePage === holdTab; // a tab that's showing itself for a moment
}

// Marks the active tab's face and slides the page sideways so the face sits in the tile's centre.
// Everything else on the page is hidden by CSS while collapsed.
function centreTileFace(page) {
  const face = TILE_FACES[activePage] ? page.querySelector(TILE_FACES[activePage]) : null;
  if (face !== tileFace) {
    if (tileFace) tileFace.classList.remove('tile-face');
    if (face) face.classList.add('tile-face');
    tileFace = face;
  }
  if (!face) return dock.style.setProperty('--tile-shift', '0px');

  // Both rectangles move with the page's own slide, so their difference is the face's place on the page.
  const pageRect = page.getBoundingClientRect();
  const faceRect = face.getBoundingClientRect();
  const centre = page.offsetLeft + (faceRect.left - pageRect.left) + faceRect.width / 2;
  dock.style.setProperty('--tile-shift', `${Math.round(tileWidth / 2 - centre)}px`);
}

dock.addEventListener('mouseenter', () => {
  clearTimeout(hoverTimer);
  if (hovering) return;
  hovering = true;
  if (tileWidth !== null) layoutDock();
});

dock.addEventListener('mouseleave', () => {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hovering = false;
    if (tileWidth !== null) layoutDock();
  }, HOVER_CLOSE_MS);
});

// Size the dock to the active page (or to the tile, while collapsed). `bounce` forces the animation
// even if the width is unchanged.
function layoutDock({ bounce = false } = {}) {
  const page = pages[activePage || 'bluetooth'];
  const collapsed = !isOpen();
  dock.classList.toggle('collapsed', collapsed);

  let width;
  if (collapsed) {
    width = tileWidth;
    centreTileFace(page);
  } else {
    const style = getComputedStyle(page);
    const padLeft = parseFloat(style.left) || 0;                                   // each page sets its own insets
    const padRight = parseFloat(style.getPropertyValue('--pad-right')) || padLeft; // (right defaults to the left)
    width = Math.ceil(padLeft + page.offsetWidth + padRight);
  }

  const from = dock.getBoundingClientRect().width;
  dock.style.width = `${width}px`;
  if (width !== lastTarget || bounce) bounceDock(from, width);
  lastTarget = width;

  reportWidth(width);
}

// Run a DOM change that shifts the device chips, and slide them from where they were to where
// they end up instead of snapping. Also refits the dock.
function reflow(mutate) {
  const before = new Map([...document.querySelectorAll('.chip')].map((el) => [el, el.getBoundingClientRect().left]));
  mutate();

  for (const [el, left] of before) {
    if (!el.isConnected) continue;
    const shift = left - el.getBoundingClientRect().left;
    if (shift) {
      el.animate(
        [{ transform: `translateX(${shift}px)` }, { transform: 'none' }],
        { duration: 600, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
      );
    }
  }
  layoutDock();
}

// ---------- tabs & page switching ----------

// Top to bottom. "home" is the resting tab (the name and tagline); the three in the middle come and go
// with their content; "timer" and "system" are always there, at the bottom, so they're out of the way
// until you scroll down to them. Things that happen (a device connecting, a drop) show their tab for
// a moment, then the dock goes back to where it was resting, but only if they outrank what's on
// screen (see PRIORITY below). Where it rests: the tab you scrolled to, or if you haven't chosen one,
// Music while something is playing (it outranks Home), otherwise Home.
const TAB_ORDER = ['home', 'media', 'bluetooth', 'files', 'timer', 'system'];

// How much each tab matters. An event (a device connecting or disconnecting, a track starting, a drop)
// may take over the dock only if its tab OUTRANKS the one on screen; otherwise it happens quietly in
// the background (the device joins the Devices tab, the track is there when you scroll to Music).
// Things you do yourself always work: scrolling, and dragging a file over the dock. A ringing timer
// alarm beats everything.
//   0 Home (resting)  |  1 Timer, System, Devices  |  2 Music, Files
const PRIORITY = { home: 0, system: 1, timer: 1, bluetooth: 1, files: 2, media: 2 };
const INTERRUPT_ON_EQUAL = false; // true: an event as important as what's showing may take over too

let noticeTab = 'bluetooth'; // the tab whose event the notice page is announcing

// Where the dock sits when you haven't picked a tab and nothing is happening: the highest-priority
// thing that's ongoing. Music while something is playing (2), else the Timer while one is running (1),
// else Home (0). Momentary things (a device connecting, a drop) show themselves and then return to
// this. (A tab you scrolled to yourself beats it: see selectedTab.)
function restingTab() {
  if (mediaPlaying) return 'media';
  if (timerRunning) return 'timer';
  return 'home';
}

// What's on screen, for ranking purposes. A notice counts as the tab it's announcing.
function shownTab() {
  return activePage === 'notice' ? noticeTab : activePage || 'home';
}

// Can an event for `tab` take over the dock right now?
function canInterrupt(tab) {
  if (alarmActive) return false;        // nothing outranks a ringing alarm
  const shown = shownTab();
  if (tab === shown) return true;       // the same tab: it just refreshes
  const rank = PRIORITY[tab];
  const current = PRIORITY[shown] ?? 0;
  return INTERRUPT_ON_EQUAL ? rank >= current : rank > current;
}
const WHEEL_STEP = 50;          // scroll distance that counts as one swipe
const WHEEL_COOLDOWN_MS = 550;  // ignore the tail of a trackpad swipe after switching
const DOTS_SHOW_MS = 1600;
const tabsEl = document.getElementById('tabs');
let dotsTimer;

// A tab exists only while it has something to show.
function availableTabs() {
  const present = { home: true, media: mediaPlaying, bluetooth: hasDevices, files: fileCount > 0, timer: true, system: true };
  return TAB_ORDER.filter((name) => present[name]);
}

// Little dots show which tab you're on. They appear on hover, and briefly after you switch tabs
// yourself (not when the dock swaps tabs on its own).
function renderTabs() {
  const tabs = availableTabs();
  tabsEl.hidden = tabs.length < 2;
  while (tabsEl.children.length < tabs.length) tabsEl.appendChild(document.createElement('i')).className = 'tab-dot';
  while (tabsEl.children.length > tabs.length) tabsEl.lastChild.remove();
  [...tabsEl.children].forEach((dot, i) => {
    dot.classList.toggle('active', tabs[i] === activePage);
    dot.classList.toggle('live', tabs[i] === 'timer' && timerRunning);
  });
}

function flashTabs() {
  if (availableTabs().length < 2) return;
  tabsEl.classList.add('show');
  clearTimeout(dotsTimer);
  dotsTimer = setTimeout(() => tabsEl.classList.remove('show'), DOTS_SHOW_MS);
}

// `dir` is the way the content slides: 1 moves up (towards the next tab), -1 moves down.
// `manual` is true when the user scrolled there, so listeners can skip automatic flourishes.
function setPage(name, { manual = false, dir } = {}) {
  const changed = name !== activePage;
  if (changed) {
    if (dir === undefined) {
      const forwards = name === 'notice' || activePage === 'notice' || name === 'alarm' || activePage === 'alarm' || activePage === null
        || TAB_ORDER.indexOf(name) >= TAB_ORDER.indexOf(activePage);
      dir = forwards ? 1 : -1;
    }

    activePage = name;
    dock.dataset.page = name; // lets CSS react to the active page (e.g. hide the music progress line)
    dock.style.setProperty('--dir', dir);
    for (const [key, el] of Object.entries(pages)) el.classList.toggle('active', key === name);
    window.dispatchEvent(new CustomEvent('pagechange', { detail: { name, manual } }));
    if (manual) flashTabs(); // only when you switched; automatic swaps (notices, holds, drops) stay quiet
  }
  layoutDock({ bounce: changed });
  renderTabs();
}

// Decides what the dock shows. In order: a ringing alarm; the shelf while something is dragged over
// it (so it can be dropped, whatever tab you were on); then a notice or a tab that was asked to show
// for a while, whichever is more important; then the tab you chose; then the resting tab (Music while
// something plays, otherwise Home).
function choosePage() {
  if (alarmActive) return setPage('alarm');
  if (dragActive) return setPage('files');

  const tabs = availableTabs();
  const holdLive = Date.now() < holdUntil && tabs.includes(holdTab);
  const holdRank = holdLive ? PRIORITY[holdTab] : -1;

  // A notice shows unless something more important has taken the dock in the meantime.
  if (noticeActive && PRIORITY[noticeTab] >= holdRank) return setPage('notice');
  if (holdLive) return setPage(holdTab);

  setPage(tabs.includes(selectedTab) ? selectedTab : restingTab());
}

function setAlarmActive(active) {
  alarmActive = active;
  choosePage();
}

function setNoticeActive(active, tab = 'bluetooth') {
  noticeActive = active;
  if (active) noticeTab = tab;
  choosePage();
}

function setMediaPlaying(playing) {
  mediaPlaying = playing;
  choosePage();
}

function setHasDevices(present) {
  hasDevices = present;
  choosePage();
}

function setFileCount(count) {
  fileCount = count;
  choosePage();
}

function setDragActive(active) {
  dragActive = active;
  choosePage();
}

function setTimerRunning(running) {
  timerRunning = running;
  choosePage(); // starting or stopping a timer changes where the dock rests (and redraws the dots)
}

// Show a tab for at least `ms` (the Bluetooth tab after a connect, so the battery gets seen; the
// shelf after a drop; Music when a track starts), then go back to the tab you were on. Does nothing
// (and returns false) if the tab doesn't outrank what's on screen.
function showTabFor(name, ms) {
  if (!canInterrupt(name)) return false;

  holdUntil = holdTab === name ? Math.max(holdUntil, Date.now() + ms) : Date.now() + ms;
  holdTab = name;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(choosePage, holdUntil - Date.now() + 20);
  choosePage();
  return true;
}

function showBluetoothFor(ms) {
  return showTabFor('bluetooth', ms);
}

// ---------- scrolling between tabs ----------

// At the first/last tab there's nowhere to go, so the page gives a little rubber-band nudge.
function nudge(delta) {
  const page = pages[activePage];
  if (!page) return;

  page.animate(
    [
      { transform: 'translateY(0)' },
      { transform: `translateY(${-delta * 5}px)`, offset: 0.35 },
      { transform: 'translateY(0)' },
    ],
    { duration: 450, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
  );
}

function stepTab(delta) {
  if (activePage === 'notice' || alarmActive) return; // wait out a notice; an alarm needs Stop

  const tabs = availableTabs();
  const index = tabs.indexOf(activePage);
  const next = tabs[index + delta];
  if (index < 0 || !next) return nudge(delta);

  // You've taken over. A notice that something more important had pushed aside is still armed
  // underneath, and would pop back over your tab on the next update, so end it now.
  if (noticeActive) cancelNotice();

  selectedTab = next;
  holdUntil = 0; // you've chosen; don't snap back to a pending hold
  setPage(next, { manual: true, dir: delta });
}

let wheelDistance = 0;
let wheelReset;
let lastSwitch = 0;

// Scroll down (or right) for the next tab, up (or left) for the previous. A mouse wheel notch is
// one switch; a trackpad swipe is one switch too, with its momentum ignored.
dock.addEventListener('wheel', (event) => {
  const now = performance.now();
  if (now - lastSwitch < WHEEL_COOLDOWN_MS) {
    wheelDistance = 0;
    return;
  }

  wheelDistance += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  clearTimeout(wheelReset);
  wheelReset = setTimeout(() => { wheelDistance = 0; }, 180);

  if (Math.abs(wheelDistance) >= WHEEL_STEP) {
    const delta = Math.sign(wheelDistance);
    wheelDistance = 0;
    lastSwitch = now;
    stepTab(delta);
  }
}, { passive: true });

// ---------- moving the dock ----------

// Press and hold anywhere on the dock (without moving) and it lifts; then drag it wherever you like.
// Drop it on the taskbar to send it back there. A quick press, a normal click and dragging a file out
// of the shelf all work as before, since those either let go or move before the hold completes.
const HOLD_TO_MOVE_MS = 450;
const HOLD_SLOP_PX = 4; // moving further than this before the hold completes cancels it

let hold = null; // { id, x, y, timer } while a press might become a move
let moveActive = false;
let swallowClick = false; // the click that ends a move mustn't press whatever is under the pointer

function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold = null;
}

function beginMove(pointerId) {
  hold = null;
  moveActive = true;
  swallowClick = true;
  try {
    dock.setPointerCapture(pointerId);
  } catch {
    // the pointer is already gone; the pointerup below still ends the move
  }
  dock.classList.add('moving');
  dock.animate([{ scale: 1 }, { scale: 0.94 }, { scale: 1 }], { duration: 300, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
  window.snappy.startMove();
}

function endMove() {
  cancelHold();
  if (!moveActive) return;
  moveActive = false;
  dock.classList.remove('moving');
  window.snappy.endMove();
}

dock.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || moveActive) return;
  swallowClick = false;
  cancelHold();
  const { pointerId, screenX, screenY } = event;
  hold = { id: pointerId, x: screenX, y: screenY, timer: setTimeout(() => beginMove(pointerId), HOLD_TO_MOVE_MS) };
}, true);

dock.addEventListener('pointermove', (event) => {
  if (hold && Math.hypot(event.screenX - hold.x, event.screenY - hold.y) > HOLD_SLOP_PX) cancelHold();
}, true);

dock.addEventListener('pointerup', endMove, true);
dock.addEventListener('pointercancel', endMove, true);
dock.addEventListener('lostpointercapture', () => { if (moveActive) endMove(); });

// While it's lifted, don't let the press start a file drag or end in a click.
dock.addEventListener('dragstart', (event) => {
  if (moveActive) event.preventDefault();
}, true);

dock.addEventListener('click', (event) => {
  if (!swallowClick) return;
  swallowClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);

// ---------- placement ----------

// The main process says which screen edge the taskbar is on and which side the dock is anchored to.
// Next to a taskbar on the right the dock is anchored right, so it grows (and bounces) leftwards.
// On a vertical taskbar it also sends the tile's width, and the dock rests as that tile.
window.snappy.onPlacement(({ edge, anchor, tile }) => {
  document.body.dataset.edge = edge;
  document.body.dataset.anchor = anchor;
  document.body.classList.toggle('tile-mode', Number.isFinite(tile));
  tileWidth = Number.isFinite(tile) ? tile : null;
  layoutDock();
});

choosePage();
