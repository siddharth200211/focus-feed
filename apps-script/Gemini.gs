/**
 * Gemini.gs — a small Gemini API client that returns parsed JSON.
 *
 * The key comes from Script Properties and travels in a header, never in a URL. Rate limits
 * (HTTP 429) are retried after the delay Gemini asks for; a used-up daily quota stops the
 * caller cleanly instead of failing the whole run.
 */
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * Calls generateContent with a JSON response schema. Returns { data, modelVersion }.
 * Throws an Error with .kind = 'daily_quota' | 'rate_limit' | 'server' | 'not_found' | 'request' | 'output'.
 * opts.maxAttempts (default 4) — use fewer when another model can take over.
 */
function geminiJson_(opts) {
  const key = PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
  if (!key) throw geminiError_('request', 'No Gemini key saved. Use FocusFeed → Set Gemini API key…');
  const body = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: 'user', parts: [{ text: opts.user }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: opts.schema },
  };
  // Scoring is a quick classification: switch "thinking" off so each call returns in seconds.
  // Models that reject this setting get it dropped once, and the choice is remembered.
  const props = PropertiesService.getScriptProperties();
  const thinkingKey = 'GEMINI_NO_THINKING_CONFIG_' + opts.model;
  if (opts.noThinking && !props.getProperty(thinkingKey)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const deadline = opts.deadline || Date.now() + 60 * 1000;
  for (let attempt = 1; ; attempt++) {
    const res = UrlFetchApp.fetch(GEMINI_URL + encodeURIComponent(opts.model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code === 200) return parseGeminiJson_(text);

    let err = {};
    try { err = JSON.parse(text).error || {}; } catch (e) { /* not JSON */ }
    const message = err.message || `HTTP ${code}`;
    if (code === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(message)) {
      delete body.generationConfig.thinkingConfig;
      props.setProperty(thinkingKey, '1');
      attempt--; // not a real failure: send again without the setting
      continue;
    }
    if (code === 429 && isDailyQuota_(err)) throw geminiError_('daily_quota', message);
    if (code === 404) throw geminiError_('not_found', message);
    const retryable = code === 429 || code >= 500;
    if (!retryable) throw geminiError_('request', message);
    const waitMs = code === 429 ? retryDelayMs_(err, 20000) : 5000 * Math.pow(2, attempt - 1); // 5, 10, 20 s
    if (attempt >= (opts.maxAttempts || 4) || Date.now() + waitMs > deadline) {
      throw geminiError_(code === 429 ? 'rate_limit' : 'server', message);
    }
    Utilities.sleep(waitMs);
  }
}

function parseGeminiJson_(text) {
  const res = JSON.parse(text);
  const cand = (res.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const out = parts.map(p => p.text || '').join('');
  if (!out) {
    const why = (cand && cand.finishReason) || (res.promptFeedback && res.promptFeedback.blockReason) || 'empty response';
    throw geminiError_('output', `Gemini returned no text (${why})`);
  }
  try {
    return { data: JSON.parse(out), modelVersion: res.modelVersion || null };
  } catch (e) {
    throw geminiError_('output', 'Gemini returned malformed JSON');
  }
}

/** A 429 caused by a per-day limit won't clear by waiting a few seconds. */
function isDailyQuota_(err) {
  return (err.details || []).some(d => (d.violations || []).some(v => /PerDay/i.test(String(v.quotaId || ''))));
}

/** Gemini's RetryInfo, e.g. "retryDelay": "17s" → 17000 (capped at 60 s). */
function retryDelayMs_(err, fallbackMs) {
  const info = (err.details || []).find(d => d.retryDelay);
  const secs = info ? parseFloat(String(info.retryDelay)) : NaN;
  return Math.min(isNaN(secs) ? fallbackMs : Math.ceil(secs * 1000) + 500, 60000);
}

function geminiError_(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}
