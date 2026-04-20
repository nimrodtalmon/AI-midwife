import { callClaude } from './claude.js';

// ── State ──────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'aimidwife_v1';

const EMPTY_STATE = () => ({
  commitments: [],
  prose: '',
  history: [],
  gauges: { understanding: 0, endorsement: 0 },
  artifact: null,
  artifact_stale: false
});

const COLD_START = {
  stem: "What's this?",
  options: ["Doing", "Figuring out", "Not sure"]
};

let state = EMPTY_STATE();
let currentQuestion = { ...COLD_START };
let apiKey = localStorage.getItem('anthropic_key') || null;
let isLoading = false;
let turnCount = 0;

// ── Persistence ────────────────────────────────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, currentQuestion, turnCount }));
  } catch (_) {}
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.state && saved?.currentQuestion) {
      state = { ...EMPTY_STATE(), ...saved.state };
      currentQuestion = saved.currentQuestion;
      turnCount = saved.turnCount || state.history.length;
      return true;
    }
  } catch (_) {}
  return false;
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const questionStem      = $('question-stem');
const optionsCont       = $('options-container');
const loadingEl         = $('loading');
const errorEl           = $('error-msg');
const commitmentsList   = $('commitments-list');
const commitmentsLabel  = $('commitments-label');
const turnEl            = $('turn-counter');
const uBar              = $('understanding-bar');
const uPct              = $('understanding-pct');
const eBar              = $('endorsement-bar');
const ePct              = $('endorsement-pct');
const showDraftBtn      = $('show-draft-btn');
const draftDot          = $('draft-dot');
const draftOverlay      = $('draft-overlay');
const draftContent      = $('draft-content');
const apiKeyModal       = $('api-key-modal');
const freetextArea      = $('freetext-area');
const freetextInput     = $('freetext-input');
const commitmentsSheet  = $('commitments-sheet');
const sheetScrim        = $('sheet-scrim');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function init() {
  const restored = loadSaved();
  if (!apiKey) showApiKeyModal();
  renderQuestion(currentQuestion, false); // no animation on first render
  renderCommitments();
  updateGauges();
  updateTurn();
  if (restored && state.history.length > 0) showToast('Continuing from last session');
  setupListeners();
}

// ── API key modal ──────────────────────────────────────────────────────────────
function showApiKeyModal() { apiKeyModal.classList.remove('hidden'); }
function hideApiKeyModal() { apiKeyModal.classList.add('hidden'); }

// ── Bottom sheet ───────────────────────────────────────────────────────────────
function openSheet() {
  commitmentsSheet.classList.add('open');
  sheetScrim.classList.remove('hidden');
}
function closeSheet() {
  commitmentsSheet.classList.remove('open');
  sheetScrim.classList.add('hidden');
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('toast-hidden');
  t.classList.add('toast-show');
  setTimeout(() => {
    t.classList.remove('toast-show');
    t.classList.add('toast-hidden');
  }, 2500);
}

// ── Render helpers ─────────────────────────────────────────────────────────────
function renderQuestion(q, animate = true) {
  if (animate) {
    questionStem.classList.add('q-exit');
    setTimeout(() => {
      questionStem.textContent = q.stem;
      questionStem.classList.remove('q-exit');
      questionStem.classList.add('q-enter');
      setTimeout(() => questionStem.classList.remove('q-enter'), 300);
      renderOptions(q.options);
    }, 140);
  } else {
    questionStem.textContent = q.stem;
    renderOptions(q.options);
  }
}

function renderOptions(options) {
  optionsCont.innerHTML = '';
  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.style.animationDelay = `${i * 55}ms`;
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      if (isLoading) return;
      btn.classList.add('option-selected');
      setTimeout(() => dispatch({ type: 'option', value: opt }), 120);
    });
    optionsCont.appendChild(btn);
  });
}

function renderCommitments() {
  const n = state.commitments.length;
  const prev = commitmentsLabel.dataset.count | 0;

  commitmentsLabel.textContent = n === 0 ? 'No commitments'
    : n === 1 ? '1 commitment' : `${n} commitments`;
  commitmentsLabel.dataset.count = n;

  if (n > prev) {
    commitmentsLabel.classList.add('count-pop');
    setTimeout(() => commitmentsLabel.classList.remove('count-pop'), 400);
  }

  if (n === 0) {
    commitmentsList.innerHTML =
      '<p class="text-sm text-gray-600 italic py-2">None yet — keep answering.</p>';
    return;
  }
  commitmentsList.innerHTML = '';
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
  // glow draft button when endorsement is high
  showDraftBtn.classList.toggle('draft-glow', e >= 60);
}

function updateTurn() {
  if (turnEl) turnEl.textContent = turnCount > 0 ? `turn ${turnCount}` : '';
}

function showDraft() {
  draftContent.innerHTML = state.artifact
    ? renderMd(state.artifact)
    : '<p class="text-gray-500 text-sm italic">Answer a few more questions, then try again.</p>';
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

    if (Array.isArray(result.commitments_added)) {
      result.commitments_added.forEach(c => {
        if (c && !state.commitments.includes(c)) state.commitments.push(c);
      });
    }
    if (Array.isArray(result.commitments_removed)) {
      state.commitments = state.commitments.filter(
        c => !result.commitments_removed.includes(c)
      );
    }
    if (result.prose_summary)                    state.prose = result.prose_summary;
    if (typeof result.understanding === 'number') state.gauges.understanding = result.understanding;
    if (typeof result.endorsement   === 'number') state.gauges.endorsement   = result.endorsement;

    turnCount++;
    state.history.push({
      question: currentQuestion.stem,
      options: currentQuestion.options,
      action,
      answer: action.value || action.type
    });

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
    updateTurn();
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
  $('api-key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('api-key-submit').click();
  });

  $('clear-key-btn').addEventListener('click', () => {
    localStorage.removeItem('anthropic_key');
    apiKey = null;
    $('api-key-input').value = '';
    showApiKeyModal();
  });

  $('reset-btn').addEventListener('click', () => {
    if (!confirm('Start a new session?')) return;
    state = EMPTY_STATE();
    currentQuestion = { ...COLD_START };
    turnCount = 0;
    localStorage.removeItem(STORAGE_KEY);
    renderQuestion(currentQuestion, false);
    renderCommitments();
    updateGauges();
    updateTurn();
    draftDot.classList.add('hidden');
    errorEl.classList.add('hidden');
    freetextArea.classList.add('hidden');
    freetextInput.value = '';
    closeSheet();
  });

  $('pass-btn').addEventListener('click', () => { if (!isLoading) dispatch({ type: 'pass' }); });
  $('skip-btn').addEventListener('click', () => { if (!isLoading) dispatch({ type: 'skip' }); });

  $('freetext-btn').addEventListener('click', () => {
    freetextArea.classList.toggle('hidden');
    if (!freetextArea.classList.contains('hidden')) freetextInput.focus();
  });
  $('freetext-cancel').addEventListener('click', () => {
    freetextArea.classList.add('hidden');
    freetextInput.value = '';
  });
  $('freetext-submit').addEventListener('click', () => {
    const v = freetextInput.value.trim();
    if (!v || isLoading) return;
    freetextArea.classList.add('hidden');
    freetextInput.value = '';
    dispatch({ type: 'freetext', value: v });
  });
  freetextInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('freetext-submit').click();
  });

  showDraftBtn.addEventListener('click', () => {
    if (!isLoading) dispatch({ type: 'draft' }, true);
  });

  $('close-draft').addEventListener('click', () => draftOverlay.classList.add('hidden'));
  draftOverlay.addEventListener('click', e => {
    if (e.target === draftOverlay) draftOverlay.classList.add('hidden');
  });

  $('commitments-btn').addEventListener('click', openSheet);
  sheetScrim.addEventListener('click', closeSheet);
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function renderMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) return marked.parse(text);
  return `<pre class="whitespace-pre-wrap text-sm text-gray-300">${escHtml(text)}</pre>`;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init();
