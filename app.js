import { callClaude } from './claude.js';

// ── State ──────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'aimidwife_v1';

const EMPTY_STATE = () => ({
  commitments: [], prose: '', history: [],
  gauges: { understanding: 0, endorsement: 0 },
  artifact: null, artifact_stale: false
});

const COLD_START = { stem: "What's this?", options: ["Doing", "Figuring out", "Not sure"] };

let state = EMPTY_STATE();
let currentQuestion = { ...COLD_START };
let apiKey = localStorage.getItem('anthropic_key') || null;
let isLoading = false;
let turnCount = 0;

// ── Option color palette (cycles across 4 neon accents) ───────────────────────
const ACCENTS = [
  { color: '#6366f1', glow: 'rgba(99,102,241,0.22)',  alpha: 'rgba(99,102,241,0.15)'  }, // indigo
  { color: '#8b5cf6', glow: 'rgba(139,92,246,0.22)',  alpha: 'rgba(139,92,246,0.15)'  }, // violet
  { color: '#06b6d4', glow: 'rgba(6,182,212,0.22)',   alpha: 'rgba(6,182,212,0.15)'   }, // cyan
  { color: '#10b981', glow: 'rgba(16,185,129,0.22)',  alpha: 'rgba(16,185,129,0.15)'  }, // emerald
];

// ── Phase system ───────────────────────────────────────────────────────────────
const PHASES = [
  { min: 0,  label: 'Start',         color: '#4b5563' },
  { min: 1,  label: 'Exploring',     color: '#6366f1' },
  { min: 4,  label: 'Shaping',       color: '#8b5cf6' },
  { min: 8,  label: 'Crystallizing', color: '#06b6d4' },
  { min: 13, label: 'Finalizing',    color: '#10b981' },
];
function getPhase(n) {
  return [...PHASES].reverse().find(p => n >= p.min) || PHASES[0];
}

// ── Persistence ────────────────────────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, currentQuestion, turnCount })); }
  catch (_) {}
}
function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (s?.state && s?.currentQuestion) {
      state = { ...EMPTY_STATE(), ...s.state };
      currentQuestion = s.currentQuestion;
      turnCount = s.turnCount || state.history.length;
      return true;
    }
  } catch (_) {}
  return false;
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const questionStem     = $('question-stem');
const optionsCont      = $('options-container');
const loadingEl        = $('loading');
const errorEl          = $('error-msg');
const commitmentsList  = $('commitments-list');
const commitmentsLabel = $('commitments-label');
const turnBadge        = $('turn-badge');
const phaseBadge       = $('phase-badge');
const uBar             = $('understanding-bar');
const uPct             = $('understanding-pct');
const eBar             = $('endorsement-bar');
const ePct             = $('endorsement-pct');
const showDraftBtn     = $('show-draft-btn');
const draftDot         = $('draft-dot');
const draftOverlay     = $('draft-overlay');
const draftContent     = $('draft-content');
const apiKeyModal      = $('api-key-modal');
const freetextArea     = $('freetext-area');
const freetextInput    = $('freetext-input');
const commitmentsSheet = $('commitments-sheet');
const sheetScrim       = $('sheet-scrim');

// ── Bootstrap ──────────────────────────────────────────────────────────────────
function init() {
  const restored = loadSaved();
  if (!apiKey) showApiKeyModal();
  renderQuestion(currentQuestion, false);
  renderCommitments();
  updateGauges();
  updateHUD();
  if (restored && state.history.length > 0) showToast('Continuing from last session');
  setupListeners();
}

// ── Modals ─────────────────────────────────────────────────────────────────────
function showApiKeyModal() { apiKeyModal.classList.remove('hidden'); }
function hideApiKeyModal() { apiKeyModal.classList.add('hidden'); }

function openSheet()  { commitmentsSheet.classList.add('open'); sheetScrim.classList.remove('hidden'); }
function closeSheet() { commitmentsSheet.classList.remove('open'); sheetScrim.classList.add('hidden'); }

// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.replace('toast-hidden', 'toast-show');
  setTimeout(() => t.classList.replace('toast-show', 'toast-hidden'), 2400);
}

// ── Floating score text ────────────────────────────────────────────────────────
function spawnFloat(text, anchorEl) {
  const el = document.createElement('div');
  el.className = 'float-score';
  el.textContent = text;
  document.body.appendChild(el);
  const r = anchorEl.getBoundingClientRect();
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top  = (r.top - 4) + 'px';
  setTimeout(() => el.remove(), 900);
}

// ── Ripple ─────────────────────────────────────────────────────────────────────
function addRipple(btn, e) {
  const r = btn.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.left = (e.clientX - r.left) + 'px';
  ripple.style.top  = (e.clientY - r.top) + 'px';
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
}

// ── Render helpers ─────────────────────────────────────────────────────────────
function renderQuestion(q, animate = true) {
  const doRender = () => {
    questionStem.textContent = q.stem;
    questionStem.classList.remove('q-exit');
    if (animate) {
      questionStem.classList.add('q-enter');
      setTimeout(() => questionStem.classList.remove('q-enter'), 280);
    }
    renderOptions(q.options);
  };

  if (animate) {
    questionStem.classList.add('q-exit');
    setTimeout(doRender, 140);
  } else {
    doRender();
  }
}

function renderOptions(options) {
  optionsCont.innerHTML = '';
  options.forEach((opt, i) => {
    const accent = ACCENTS[i % ACCENTS.length];
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.style.cssText = `
      --accent: ${accent.color};
      --glow: ${accent.glow};
      --accent-alpha: ${accent.alpha};
      animation-delay: ${i * 55}ms;
    `;
    btn.innerHTML = `<span class="opt-num">${i + 1}</span><span>${escHtml(opt)}</span>`;

    btn.addEventListener('click', e => {
      if (isLoading) return;
      addRipple(btn, e);
      btn.classList.add('option-selected');
      setTimeout(() => dispatch({ type: 'option', value: opt }), 130);
    });
    optionsCont.appendChild(btn);
  });
}

function renderCommitments() {
  const n = state.commitments.length;
  const prev = parseInt(commitmentsLabel.dataset.count || '0');

  commitmentsLabel.textContent = n === 0 ? 'No commitments'
    : n === 1 ? '1 commitment' : `${n} commitments`;
  commitmentsLabel.dataset.count = n;
  commitmentsLabel.classList.toggle('has-items', n > 0);

  if (n > prev) {
    commitmentsLabel.classList.add('count-pop');
    spawnFloat(`+${n - prev} commitment${n - prev > 1 ? 's' : ''}`, $('commitments-btn'));
    setTimeout(() => commitmentsLabel.classList.remove('count-pop'), 400);
  }

  commitmentsList.innerHTML = n === 0
    ? '<p style="font-size:0.82rem;color:#374151;font-style:italic;padding:4px 0">None yet — keep answering.</p>'
    : '';

  state.commitments.forEach(c => {
    const div = document.createElement('div');
    div.className = 'commitment-item';
    div.innerHTML = `<span class="retract-x">×</span><span>${escHtml(c)}</span>`;
    div.addEventListener('click', () => {
      if (!isLoading) { closeSheet(); dispatch({ type: 'retract', value: c }); }
    });
    commitmentsList.appendChild(div);
  });
}

function updateGauges() {
  const u = Math.round(state.gauges.understanding * 100);
  const e = Math.round(state.gauges.endorsement * 100);
  uBar.style.width = u + '%';
  uPct.textContent = u + '%';
  eBar.style.width = e + '%';
  ePct.textContent = e + '%';
  showDraftBtn.classList.toggle('ready', e >= 55);
}

function updateHUD() {
  if (turnCount > 0) {
    turnBadge.textContent = `Q${turnCount}`;
    turnBadge.classList.remove('hidden');
  }
  const phase = getPhase(state.commitments.length);
  phaseBadge.textContent = phase.label;
  phaseBadge.style.color = phase.color;
  phaseBadge.style.borderColor = phase.color;
}

function showDraft() {
  draftContent.innerHTML = state.artifact
    ? renderMd(state.artifact)
    : '<p style="color:#4b5563;font-style:italic;font-size:0.85rem">Answer a few more questions, then try again.</p>';
  draftOverlay.classList.remove('hidden');
  draftDot.classList.add('hidden');
  state.artifact_stale = false;
}

// ── Loading / error ────────────────────────────────────────────────────────────
function setLoading(val) {
  isLoading = val;
  loadingEl.classList.toggle('hidden', !val);
  document.querySelectorAll('.option-btn, .sec-btn, #show-draft-btn, #commitments-btn')
    .forEach(el => el.disabled = val);
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  setTimeout(() => errorEl.classList.add('hidden'), 7000);
}

// ── Core dispatcher ────────────────────────────────────────────────────────────
async function dispatch(action, requestDraft = false) {
  if (!apiKey) { showApiKeyModal(); return; }
  setLoading(true);
  errorEl.classList.add('hidden');

  try {
    const result = await callClaude(apiKey, state, action, requestDraft);

    if (Array.isArray(result.commitments_added))
      result.commitments_added.forEach(c => { if (c && !state.commitments.includes(c)) state.commitments.push(c); });
    if (Array.isArray(result.commitments_removed))
      state.commitments = state.commitments.filter(c => !result.commitments_removed.includes(c));
    if (result.prose_summary)                    state.prose = result.prose_summary;
    if (typeof result.understanding === 'number') state.gauges.understanding = result.understanding;
    if (typeof result.endorsement   === 'number') state.gauges.endorsement   = result.endorsement;

    turnCount++;
    state.history.push({ question: currentQuestion.stem, options: currentQuestion.options, action, answer: action.value || action.type });

    if (result.next_question?.stem && Array.isArray(result.next_question.options)) {
      currentQuestion = result.next_question;
      renderQuestion(currentQuestion);
    }

    if (result.artifact) {
      state.artifact = result.artifact;
      state.artifact_stale = false;
    } else if (!requestDraft && state.artifact &&
               ((result.commitments_added?.length > 0) || (result.commitments_removed?.length > 0))) {
      state.artifact_stale = true;
      draftDot.classList.remove('hidden');
    }

    if (requestDraft) showDraft();

    renderCommitments();
    updateGauges();
    updateHUD();
    saveState();

  } catch (err) {
    showError(err.message || 'Something went wrong. Try again.');
  } finally {
    setLoading(false);
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────
function setupListeners() {
  $('api-key-submit').addEventListener('click', () => {
    const k = $('api-key-input').value.trim();
    if (k) { apiKey = k; localStorage.setItem('anthropic_key', k); hideApiKeyModal(); }
  });
  $('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('api-key-submit').click(); });

  $('clear-key-btn').addEventListener('click', () => {
    localStorage.removeItem('anthropic_key');
    apiKey = null; $('api-key-input').value = ''; showApiKeyModal();
  });

  $('reset-btn').addEventListener('click', () => {
    if (!confirm('Start a new session?')) return;
    state = EMPTY_STATE(); currentQuestion = { ...COLD_START }; turnCount = 0;
    localStorage.removeItem(STORAGE_KEY);
    renderQuestion(currentQuestion, false);
    renderCommitments(); updateGauges(); updateHUD();
    draftDot.classList.add('hidden'); errorEl.classList.add('hidden');
    freetextArea.classList.add('hidden'); freetextInput.value = '';
    closeSheet(); showDraftBtn.classList.remove('ready');
  });

  $('pass-btn').addEventListener('click', () => { if (!isLoading) dispatch({ type: 'pass' }); });
  $('skip-btn').addEventListener('click', () => { if (!isLoading) dispatch({ type: 'skip' }); });

  $('freetext-btn').addEventListener('click', () => {
    freetextArea.classList.toggle('hidden');
    if (!freetextArea.classList.contains('hidden')) freetextInput.focus();
  });
  $('freetext-cancel').addEventListener('click', () => { freetextArea.classList.add('hidden'); freetextInput.value = ''; });
  $('freetext-submit').addEventListener('click', () => {
    const v = freetextInput.value.trim();
    if (!v || isLoading) return;
    freetextArea.classList.add('hidden'); freetextInput.value = '';
    dispatch({ type: 'freetext', value: v });
  });
  freetextInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('freetext-submit').click(); });

  showDraftBtn.addEventListener('click', () => { if (!isLoading) dispatch({ type: 'draft' }, true); });

  $('close-draft').addEventListener('click', () => draftOverlay.classList.add('hidden'));
  draftOverlay.addEventListener('click', e => { if (e.target === draftOverlay) draftOverlay.classList.add('hidden'); });

  $('commitments-btn').addEventListener('click', openSheet);
  sheetScrim.addEventListener('click', closeSheet);
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function renderMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) return marked.parse(text);
  return `<pre style="white-space:pre-wrap;font-size:0.82rem;color:#cbd5e1">${escHtml(text)}</pre>`;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();
