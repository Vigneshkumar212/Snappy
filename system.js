// The System tab: CPU and memory as liquid gauges, plus network speed. The main process only
// samples while this tab is on screen, so it costs nothing the rest of the time.

const systemPage = pages.system;
const cpuGauge = systemPage.querySelector('[data-metric="cpu"] .sys-gauge');
const ramGauge = systemPage.querySelector('[data-metric="ram"] .sys-gauge');
const downEl = systemPage.querySelector('.sys-down');
const upEl = systemPage.querySelector('.sys-up');

const HOT_PERCENT = 85; // the water turns red above this
let watching = false;

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;

  const kb = bytesPerSecond / 1024;
  if (kb < 1024) return `${kb < 100 ? kb.toFixed(1) : Math.round(kb)} KB/s`;

  const mb = kb / 1024;
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
}

function setGauge(gauge, percent) {
  gauge.style.setProperty('--level', percent / 100);
  gauge.querySelector('.gauge-label').textContent = percent;
  gauge.classList.toggle('hot', percent >= HOT_PERCENT);
}

// Ask for samples only while this tab is actually visible.
function syncWatching() {
  const wanted = activePage === 'system' && !document.hidden;
  if (wanted === watching) return;

  watching = wanted;
  window.snappy.system.watch(wanted);
}

window.addEventListener('pagechange', syncWatching);
document.addEventListener('visibilitychange', syncWatching);

window.snappy.system.onChange((stats) => {
  setGauge(cpuGauge, stats.cpu);
  setGauge(ramGauge, stats.ram);
  downEl.textContent = `↓ ${formatSpeed(stats.down)}`;
  upEl.textContent = `↑ ${formatSpeed(stats.up)}`;
});
