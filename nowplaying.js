// "Now playing": the cover (at its own aspect ratio) with title and artist beside it, on a
// background colour picked from the cover. A new track first shows the cover alone; then the
// text slides out from behind it while the dock springs wider and the background wipes in.

const artEl = document.getElementById('art');
const artLayers = [...artEl.querySelectorAll('.art-layer')];
const progressBar = artEl.querySelector('.progress .fill');
const coverEl = document.querySelector('.cover');
const npEl = document.getElementById('np');
const titleEl = npEl.querySelector('.np-title');
const titleText = titleEl.querySelector('.t');
const artistEl = npEl.querySelector('.np-artist');

const COVER_HEIGHT = 32;
const MIN_ASPECT = 0.75;
const MAX_ASPECT = 1.8;
const FALLBACK_BACKGROUND = 'linear-gradient(105deg, hsl(240 6% 24%), hsl(240 6% 14%))';
const MAX_MEDIA_WIDTH = 250 - 4 - 14; // the music dock is at most 250px (4px in on the left, 14px of room on the right)
const MIN_MEDIA_WIDTH = 160 - 4 - 14;  // ...and never so narrow that the hover controls don't fit
const COVER_TEXT_GAP = 10;
const TEXT_END_GAP = 12;
const FALLBACK_ACCENT = '#d9d9de';
const HIDE_DELAY = 2500; // players report "nothing" briefly between tracks
const COVER_REVEAL_MS = 1500; // how long the cover shows on its own before the text slides out

let current = null;     // last media payload
let lastKey = null;     // key of the last track shown, kept across hide/show
let suppressNextReveal = false;
let progress = null;    // { pos, dur, at, playing } for interpolating the progress bar
let activeLayer = -1;
let artZ = 0;
let artCleanup;
let coverToken = 0;
let hideTimer;
let endTimer;
let swapTimer;
let revealTimer;

// ---------- cover + colours ----------

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];

  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

// Picks the most prominent colourful hue in the image and turns it into a dark gradient that
// white text reads well on, plus a bright accent of the same hue. Greyscale covers get neutrals.
function backgroundFor(img) {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const BUCKETS = 12;
  const buckets = Array.from({ length: BUCKETS }, () => ({ weight: 0, s: 0 }));
  let luminance = 0;
  let counted = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    luminance += l;
    counted++;

    // Favour saturated, mid-lightness pixels; ignore near-black/white and greys.
    const weight = s * (1 - Math.abs(2 * l - 1));
    const bucket = buckets[Math.floor(h / (360 / BUCKETS)) % BUCKETS];
    bucket.weight += weight;
    bucket.s += s * weight;
  }

  const best = buckets.reduce((a, b, i) => (b.weight > a.weight ? { ...b, index: i } : a), { weight: 0, index: 0 });
  if (!counted || best.weight < counted * 0.04) {
    const grey = Math.round(Math.min(0.3, Math.max(0.14, (luminance / (counted || 1)) * 0.5)) * 100);
    return {
      background: `linear-gradient(105deg, hsl(240 5% ${grey + 6}%), hsl(240 5% ${Math.max(8, grey - 4)}%))`,
      accent: FALLBACK_ACCENT,
    };
  }

  const hue = (best.index + 0.5) * (360 / BUCKETS);
  const sat = Math.round(Math.min(0.7, Math.max(0.35, best.s / best.weight)) * 100);
  return {
    background: `linear-gradient(105deg, hsl(${hue} ${sat}% 30%), hsl(${(hue + 22) % 360} ${sat}% 18%))`,
    // The progress line uses the background's own hue and saturation, just lighter so it shows up on it.
    accent: `hsl(${hue} ${sat}% 64%)`,
  };
}

function analyzeArt(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, img.naturalWidth / img.naturalHeight));
      resolve({ aspect, ...backgroundFor(img) });
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function showBackground(background) {
  activeLayer = (activeLayer + 1) % artLayers.length;
  const next = artLayers[activeLayer];
  next.style.background = background;

  // The new layer fades in on top of the old one (so there's no dip mid-crossfade),
  // and the old one is dropped once it's covered.
  next.style.zIndex = ++artZ;
  next.classList.remove('on');
  void next.offsetWidth;
  next.classList.add('on');

  clearTimeout(artCleanup);
  artCleanup = setTimeout(() => {
    artLayers.forEach((layer) => layer !== next && layer.classList.remove('on'));
  }, 1000);
}

// Sets the cover and background for a track. Resolves once they're in place.
async function setCover(media) {
  const token = ++coverToken;
  const info = media.art ? await analyzeArt(media.art) : null;
  if (token !== coverToken) return; // a newer track took over while we were decoding

  const aspect = info ? info.aspect : 1;
  dock.style.setProperty('--cover-w', `${(COVER_HEIGHT * aspect).toFixed(1)}px`);
  coverEl.style.backgroundImage = info ? `url("${media.art}")` : '';
  coverEl.classList.toggle('empty', !info);

  coverEl.classList.remove('pop');
  void coverEl.offsetWidth;
  coverEl.classList.add('pop');

  showBackground(info ? info.background : FALLBACK_BACKGROUND);
  dock.style.setProperty('--accent', info ? info.accent : FALLBACK_ACCENT);

  // The cover-only dock hugs the cover, and the full dock's width depends on the cover too.
  updateMediaWidth();
}

// ---------- title / artist ----------

// Long titles drift sideways. Needs the text box to actually have room, so it's skipped while
// the cover is shown on its own (the box is collapsed then) and redone when the text slides out.
function fitTitle() {
  titleEl.classList.remove('overflowing');
  if (titleEl.clientWidth < 20) return;

  const overflow = titleText.offsetWidth - titleEl.clientWidth;
  if (overflow > 4) {
    titleEl.style.setProperty('--shift', `${-(overflow + 8)}px`);
    titleEl.style.setProperty('--marquee-duration', `${Math.max(5, overflow / 22 + 3)}s`);
    titleEl.classList.add('overflowing');
  }
}

// The music dock is as wide as its text needs, capped at 250px (and not narrower than the hover
// controls need). The dock springs to the new width like any other change.
function updateMediaWidth() {
  const coverW = parseFloat(dock.style.getPropertyValue('--cover-w')) || COVER_HEIGHT;
  const textW = Math.max(titleText.offsetWidth, artistEl.hidden ? 0 : artistEl.scrollWidth);
  const width = Math.min(MAX_MEDIA_WIDTH, Math.max(MIN_MEDIA_WIDTH, Math.ceil(coverW + COVER_TEXT_GAP + textW + TEXT_END_GAP)));

  dock.style.setProperty('--media-w', `${width}px`);
  if (activePage === 'media') layoutDock();
}

function setText(media) {
  titleText.textContent = media.title;
  artistEl.textContent = media.artist || media.album || '';
  artistEl.hidden = !artistEl.textContent;
  updateMediaWidth();
  requestAnimationFrame(fitTitle);
}

function swapText(media, animateOut) {
  clearTimeout(swapTimer);
  npEl.classList.remove('swap-in');

  const enter = () => {
    setText(media);
    npEl.classList.remove('swap-out');
    void npEl.offsetWidth;
    npEl.classList.add('swap-in');
  };

  if (animateOut) {
    npEl.classList.add('swap-out');
    swapTimer = setTimeout(enter, 230);
  } else {
    enter();
  }
}

// ---------- progress ----------

function progressNow() {
  if (!progress || !progress.dur) return 0;
  const elapsed = progress.playing ? (performance.now() - progress.at) / 1000 : 0;
  return Math.min(1, Math.max(0, (progress.pos + elapsed) / progress.dur));
}

// Nudged a few times a second with no CSS transition (see .progress in styles.css). On a 250px dock a
// four-minute track moves about a pixel per second, so each nudge is a fraction of a pixel.
const PROGRESS_TICK_MS = 500;

function setProgress() {
  progressBar.style.transform = `scaleX(${progressNow()})`;
}

setInterval(setProgress, PROGRESS_TICK_MS);

// ---------- cover reveal ----------

// On a new track, and when swapping back to this page: show just the cover for a moment, then
// let the text slide out and the dock open up. Pausing and playing the same track doesn't count.
// Skipped while the pointer is over the dock, since then you're using the controls and want the
// text and buttons.
// `layout: false` is for callers that lay the dock out themselves right afterwards.
function revealCover({ layout = true } = {}) {
  if (activePage !== 'media' || dock.matches(':hover')) return;

  clearTimeout(revealTimer);
  dock.classList.add('reveal');
  revealTimer = setTimeout(() => endReveal(), COVER_REVEAL_MS);
  if (layout) layoutDock({ bounce: true });
}

function endReveal({ layout = true } = {}) {
  clearTimeout(revealTimer);
  if (!dock.classList.contains('reveal')) return;

  dock.classList.remove('reveal');
  requestAnimationFrame(fitTitle);
  if (layout && activePage === 'media') layoutDock({ bounce: true });
}

dock.addEventListener('mouseenter', () => endReveal());
window.addEventListener('pagechange', (event) => {
  const { name, manual } = event.detail;
  if (name !== 'media') return endReveal({ layout: false });

  // The same track coming back after a pause (some players report "nothing" while paused) isn't new,
  // and scrolling to this tab yourself shouldn't make you wait through the cover.
  if (suppressNextReveal) suppressNextReveal = false;
  else if (!manual) revealCover({ layout: false });
});

// ---------- show / hide ----------

function hideMedia() {
  if (!current) return;
  current = null;

  // The background fades out while the Bluetooth page takes over (if anything's connected).
  dock.classList.add('media-out');
  setMediaPlaying(false);

  endTimer = setTimeout(() => dock.classList.remove('has-media', 'media-out', 'paused', 'reveal'), 460);
}

function applyMedia(media) {
  if (!media) {
    // Don't flicker away between tracks; wait to be sure nothing is playing.
    if (current && !hideTimer) hideTimer = setTimeout(() => { hideTimer = null; hideMedia(); }, HIDE_DELAY);
    return;
  }

  clearTimeout(hideTimer);
  hideTimer = null;
  clearTimeout(endTimer);
  dock.classList.remove('media-out');

  const firstShow = !current;
  const trackChanged = firstShow || current.key !== media.key;
  const artChanged = firstShow || current.art !== media.art;
  if (firstShow && media.key === lastKey) suppressNextReveal = true;
  lastKey = media.key;
  current = media;

  progress = { pos: media.pos, dur: media.dur, at: performance.now(), playing: media.status === 'Playing' };

  dock.classList.add('has-media');
  dock.classList.toggle('paused', media.status !== 'Playing');

  const coverReady = artChanged ? setCover(media) : Promise.resolve();

  if (trackChanged) {
    if (firstShow) {
      setText(media); // the page itself animates in
    } else if (dock.matches(':hover')) {
      swapText(media, true); // using the controls: keep the text and animate the swap
    } else {
      setText(media); // the text is tucked behind the cover for the reveal anyway
      revealCover();
    }
  }
  setProgress();

  // On first show, wait for the cover so the page doesn't spring in empty.
  if (firstShow) {
    coverReady.then(() => {
      if (current !== media) return;
      preferTab('media'); // music coming on takes the dock, even if you were on another tab
      setMediaPlaying(true);
      suppressNextReveal = false; // only ever applies to the page change triggered just above
    });
  } else {
    setMediaPlaying(true);
  }
}

// ---------- controls ----------

function togglePlayback() {
  // Respond instantly; the watcher confirms with the real state a moment later.
  if (!current) return;
  const playing = current.status !== 'Playing';
  current = { ...current, status: playing ? 'Playing' : 'Paused' };

  const elapsed = progress && progress.playing ? (performance.now() - progress.at) / 1000 : 0;
  progress = { ...progress, pos: progress.pos + elapsed, at: performance.now(), playing };

  dock.classList.toggle('paused', !playing);
  setProgress();
}

document.querySelector('.controls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-cmd]');
  if (!button) return;

  const command = button.dataset.cmd;
  if (command === 'toggle') togglePlayback();
  window.snappy.media.command(command);
});

window.snappy.media.onChange(applyMedia);
window.snappy.media.get().then((media) => {
  if (media && !current) applyMedia(media);
});
