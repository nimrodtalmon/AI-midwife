import { callClaude } from './claude.js';

// ── State ──────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'aimidwife_v1';

const EMPTY_STATE = () => ({
  commitments: [], prose: '', history: [],
  gauges: { understanding: 0, endorsement: 0 },
  artifact: null, artifact_stale: false
});

const COLD_START = { stem: "What's this?", options: ["Doing", "Figuring out", "Not sure"] };

// Soft colors per option slot (light theme)
const OPT_COLORS = ['#5B5BD6', '#7C3AED', '#0891B2', '#16A34A'];

let state = EMPTY_STATE();
let currentQuestion = { ...COLD_START };
let apiKey = localStorage.getItem('anthropic_key') || null;
let isLoading = false;

// ── Persistence ────────────────────────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, currentQuestion })); } catch (_) {}
}
function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (s?.state && s?.currentQuestion) {
      state = { ...EMPTY_STATE(), ...s.state };
      currentQuestion = s.currentQuestion;
      return true;
    }
  } catch (_) {}
  return false;
}

// ── DOM ────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const questionStem     = $('question-stem');
const optionsCont      = $('options-container');
const loadingEl        = $('loading');
const errorEl          = $('error-msg');
const commitmentsList  = $('commitments-list');
const commitmentsLabel = $('commitments-label');
const commitmentsBtn   = $('commitments-btn');
const uBar             = $('understanding-bar');
const eBar             = $('endorsement-bar');
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
  if (restored && state.history.length > 0) showToast('Continuing from last session ✓');
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
  t.classList.replace('toast-out', 'toast-in');
  setTimeout(() => t.classList.replace('toast-in', 'toast-out'), 2600);
}

// ── Render ─────────────────────────────────────────────────────────────────────
function renderQuestion(q, animate = true) {
  const paint = () => {
    questionStem.textContent = q.stem;
    questionStem.classList.remove('out');
    if (animate) {
      questionStem.classList.add('in');
      setTimeout(() => questionStem.classList.remove('in'), 260);
    }
    renderOptions(q.options);
  };
  if (animate) {
    questionStem.classList.add('out');
    setTimeout(paint, 140);
  } else {
    paint();
  }
}

function renderOptions(options) {
  optionsCont.innerHTML = '';
  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt;
    btn.style.cssText = `--opt-color:${OPT_COLORS[i % OPT_COLORS.length]}; animation-delay:${i * 50}ms`;
    btn.addEventListener('click', () => {
      if (isLoading) return;
      btn.classList.add('picked');
      setTimeout(() => dispatch({ type: 'option', value: opt }), 110);
    });
    optionsCont.appendChild(btn);
  });
}

function renderCommitments() {
  const n = state.commitments.length;
  const prev = parseInt(commitmentsLabel.dataset.count || '0');
  commitmentsLabel.textContent = n === 0 ? '0 commitments'
    : n === 1 ? '1 commitment' : `${n} commitments`;
  commitmentsLabel.dataset.count = n;
  commitmentsBtn.classList.toggle('has-items', n > 0);

  if (n > prev) {
    commitmentsLabel.classList.add('pop');
    setTimeout(() => commitmentsLabel.classList.remove('pop'), 350);
  }

  commitmentsList.innerHTML = n === 0
    ? '<p style="font-size:.83rem;color:#aaa;font-style:italic;padding:8px 0">None yet — keep answering.</p>'
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
  uBar.style.width = Math.round(state.gauges.understanding * 100) + '%';
  eBar.style.width = Math.round(state.gauges.endorsement   * 100) + '%';
  showDraftBtn.classList.toggle('ready', state.gauges.endorsement >= 0.55);
}

function showDraft() {
  draftContent.innerHTML = state.artifact
    ? renderMd(state.artifact)
    : '<p style="color:#aaa;font-style:italic;font-size:.85rem">Answer a few more questions, then try again.</p>';
  draftOverlay.classList.remove('hidden');
  draftDot.classList.add('hidden');
  state.artifact_stale = false;
}

// ── Loading / error ────────────────────────────────────────────────────────────
function setLoading(val) {
  isLoading = val;
  loadingEl.classList.toggle('hidden', !val);
  document.querySelectorAll('.option-btn, .pill-btn, #show-draft-btn, #commitments-btn')
    .forEach(el => el.disabled = val);
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  setTimeout(() => errorEl.classList.add('hidden'), 7000);
}

// ── Dispatch ───────────────────────────────────────────────────────────────────
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

    state.history.push({ question: currentQuestion.stem, options: currentQuestion.options, action, answer: action.value || action.type });

    if (result.next_question?.stem && Array.isArray(result.next_question.options)) {
      currentQuestion = result.next_question;
      renderQuestion(currentQuestion);
    }

    if (result.artifact) {
      state.artifact = result.artifact;
    } else if (!requestDraft && state.artifact &&
               ((result.commitments_added?.length > 0) || (result.commitments_removed?.length > 0))) {
      draftDot.classList.remove('hidden');
    }

    if (requestDraft) showDraft();

    renderCommitments();
    updateGauges();
    saveState();

  } catch (err) {
    showError(err.message || 'Something went wrong. Try again.');
  } finally {
    setLoading(false);
  }
}

// ── Listeners ──────────────────────────────────────────────────────────────────
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
    state = EMPTY_STATE(); currentQuestion = { ...COLD_START };
    localStorage.removeItem(STORAGE_KEY);
    renderQuestion(currentQuestion, false);
    renderCommitments(); updateGauges();
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

// ── Utils ──────────────────────────────────────────────────────────────────────
function renderMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) return marked.parse(text);
  return `<pre style="white-space:pre-wrap;font-size:.82rem">${escHtml(text)}</pre>`;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();
