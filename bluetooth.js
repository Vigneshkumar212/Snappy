// Connected Bluetooth devices, shown as chips: [battery circle] name.
// A device connecting or disconnecting is announced first with a notice (its name, then
// "Connected" / "Disconnected"); after a connect, the chip then shows with the battery level.

const devicesEl = document.getElementById('devices');
const chips = new Map(); // device name -> { el, gauge, label, level, battery, timers, tween }
const pendingChips = new Set(); // connected, waiting for their notice to finish before showing

const LOW_BATTERY = 20;
const CHIP_HOLD_MS = 3500; // how long the Bluetooth page stays up after a connect, so the battery is seen
const BLUETOOTH_GLYPH = '<svg class="gauge-glyph" viewBox="0 0 24 24"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>';

function announceMarkup(name) {
  return [...name]
    .map((ch, i) => `<span class="ch" style="--i:${i}">${ch === ' ' ? '&nbsp;' : escapeHtml(ch)}</span>`)
    .join('');
}

function escapeHtml(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML;
}

function setBattery(chip, battery) {
  const known = typeof battery === 'number';
  chip.gauge.classList.toggle('unknown', !known);
  if (!known) return;

  chip.gauge.classList.toggle('low', battery <= LOW_BATTERY);
  chip.gauge.style.setProperty('--level', battery / 100);
  tweenLabel(chip, battery);
}

function tweenLabel(chip, to, ms = 800) {
  cancelAnimationFrame(chip.tween);
  const from = chip.level;
  const start = performance.now();

  const step = (now) => {
    const t = Math.min((now - start) / ms, 1);
    chip.level = from + (to - from) * (1 - Math.pow(1 - t, 3));
    chip.label.textContent = Math.round(chip.level);
    if (t < 1) chip.tween = requestAnimationFrame(step);
  };
  chip.tween = requestAnimationFrame(step);
}

function createChip(device) {
  const el = document.createElement('div');
  el.className = 'chip';
  el.innerHTML = `
    <div class="chip-body">
      <div class="gauge">
        <div class="water"></div>
        <span class="gauge-label">0</span>
        ${BLUETOOTH_GLYPH}
      </div>
      <span class="chip-name"></span>
    </div>`;
  el.querySelector('.chip-name').textContent = device.name;

  return {
    el,
    gauge: el.querySelector('.gauge'),
    label: el.querySelector('.gauge-label'),
    level: 0,
    battery: device.battery, // latest reading, applied once the chip is shown
    timers: [],
  };
}

function showChip(chip) {
  chip.el.classList.add('shown');
  // Let the circle pop in first, then the water rises.
  chip.timers.push(setTimeout(() => setBattery(chip, chip.battery), 180));
}

// Chips for devices that just connected stay hidden until their notice is over, then show together
// with the battery level, and the Bluetooth page stays up long enough to see them.
function revealPendingChips() {
  if (!pendingChips.size) return;

  showBluetoothFor(CHIP_HOLD_MS);
  pendingChips.forEach(showChip);
  pendingChips.clear();
}

function connect(device, initial) {
  const chip = createChip(device);
  chips.set(device.name, chip);
  devicesEl.appendChild(chip.el);

  if (initial) {
    // Already connected when Snappy started: just appear, no announcement.
    setHasDevices(true);
    layoutDock();
    showChip(chip);
    return;
  }

  // The notice takes over the dock first, so the chip is laid out behind it.
  pendingChips.add(chip);
  showNotice(device.name, 'Connected', 'ok');
  setHasDevices(true);
}

// ---------- connect / disconnect notice ----------

const noticeEl = document.getElementById('notice');
const noticeName = noticeEl.querySelector('.notice-name');
const noticeStatus = noticeEl.querySelector('.notice-status');

const NOTICE_STATUS_DELAY_MS = 1000; // the status springs in this long after the name starts
const NOTICE_HOLD_MS = 1500;        // how long both stay once the status has landed
const NOTICE_SETTLE_MS = 750;       // the spring-in
const NOTICE_FADE_MS = 380;
let noticeTimers = [];

// Shows "<name>" then the status ("Connected" / "Disconnected"), fades both out, then hands the
// dock back to whatever was there before: the music, the devices, or nothing.
function showNotice(name, status, kind) {
  noticeTimers.forEach(clearTimeout);

  noticeName.innerHTML = announceMarkup(name); // new spans restart the letter animation
  noticeStatus.textContent = status;
  noticeStatus.dataset.kind = kind;
  noticeEl.classList.remove('out');
  noticeStatus.classList.remove('in');
  setNoticeActive(true);

  const fadeAt = NOTICE_STATUS_DELAY_MS + NOTICE_SETTLE_MS + NOTICE_HOLD_MS;
  noticeTimers = [
    setTimeout(() => noticeStatus.classList.add('in'), NOTICE_STATUS_DELAY_MS),
    setTimeout(() => noticeEl.classList.add('out'), fadeAt),
    setTimeout(() => {
      revealPendingChips(); // before the notice ends, so the dock goes straight to the Bluetooth page
      setNoticeActive(false);
    }, fadeAt + NOTICE_FADE_MS),
  ];
}

function disconnect(name, chip) {
  chips.delete(name);
  pendingChips.delete(chip);
  chip.timers.forEach(clearTimeout);
  cancelAnimationFrame(chip.tween);

  // The notice takes over the dock first; the chip is removed behind it, and the remaining chips
  // slide into the gap so they're already in place when the dock comes back to them.
  showNotice(name, 'Disconnected', 'bad');
  reflow(() => chip.el.remove());
  setHasDevices(chips.size > 0);
}

let first = true;

function applyDevices(devices) {
  const initial = first; // devices already connected at launch just appear, no announcement
  first = false;

  const names = new Set(devices.map((d) => d.name));
  for (const [name, chip] of [...chips]) {
    if (!names.has(name)) disconnect(name, chip);
  }

  for (const device of devices) {
    const chip = chips.get(device.name);
    if (!chip) {
      connect(device, initial);
    } else {
      chip.battery = device.battery;
      if (chip.el.classList.contains('shown')) setBattery(chip, device.battery);
    }
  }
}

window.snappy.bluetooth.onChange(applyDevices);
window.snappy.bluetooth.get().then((devices) => {
  if (devices) applyDevices(devices);
});
