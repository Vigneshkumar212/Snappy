// The Timer tab: a Pomodoro (focus and break cycles) or a plain countdown. The circle is the same
// liquid gauge as the battery: the water drains as the time runs out. It keeps running while you're
// on another tab (its dot turns green), and when a phase ends the dock rings until you stop it.

const timerPage = pages.timer;
const timerGauge = timerPage.querySelector('.tm-gauge');
const timerGaugeLabel = timerGauge.querySelector('.gauge-label');
const timerTime = timerPage.querySelector('.tm-time');
const timerPhaseLabel = timerPage.querySelector('.tm-label');
const timerMinus = timerPage.querySelector('[data-act="minus"]');
const timerPlus = timerPage.querySelector('[data-act="plus"]');
const timerSkip = timerPage.querySelector('[data-act="skip"]');
const modePills = {
  pomodoro: timerPage.querySelector('[data-act="mode-pomodoro"]'),
  timer: timerPage.querySelector('[data-act="mode-timer"]'),
};

const POMODORO = { focus: 25, short: 5, long: 15, rounds: 4 }; // minutes, and rounds before a long break
const PRESETS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90];  // what + and - step through in timer mode
const AUTO_START_BREAKS = true; // a break starts by itself when focus ends; the next focus waits for you
const ALARM_SOUND_MS = 2200;    // how often the beeps repeat while the alarm rings
const ALARM_MAX_MS = 2 * 60 * 1000; // an alarm nobody answers gives up after this
const TICK_MS = 500;
const WATER_STEP = 0.005;       // only move the water when the level changed by this much (stays calm and cheap)
const STORE_KEY = 'snappy.timer';

let timerMode = 'pomodoro'; // 'pomodoro' | 'timer'
let timerMinutes = 10;      // the countdown length in timer mode
let phase = 'focus';        // 'focus' | 'short' | 'long' | 'timer'
let round = 1;
let remainingMs = 0;
let endsAt = null;          // when it will finish, while running
let ticking = null;
let shownLevel = -1;

// ---------- saved settings ----------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && (saved.mode === 'pomodoro' || saved.mode === 'timer')) timerMode = saved.mode;
    if (saved && PRESETS.includes(saved.minutes)) timerMinutes = saved.minutes;
  } catch {
    // no saved settings, or storage unavailable: use the defaults
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ mode: timerMode, minutes: timerMinutes }));
  } catch {
    // not worth failing over
  }
}

// ---------- the clock ----------

const isRunning = () => endsAt !== null;
const timerVisible = () => activePage === 'timer' && !document.hidden;

function phaseMs() {
  const minutes = timerMode === 'timer' ? timerMinutes : POMODORO[phase];
  return minutes * 60 * 1000;
}

function timeLeft() {
  return isRunning() ? Math.max(0, endsAt - Date.now()) : remainingMs;
}

function startTicking() {
  clearInterval(ticking);
  ticking = setInterval(onTick, TICK_MS);
}

function stopTicking() {
  clearInterval(ticking);
  ticking = null;
}

function onTick() {
  if (timeLeft() <= 0) return completePhase();
  if (timerVisible()) renderTimer();
}

function startTimer() {
  if (isRunning()) return;
  endsAt = Date.now() + remainingMs;
  startTicking();
  setTimerRunning(true);
  renderTimer({ force: true });
}

function pauseTimer() {
  if (!isRunning()) return;
  remainingMs = timeLeft();
  endsAt = null;
  stopTicking();
  setTimerRunning(false);
  renderTimer({ force: true });
}

// Back to the start of the current phase, not running.
function resetTimer() {
  endsAt = null;
  stopTicking();
  remainingMs = phaseMs();
  setTimerRunning(false);
  renderTimer({ force: true });
}

function switchTimerMode(mode) {
  if (mode === timerMode) return;
  timerMode = mode;
  phase = mode === 'timer' ? 'timer' : 'focus';
  round = 1;
  saveSettings();
  resetTimer();
}

function stepMinutes(direction) {
  if (timerMode !== 'timer' || isRunning()) return;

  // Move to the next preset up or down from wherever the current length falls.
  const index = PRESETS.findIndex((minutes) => minutes >= timerMinutes);
  const here = index === -1 ? PRESETS.length - 1 : index;
  timerMinutes = PRESETS[Math.min(PRESETS.length - 1, Math.max(0, here + direction))];
  saveSettings();
  resetTimer();
}

// What comes after the current Pomodoro phase.
function nextPomodoroPhase() {
  if (phase === 'focus') return round % POMODORO.rounds === 0 ? 'long' : 'short';
  return 'focus';
}

function advancePhase() {
  const finished = phase;
  phase = nextPomodoroPhase();
  if (finished === 'long') round = 1;
  else if (finished !== 'focus') round += 1; // a short break ends the round
  remainingMs = phaseMs();
}

// Moves on to the next phase without ceremony (the skip button).
function skipPhase() {
  if (timerMode !== 'pomodoro') return;
  endsAt = null;
  stopTicking();
  advancePhase();
  setTimerRunning(false);
  renderTimer({ force: true });
}

// A finished phase doesn't just ping once: the dock rings (glowing, shaking, beeping) until you press
// Stop. For a Pomodoro the break only starts once you've stopped it, so it never runs behind an alarm.
function completePhase() {
  stopTicking();
  endsAt = null;

  if (timerMode === 'timer') {
    remainingMs = phaseMs();
    setTimerRunning(false);
    renderTimer({ force: true });
    return startAlarm("Time's up", `${timerMinutes} min timer done`);
  }

  const finished = phase;
  advancePhase();
  setTimerRunning(false);
  renderTimer({ force: true });

  if (finished === 'focus') {
    const status = phase === 'long' ? 'Time for a long break' : 'Time for a break';
    startAlarm('Focus complete', status, AUTO_START_BREAKS ? startTimer : null);
  } else {
    startAlarm('Break over', 'Back to focus');
  }
}

// ---------- the alarm ----------

const alarmTitle = pages.alarm.querySelector('.alarm-title');
const alarmStatus = pages.alarm.querySelector('.alarm-status');
let alarm = null; // { soundTimer, giveUpTimer, followUp } while ringing

function startAlarm(title, status, followUp = null) {
  stopAlarm({ runFollowUp: false });

  alarmTitle.textContent = title;
  alarmStatus.textContent = status;
  alarm = {
    followUp,
    soundTimer: setInterval(playAlarmBurst, ALARM_SOUND_MS),
    giveUpTimer: setTimeout(() => stopAlarm({ runFollowUp: false }), ALARM_MAX_MS), // never ring forever
  };

  playAlarmBurst();
  dock.classList.add('alarm');
  setAlarmActive(true);
}

function stopAlarm({ runFollowUp = true } = {}) {
  if (!alarm) return;

  clearInterval(alarm.soundTimer);
  clearTimeout(alarm.giveUpTimer);
  const { followUp } = alarm;
  alarm = null;

  dock.classList.remove('alarm');
  setAlarmActive(false);
  if (runFollowUp && followUp) followUp();
}

// Three quick beeps, repeated while the alarm rings. Made with the Web Audio API, so there's no
// sound file to ship.
function playAlarmBurst() {
  try {
    const context = new AudioContext();
    const start = context.currentTime;

    [[880, 0], [880, 0.2], [1174.66, 0.4]].forEach(([frequency, offset]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.3, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.2);
    });

    setTimeout(() => context.close(), 1500);
  } catch {
    // no audio available: the glow and shake still show
  }
}

pages.alarm.addEventListener('click', (event) => {
  if (event.target.closest('[data-act="stop-alarm"]')) stopAlarm();
});

// ---------- drawing it ----------

function formatTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function phaseText() {
  if (timerMode === 'timer') return 'Timer';
  if (phase === 'focus') return `Focus ${round}/${POMODORO.rounds}`;
  return phase === 'long' ? 'Long break' : 'Short break';
}

// `force` redraws everything (a button was pressed); the per-tick redraw only touches what changes.
function renderTimer({ force = false } = {}) {
  const left = timeLeft();
  const total = phaseMs();
  const running = isRunning();

  timerTime.textContent = formatTime(left);
  timerTime.classList.toggle('idle', !running);
  timerGaugeLabel.textContent = Math.ceil(left / 60000);

  // The water only moves when it has really changed (or on a button press, where it springs).
  const level = total > 0 ? left / total : 0;
  if (force || Math.abs(level - shownLevel) >= WATER_STEP) {
    timerGauge.style.setProperty('--level', level);
    shownLevel = level;
  }

  if (!force) return;

  timerPhaseLabel.textContent = phaseText();
  timerGauge.classList.toggle('rest', timerMode === 'pomodoro' && phase !== 'focus');
  timerPage.classList.toggle('running', running);

  const inTimerMode = timerMode === 'timer';
  timerMinus.hidden = timerPlus.hidden = !inTimerMode || running;
  timerSkip.hidden = inTimerMode;
  modePills.pomodoro.classList.toggle('on', !inTimerMode);
  modePills.timer.classList.toggle('on', inTimerMode);
}

// ---------- buttons ----------

function setTimerPageMode(mode) {
  timerPage.dataset.mode = mode;
}

const timerActions = {
  toggle: () => (isRunning() ? pauseTimer() : startTimer()),
  minus: () => stepMinutes(-1),
  plus: () => stepMinutes(1),
  skip: skipPhase,
  menu: () => setTimerPageMode('menu'),
  close: () => setTimerPageMode('view'),
  reset: () => { resetTimer(); setTimerPageMode('view'); },
  'mode-pomodoro': () => { switchTimerMode('pomodoro'); setTimerPageMode('view'); },
  'mode-timer': () => { switchTimerMode('timer'); setTimerPageMode('view'); },
};

timerPage.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (button) timerActions[button.dataset.act]?.();
});

window.addEventListener('pagechange', (event) => {
  if (event.detail.name === 'timer') renderTimer({ force: true });
  else if (timerPage.dataset.mode === 'menu') setTimerPageMode('view'); // don't leave the options open behind you
});

// ---------- start-up ----------

loadSettings();
phase = timerMode === 'timer' ? 'timer' : 'focus';
remainingMs = phaseMs();
renderTimer({ force: true });
