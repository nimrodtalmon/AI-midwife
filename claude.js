import { SYSTEM_PROMPT } from './prompt.js';

const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

export async function callClaude(apiKey, state, action, requestDraft = false) {
  const body = {
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildUserMessage(state, action, requestDraft) }
    ]
  };

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
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
  const text = data.content?.[0]?.text || '';

  // Extract JSON — model should return only JSON but may wrap in fences
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in model response. Try again.');

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    throw new Error('Failed to parse model response. Try again.');
  }
}

function buildUserMessage(state, action, requestDraft) {
  return JSON.stringify({
    current_commitments: state.commitments,
    prose_summary: state.prose,
    gauges: state.gauges,
    recent_history: state.history.slice(-6),
    action,
    request_artifact: requestDraft
  }, null, 2);
}
