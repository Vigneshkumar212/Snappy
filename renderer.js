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
};

let activePage = null;
let mediaPlaying = false;
let hasDevices = false;
let fileCount = 0;
let dragActive = false; // something is being dragged over the dock
let noticeActive = false;
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

// Size the dock to the active page. `bounce` forces the animation even if the width is unchanged.
function layoutDock({ bounce = false } = {}) {
  const page = pages[activePage || 'bluetooth'];
  const style = getComputedStyle(page);
  const padLeft = parseFloat(style.left) || 0;                                   // each page sets its own insets
  const padRight = parseFloat(style.getPropertyValue('--pad-right')) || padLeft; // (right defaults to the left)
  const width = Math.ceil(padLeft + page.offsetWidth + padRight);

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

const TAB_ORDER = ['media', 'bluetooth', 'files'];
const WHEEL_STEP = 50;          // scroll distance that counts as one swipe
const WHEEL_COOLDOWN_MS = 550;  // ignore the tail of a trackpad swipe after switching
const DOTS_SHOW_MS = 1600;
const tabsEl = document.getElementById('tabs');
let dotsTimer;

// A tab exists only while it has something to show.
function availableTabs() {
  const present = { media: mediaPlaying, bluetooth: hasDevices, files: fileCount > 0 };
  return TAB_ORDER.filter((name) => present[name]);
}

// Little dots show which tab you're on. They appear on hover, and briefly after a switch.
function renderTabs() {
  const tabs = availableTabs();
  tabsEl.hidden = tabs.length < 2;
  while (tabsEl.children.length < tabs.length) tabsEl.appendChild(document.createElement('i')).className = 'tab-dot';
  while (tabsEl.children.length > tabs.length) tabsEl.lastChild.remove();
  [...tabsEl.children].forEach((dot, i) => dot.classList.toggle('active', tabs[i] === activePage));
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
      const forwards = name === 'notice' || activePage === 'notice' || activePage === null
        || TAB_ORDER.indexOf(name) >= TAB_ORDER.indexOf(activePage);
      dir = forwards ? 1 : -1;
    }

    activePage = name;
    dock.dataset.page = name; // lets CSS react to the active page (e.g. hide the music progress line)
    dock.style.setProperty('--dir', dir);
    for (const [key, el] of Object.entries(pages)) el.classList.toggle('active', key === name);
    window.dispatchEvent(new CustomEvent('pagechange', { detail: { name, manual } }));
    if (name !== 'notice') flashTabs();
  }
  layoutDock({ bounce: changed });
  renderTabs();
}

// Decides what the dock shows: the shelf while something is being dragged over, then a notice,
// then a tab that was asked to show for a while, then the tab you chose, then the first tab
// that has something.
function choosePage() {
  if (dragActive) return setPage('files'); // so it can be dropped, whichever tab you were on
  if (noticeActive) return setPage('notice'); // the other pages come back when it ends

  const tabs = availableTabs();
  let name;
  if (Date.now() < holdUntil && tabs.includes(holdTab)) name = holdTab;
  else if (tabs.includes(selectedTab)) name = selectedTab;
  else name = tabs[0] || 'bluetooth'; // nothing to show: the (empty) Bluetooth page

  setPage(name);
}

function setNoticeActive(active) {
  noticeActive = active;
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

// Make a tab the one that's shown (the caller lays the page out afterwards).
function preferTab(name) {
  selectedTab = name;
}

// Show a tab for at least `ms` (the Bluetooth tab after a connect, so the battery gets seen; the
// shelf after a drop), then go back to the tab you were on.
function showTabFor(name, ms) {
  holdUntil = holdTab === name ? Math.max(holdUntil, Date.now() + ms) : Date.now() + ms;
  holdTab = name;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(choosePage, holdUntil - Date.now() + 20);
  choosePage();
}

function showBluetoothFor(ms) {
  showTabFor('bluetooth', ms);
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
  if (noticeActive) return;

  const tabs = availableTabs();
  const index = tabs.indexOf(activePage);
  const next = tabs[index + delta];
  if (index < 0 || !next) return nudge(delta);

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

choosePage();
