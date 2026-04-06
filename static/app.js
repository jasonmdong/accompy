// ── Key → MIDI pitch mapping ────────────────────────────────────────────────
const KEY_MAP = {
  // C3 whites
  z:48,x:50,c:52,v:53,b:55,n:57,m:59,
  // C3 sharps (Shift)
  Z:49,X:51,        V:54,B:56,N:58,
  // C4 whites
  a:60,s:62,d:64,f:65,g:67,h:69,j:71,
  // C4 sharps (Shift)
  A:61,S:63,        F:66,G:68,H:70,
  // C5 whites
  q:72,w:74,e:76,r:77,t:79,y:81,u:83,
  // C5 sharps (Shift)
  Q:73,W:75,        R:78,T:80,Y:82,
  // C6
  i:84,
};
// Which white keys have a sharp (Shift version)
const HAS_SHARP = new Set(['z','x','v','b','n','a','s','f','g','h','q','w','r','t','y']);
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function pitchName(midi) { return NOTE_NAMES[midi % 12] + (Math.floor(midi/12)-1); }

const INSTRUMENTS = ['piano','violin','viola','cello','strings','flute','clarinet','oboe'];
const INSTRUMENT_EMOJI = {
  piano:'🎹', violin:'🎻', viola:'🎻', cello:'🎻', strings:'🎻',
  flute:'🪈', clarinet:'🎷', oboe:'🎷',
};

// ── Web Audio Synth ─────────────────────────────────────────────────────────
let _audioCtx = null;
function audioCtx() {
  if (!_audioCtx) _audioCtx = new AudioContext();
  return _audioCtx;
}

// instrument presets: { harmonics: [[mult, amp]], attack, decay, sustain, release, type }
const INSTRUMENT_PRESETS = {
  piano:    { harmonics:[[1,.7],[2,.2],[3,.1]], attack:.008, decay:3.5,  type:'sine'    },
  violin:   { harmonics:[[1,.5],[2,.25],[3,.15],[4,.07],[5,.03]], attack:.06, decay:.4, type:'sawtooth', vibrato:true },
  viola:    { harmonics:[[1,.55],[2,.25],[3,.13],[4,.05],[5,.02]], attack:.07, decay:.35, type:'sawtooth', vibrato:true },
  cello:    { harmonics:[[1,.6],[2,.22],[3,.12],[4,.04],[5,.02]], attack:.08, decay:.3,  type:'sawtooth', vibrato:true },
  strings:  { harmonics:[[1,.5],[2,.2],[3,.15],[4,.1],[5,.05]],  attack:.09, decay:.25, type:'sawtooth', vibrato:true },
  flute:    { harmonics:[[1,.85],[2,.12],[3,.03]], attack:.04, decay:.4,  type:'sine',  noise:.04  },
  clarinet: { harmonics:[[1,.7],[3,.25],[5,.08],[7,.03]], attack:.025, decay:.5, type:'sine' },
  oboe:     { harmonics:[[1,.5],[2,.3],[3,.15],[4,.05]], attack:.02,  decay:.6,  type:'sine' },
};

function playNote(midi, velocity = 0.6, instrument = 'piano') {
  const ctx    = audioCtx();
  const freq   = 440 * Math.pow(2, (midi - 69) / 12);
  const preset = INSTRUMENT_PRESETS[instrument] || INSTRUMENT_PRESETS.piano;
  const now    = ctx.currentTime;
  const dur    = instrument === 'piano' ? 1.2 : 1.5;

  const masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);
  masterGain.gain.setValueAtTime(0, now);
  masterGain.gain.linearRampToValueAtTime(velocity * 0.35, now + preset.attack);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  preset.harmonics.forEach(([mult, amp]) => {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    g.gain.value = amp;
    osc.type = preset.type || 'sine';
    osc.frequency.value = freq * mult;

    // Vibrato for strings
    if (preset.vibrato) {
      const lfo  = ctx.createOscillator();
      const lfoG = ctx.createGain();
      lfo.frequency.value = 5.5;
      lfoG.gain.setValueAtTime(0, now);
      lfoG.gain.linearRampToValueAtTime(freq * 0.003, now + 0.15);
      lfo.connect(lfoG);
      lfoG.connect(osc.frequency);
      lfo.start(now); lfo.stop(now + dur);
    }
    osc.connect(g); g.connect(masterGain);
    osc.start(now); osc.stop(now + dur);
  });

  // Breath noise for flute
  if (preset.noise) {
    const buf    = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * preset.noise;
    const src  = ctx.createBufferSource();
    const noiseG = ctx.createGain();
    noiseG.gain.value = 0.3;
    src.buffer = buf;
    src.connect(noiseG); noiseG.connect(masterGain);
    src.start(now); src.stop(now + dur);
  }
}

function playChord(pitches, velocity = 0.5, instrument = 'piano') {
  pitches.forEach(p => playNote(p, velocity / pitches.length + 0.3, instrument));
}

// ── Tracker ──────────────────────────────────────────────────────────────────
class Tracker {
  constructor(rightHand, initialBps) {
    this.score      = rightHand;       // [[pitch, beat], ...]
    this.position   = 0;
    this.timestamps = [];              // [{time, beat}, ...]
    this._defaultBps = initialBps;
  }

  onNote(pitch) {
    const end = Math.min(this.position + 3, this.score.length);
    for (let i = this.position; i < end; i++) {
      if (this.score[i][0] === pitch) {
        this.position = i + 1;
        const beat = this.score[i][1];
        this.timestamps.push({ time: performance.now() / 1000, beat });
        if (this.timestamps.length > 5) this.timestamps.shift();
        return beat;
      }
    }
    return null;
  }

  bps() {
    const ts = this.timestamps;
    if (ts.length < 2) return this._defaultBps;
    const rates = [];
    for (let i = 1; i < ts.length; i++) {
      const dt = ts[i].time - ts[i-1].time;
      const db = ts[i].beat - ts[i-1].beat;
      if (dt > 0 && db > 0) rates.push(db / dt);
    }
    return rates.length ? rates.reduce((a,b)=>a+b)/rates.length : this._defaultBps;
  }

  isFinished() { return this.position >= this.score.length; }
  progress()   { return this.position / this.score.length; }
}

// ── Accompanist ──────────────────────────────────────────────────────────────
class Accompanist {
  constructor(leftHand, rightHand, initialBps, leftInstruments = []) {
    // leftInstruments: array of instrument names parallel to the non-selected parts
    // Each event gets the instrument of the source part it came from.
    // Since getLeftHand() merges parts in order, we track that here.
    this.events    = [...leftHand].sort((a,b) => a[1]-b[1]); // [[pitches,beat],...]
    this._instruments = leftInstruments;
    this.rhBeats   = [...new Set(rightHand.map(n=>n[1]))].sort((a,b)=>a-b);
    this._bps      = initialBps;
    this._syncBeat = 0;
    this._syncTime = null;   // null = waiting for first RH note
    this._nextSync = this.rhBeats[0] ?? Infinity;
    this._lhIdx    = 0;
    this._running  = false;
    this._raf      = null;
  }

  start() {
    this._running = true;
    this._tick();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  onRhNote(beat, bps) {
    this._bps      = bps;
    this._syncBeat = beat;
    this._syncTime = performance.now() / 1000;
    this._nextSync = this.rhBeats.find(b => b > beat + 0.01) ?? Infinity;
    // Skip LH events now in the past
    while (this._lhIdx < this.events.length && this.events[this._lhIdx][1] < beat - 0.05)
      this._lhIdx++;
  }

  _currentBeat() {
    if (this._syncTime === null) return 0;
    return this._syncBeat + (performance.now()/1000 - this._syncTime) * this._bps;
  }

  _tick() {
    if (!this._running) return;

    if (this._syncTime !== null && this._lhIdx < this.events.length) {
      const [pitches, beat] = this.events[this._lhIdx];

      // Pause before next RH sync point
      if (beat < this._nextSync - 0.01) {
        const current = this._currentBeat();
        if (current >= beat - 0.005) {
          const instr = this._instruments[0] || 'piano';
          playChord(pitches, 0.5, instr);
          this._lhIdx++;
        }
      }
    }

    this._raf = requestAnimationFrame(() => this._tick());
  }
}

// ── App State ────────────────────────────────────────────────────────────────
let state = {
  scores:           [],
  current:          null,
  tracker:          null,
  accompanist:      null,
  playing:          false,
  selectedPart:     0,
  partInstruments:  {},  // partIndex → instrument name override
};

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── Screens ──────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Score list screen ─────────────────────────────────────────────────────────
async function loadScoreList() {
  const { scores } = await api('/api/scores');
  state.scores = scores;
  const grid = document.getElementById('score-grid');
  grid.innerHTML = scores.map(name => `
    <div class="score-card" id="card-${name}">
      <div onclick="openScore('${name}')" style="flex:1;cursor:pointer">
        <h3>${formatName(name)}</h3>
        <small>${name}</small>
      </div>
      <button class="delete-btn" onclick="deleteScore(event, '${name}')" title="Remove">✕</button>
    </div>
  `).join('');
}

function formatName(name) {
  return name.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Play screen ───────────────────────────────────────────────────────────────
async function fetchScore(name) {
  const CACHE_KEY = `accompy_score_${name}`;
  try {
    // Cheap mtime check first
    const { mtime } = await api(`/api/scores/${name}/meta`);
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed._mtime === mtime) return parsed;
    }
    // Cache miss — fetch full data
    const data = await api(`/api/scores/${name}`);
    data._mtime = mtime;
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    return data;
  } catch {
    // Fallback: fetch without caching
    return api(`/api/scores/${name}`);
  }
}

async function openScore(name) {
  const data = await fetchScore(name);
  state.current = data;
  state.selectedPart = 0;
  state.partInstruments = {};

  document.getElementById('play-title').textContent = formatName(name);
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('next-note-display').textContent = '—';
  document.getElementById('beat-val').textContent  = '—';
  document.getElementById('tempo-val').textContent = '—';

  // Sheet music
  const frame = document.getElementById('sheet-frame');
  const placeholder = document.getElementById('sheet-placeholder');
  if (data.has_sheet) {
    frame.src = `/api/scores/${name}/sheet`;
    frame.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    frame.style.display = 'none';
    placeholder.style.display = 'block';
  }

  // Part picker
  const parts = data.parts || [];
  const picker = document.getElementById('part-picker');
  const btns   = document.getElementById('part-buttons');
  if (parts.length > 0) {
    btns.innerHTML = parts.map((p, i) => {
      const instr = p.instrument || 'piano';
      return `<div class="part-row" id="part-row-${i}">
        <button class="part-btn${i === 0 ? ' selected' : ''}"
                onclick="selectPart(${i})" id="part-btn-${i}">
          ${p.name}
        </button>
        <select class="instr-select" onchange="changeInstrument(${i}, this.value)" id="instr-${i}">
          ${INSTRUMENTS.map(ins =>
            `<option value="${ins}"${ins === instr ? ' selected' : ''}>${INSTRUMENT_EMOJI[ins] || '🎵'} ${ins}</option>`
          ).join('')}
        </select>
      </div>`;
    }).join('');
    picker.style.display = 'block';
  } else {
    picker.style.display = 'none';
  }

  buildKeyboard(getRightHand());
  showScreen('play-screen');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('stop-btn').disabled  = true;
}

function selectPart(idx) {
  state.selectedPart = idx;
  document.querySelectorAll('.part-btn').forEach((b, i) =>
    b.classList.toggle('selected', i === idx));
  buildKeyboard(getRightHand());
  document.getElementById('next-note-display').textContent = '—';
}

function getInstrumentForPart(idx) {
  return state.partInstruments[idx]
    ?? state.current?.parts?.[idx]?.instrument
    ?? 'piano';
}

async function changeInstrument(partIdx, instrument) {
  state.partInstruments[partIdx] = instrument;
  try {
    await api(`/api/scores/${state.current.name}/instrument`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part_index: partIdx, instrument }),
    });
    localStorage.removeItem(`accompy_score_${state.current.name}`);
  } catch { /* non-critical — change is applied in-memory either way */ }
}

function getRightHand() {
  const parts = state.current?.parts;
  if (parts && parts.length > 0) return parts[state.selectedPart ?? 0].notes;
  return state.current?.right_hand || [];
}

function getLeftHand() {
  const parts = state.current?.parts;
  if (!parts || parts.length === 0) return state.current?.left_hand || [];
  const idx = state.selectedPart ?? 0;
  // Merge all parts except the selected one
  const left = [];
  parts.forEach((p, i) => { if (i !== idx) left.push(...p.notes); });
  left.sort((a, b) => a[1] - b[1]);
  // Wrap pitches as arrays for the accompanist
  return left.map(n => [Array.isArray(n[0]) ? n[0] : [n[0]], n[1]]);
}

// ── Keyboard visualiser ───────────────────────────────────────────────────────
const KB_ROWS = [
  ['q','w','e','r','t','y','u','i'],
  ['a','s','d','f','g','h','j'],
  ['z','x','c','v','b','n','m'],
];

function buildKeyboard(rightHand) {
  const nextPitch = rightHand[0]?.[0];

  KB_ROWS.forEach((row, ri) => {
    const el = document.getElementById(`kb-row-${ri}`);
    el.innerHTML = row.map(key => {
      const midi     = KEY_MAP[key];
      const name     = pitchName(midi);
      const isNext   = midi === nextPitch;
      const sharpKey = HAS_SHARP.has(key) ? key.toUpperCase() : null;
      const sharpMidi = sharpKey ? KEY_MAP[sharpKey] : null;
      const sharpName = sharpMidi ? pitchName(sharpMidi) : null;
      const isNextSharp = sharpMidi === nextPitch;

      const sharpBadge = sharpKey
        ? `<div class="kb-sharp${isNextSharp ? ' next' : ''}" id="kbkey-${sharpKey}">
             <span class="sharp-char">⇧${key}</span>
             <span class="sharp-note">${sharpName}</span>
           </div>`
        : `<div class="kb-sharp-empty"></div>`;

      return `<div class="kb-key-wrap">
        ${sharpBadge}
        <div class="kb-key${isNext ? ' next' : ''}" id="kbkey-${key}">
          <span class="key-char">${key}</span>
          <span class="note-name">${name}</span>
        </div>
      </div>`;
    }).join('');
  });
}

// Build reverse map: midi → key (prefer lowercase/white keys)
function buildPitchToKey() {
  const map = {};
  // Add sharps first so whites overwrite for natural notes
  for (const [k, v] of Object.entries(KEY_MAP)) map[v] = k;
  return map;
}

function highlightKey(key, on) {
  const el = document.getElementById(`kbkey-${key}`);
  if (el) el.classList.toggle('active', on);
}

function updateNextKey(rightHand, position) {
  document.querySelectorAll('.kb-key.next, .kb-sharp.next')
    .forEach(el => el.classList.remove('next'));
  if (position >= rightHand.length) return;

  const midi = rightHand[position][0];
  const key  = buildPitchToKey()[midi];
  if (key) document.getElementById(`kbkey-${key}`)?.classList.add('next');

  document.getElementById('next-note-display').textContent = pitchName(midi);
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
function startPlaying() {
  audioCtx().resume(); // unblock audio on user gesture

  const bpm        = parseFloat(document.getElementById('bpm-input').value) || 100;
  const initialBps = bpm / 60;
  const right = getRightHand();
  const left  = getLeftHand();

  // Build per-part instrument map for the accompanist (all non-selected parts)
  const parts = state.current?.parts || [];
  const sel   = state.selectedPart ?? 0;
  const leftInstruments = parts
    .map((_, i) => i)
    .filter(i => i !== sel)
    .map(i => getInstrumentForPart(i));

  state.tracker     = new Tracker(right, initialBps);
  state.accompanist = new Accompanist(left, right, initialBps, leftInstruments);
  state.accompanist.start();
  state.playing = true;

  document.getElementById('start-btn').disabled = true;
  document.getElementById('stop-btn').disabled  = false;

  updateNextKey(right, 0);
  enableMidi();
}

function stopPlaying() {
  if (state.accompanist) state.accompanist.stop();
  state.playing = false;
  document.getElementById('start-btn').disabled = false;
  document.getElementById('stop-btn').disabled  = true;
  document.getElementById('next-note-display').textContent = '—';
}

// ── Note handler (called by keyboard and MIDI) ────────────────────────────────
function handleNote(midi) {
  if (!state.playing || !state.tracker) return;
  playNote(midi, 0.6, getInstrumentForPart(state.selectedPart ?? 0));
  const k = buildPitchToKey()[midi];
  highlightKey(k, true);
  setTimeout(() => highlightKey(k, false), 120);

  const beat = state.tracker.onNote(midi);
  if (beat !== null) {
    const bps = state.tracker.bps();
    state.accompanist.onRhNote(beat, bps);
    document.getElementById('beat-val').textContent  = beat.toFixed(1);
    document.getElementById('tempo-val').textContent = Math.round(bps * 60) + ' BPM';
    document.getElementById('progress-fill').style.width =
      (state.tracker.progress() * 100).toFixed(1) + '%';
    updateNextKey(getRightHand(), state.tracker.position);
  }

  if (state.tracker.isFinished()) stopPlaying();
}

// ── Computer keyboard input ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  const midi = KEY_MAP[e.key];  // preserve case — uppercase = sharp
  if (midi !== undefined) { e.preventDefault(); handleNote(midi); }
});

// ── Web MIDI input ────────────────────────────────────────────────────────────
function enableMidi() {
  if (!navigator.requestMIDIAccess) return;
  navigator.requestMIDIAccess().then(access => {
    for (const input of access.inputs.values()) {
      input.onmidimessage = ({ data }) => {
        const [status, pitch, velocity] = data;
        if ((status & 0xF0) === 0x90 && velocity > 0) handleNote(pitch);
      };
    }
    document.getElementById('midi-status').textContent = 'MIDI: connected';
  }).catch(() => {});
}

// ── Delete piece ─────────────────────────────────────────────────────────────
async function deleteScore(e, name) {
  e.stopPropagation();
  if (!confirm(`Remove "${formatName(name)}"?`)) return;
  await api(`/api/scores/${name}`, { method: 'DELETE' });
  localStorage.removeItem(`accompy_score_${name}`);
  document.getElementById(`card-${name}`)?.remove();
  state.scores = state.scores.filter(s => s !== name);
}

// ── Add piece modal ───────────────────────────────────────────────────────────
let _searchTimer = null;

function openAddModal() {
  document.getElementById('add-modal').style.display = 'flex';
  document.getElementById('corpus-search').value = '';
  document.getElementById('search-results').innerHTML =
    '<p class="search-hint">Type to search the built-in music library (535 pieces).</p>';
  setTimeout(() => document.getElementById('corpus-search').focus(), 50);
}

function closeAddModal(e) {
  if (e && e.target !== document.getElementById('add-modal')) return;
  document.getElementById('add-modal').style.display = 'none';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('add-modal').style.display = 'none';
});

function onSearchInput() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(runSearch, 300);
}

async function runSearch() {
  const q = document.getElementById('corpus-search').value.trim();
  const spinner = document.getElementById('search-spinner');
  spinner.style.display = 'inline';

  try {
    const { results } = await api(`/api/corpus/search?q=${encodeURIComponent(q)}`);
    renderSearchResults(results);
  } catch (e) {
    document.getElementById('search-results').innerHTML =
      `<p class="search-hint" style="color:#e05c5c">Error: ${e.message}</p>`;
  } finally {
    spinner.style.display = 'none';
  }
}

function renderSearchResults(results) {
  const already = new Set(state.scores);
  if (!results.length) {
    document.getElementById('search-results').innerHTML =
      '<p class="search-hint">No results found.</p>';
    return;
  }
  document.getElementById('search-results').innerHTML = results.map(r => {
    const safeName = r.path.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const added    = already.has(safeName);
    return `
      <div class="result-item${added ? ' done' : ''}" id="result-${safeName}">
        <div class="result-info">
          <div class="result-name">${r.composer} — ${r.title}</div>
          <div class="result-path">${r.path}</div>
        </div>
        <button class="btn btn-primary" onclick="addPiece('${r.path}', '${safeName}')"
          ${added ? 'disabled' : ''}>
          ${added ? '✓ Added' : '+ Add'}
        </button>
      </div>`;
  }).join('');
}

async function addPiece(corpusPath, safeName) {
  const item = document.getElementById(`result-${safeName}`);
  item.classList.add('adding');
  item.querySelector('button').textContent = 'Converting…';

  try {
    await api('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corpus_path: corpusPath, name: safeName }),
    });
    item.classList.remove('adding');
    item.classList.add('done');
    item.querySelector('button').textContent = '✓ Added';
    item.querySelector('button').disabled = true;

    // Refresh score list in background
    await loadScoreList();
  } catch (e) {
    item.classList.remove('adding');
    item.querySelector('button').textContent = '+ Add';
    alert(`Failed to convert: ${e.message}`);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadScoreList();
