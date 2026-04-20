import { SYSTEM_PROMPT } from './prompt.js';

const ANTHROPIC_MODEL  = 'claude-haiku-4-5-20251001';
const OPENROUTER_MODEL = 'anthropic/claude-3.5-sonnet'; // reliable on OpenRouter; change to anthropic/claude-3-haiku-20240307 for speed
const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';

function isOpenRouter(apiKey) {
  return apiKey.startsWith('sk-or-');
}

export async function callClaude(apiKey, state, action, requestDraft = false) {
  const userMsg = buildUserMessage(state, action, requestDraft);
  const useOR = isOpenRouter(apiKey);

  let response;
  try {
    response = useOR
      ? await callOpenRouter(apiKey, userMsg)
      : await callAnthropic(apiKey, userMsg);
  } catch (e) {
    throw new Error('Network error — check your connection and try again.');
  }

  if (!response.ok) {
    let errMsg = `API error ${response.status}`;
    try {
      const errData = await response.json();
      errMsg = errData.error?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await response.json();

  // Anthropic: we prefill the assistant turn with '{' so prepend it back
  const text = useOR
    ? (data.choices?.[0]?.message?.content || '')
    : '{' + (data.content?.[0]?.text || '');

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in model response. Try again.');

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    throw new Error('Failed to parse model response. Try again.');
  }
}

function callAnthropic(apiKey, userMsg) {
  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user',      content: userMsg },
        { role: 'assistant', content: '{' }   // prefill → skips preamble, forces JSON
      ]
    })
  });
}

function callOpenRouter(apiKey, userMsg) {
  return fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-Title': 'AI-Midwife'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 700,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMsg }
      ]
    })
  });
}

function buildUserMessage(state, action, requestDraft) {
  return JSON.stringify({
    current_commitments: state.commitments,
    prose_summary: state.prose,
    gauges: state.gauges,
    recent_history: state.history.slice(-5),
    action,
    request_artifact: requestDraft
  }, null, 2);
}
