/**
 * Rules.gs — the viewer's content rules, set in the Settings tab:
 *   MAX_VIDEO_AGE_DAYS  data rule: older videos are never searched, scored or shown
 *   LANGUAGE_FILTER     data rule (YouTube's audio language, where known) + scoring rule
 *   EXCLUDE_ADS         scoring rule: mostly-advert videos score ≤ 2
 *   SCORING_GUIDANCE    scoring rule: the viewer's own words, e.g. "only the new TOEFL format"
 *
 * Scoring rules are part of the prompt version, so changing them re-scores every video once.
 */
const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', mr: 'Marathi', gu: 'Gujarati', ta: 'Tamil', te: 'Telugu', bn: 'Bengali',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ru: 'Russian',
  ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
};

/** Rule lines for the scoring prompt (empty when no rule is set). */
function scoringRules_(cfg) {
  const rules = [];
  if (cfg.LANGUAGE_FILTER) {
    const name = LANGUAGE_NAMES[cfg.LANGUAGE_FILTER] || `the language with code "${cfg.LANGUAGE_FILTER}"`;
    rules.push(`Only videos in ${name}. A video mainly in another language breaks this rule.`);
  }
  if (cfg.EXCLUDE_ADS === 'yes') {
    rules.push('No advertisements: a video that mainly promotes a paid course, coaching, an app, a book or a discount code breaks this rule, even when it is on topic.');
  }
  if (cfg.SCORING_GUIDANCE) rules.push(`In the learner's own words: ${JSON.stringify(cfg.SCORING_GUIDANCE)}`);
  return rules;
}

/** "v1" with no rules; "v1-<hash of the rules>" otherwise, so new rules mean fresh scores. */
function promptVersion_(cfg) {
  const rules = scoringRules_(cfg);
  return rules.length ? `${SCORE_PROMPT_VERSION}-${hashStr_(rules.join('|')).toString(36).slice(0, 6)}` : SCORE_PROMPT_VERSION;
}

/** Oldest allowed publish time (ISO), or the epoch when there is no age limit. */
function minPublished_(cfg) {
  return cfg.MAX_VIDEO_AGE_DAYS > 0
    ? new Date(Date.now() - cfg.MAX_VIDEO_AGE_DAYS * DAY_MS).toISOString()
    : '1970-01-01T00:00:00.000Z';
}

/** The data rules for one raw row (JavaScript mirror of the SQL filters, for sheets storage). */
function passesDataRules_(cfg, r) {
  if (cfg.MAX_VIDEO_AGE_DAYS > 0 && r.published_at && Date.parse(r.published_at) < Date.parse(minPublished_(cfg))) return false;
  if (cfg.LANGUAGE_FILTER && r.language && String(r.language).toLowerCase().indexOf(cfg.LANGUAGE_FILTER) !== 0) return false;
  return true;
}

/** One line for Check setup. */
function rulesSummary_(cfg) {
  const parts = [];
  if (cfg.LANGUAGE_FILTER) parts.push(`${LANGUAGE_NAMES[cfg.LANGUAGE_FILTER] || cfg.LANGUAGE_FILTER} only`);
  if (cfg.EXCLUDE_ADS === 'yes') parts.push('no ads');
  if (cfg.MAX_VIDEO_AGE_DAYS > 0) parts.push(`published in the last ${cfg.MAX_VIDEO_AGE_DAYS} days`);
  if (cfg.SCORING_GUIDANCE) parts.push('your own guidance');
  return parts.length ? `${parts.join(' · ')} (scoring version ${promptVersion_(cfg)})` : 'none';
}
