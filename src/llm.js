const config = require('./config');
const { getVoiceGuide, getCoreBeliefs } = require('./voice');
const { fetchWithRetry } = require('./fetchWithRetry');

async function callGemini({ systemInstruction, userText }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini call failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const raw = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini returned no JSON: ${raw}`);
  return JSON.parse(match[0]);
}

// Step 1 of handling a new note: pull out the specific checkable hook (for
// the eventual draft) AND a separate, generic public search phrase — the
// search phrase is what gets sent to Google News RSS, never the raw note or
// internal numbers (automation brief, Check 4 — data sensitivity).
async function extractAngle(noteText) {
  const system = `You prep a raw note for Meera Pillai's (Skinstinct) LinkedIn content pipeline.

Extract two things from the note:
1. "angle": the single most specific, checkable hook in it — a number, mechanism, named claim, or incident. This can and should reference internal specifics from the note.
2. "search_query": a short, generic, public search phrase (3-6 words) for the underlying topic — for looking up related public news. This must NOT include proprietary business numbers (revenue, return rates, internal batch/CoA data) — only the general subject (e.g. "niacinamide pH stability" not "our serum pH 5.5 batch results").

Respond with ONLY JSON: {"angle": "...", "search_query": "..."}`;

  return callGemini({ systemInstruction: system, userText: `RAW NOTE:\n${noteText}` });
}

// Step 2: score the note 1-10 on five parameters, using the note plus
// whatever public research was found. The LLM scores each parameter; the
// final score/tier is computed in code (not trusted from the model) so it's
// consistent and auditable.
async function rateNote({ note, angle, searchResults = [] }) {
  const sources = searchResults
    .map((r, i) => `[${i + 1}] ${r.title} (${r.publishedAt || 'date unknown'}) — ${r.url}\n${(r.content || '').slice(0, 300)}`)
    .join('\n\n');

  const system = `You score whether a raw note is worth turning into a LinkedIn post for Meera Pillai (Skinstinct) — a precise, technical, anti-hype voice. Her core beliefs:

${getCoreBeliefs()}

Score the note on 5 parameters, each an integer 1-10:
- relevance: how directly the note's angle connects to her core beliefs and audience.
- recency: how current the research below actually is (recent, dated sources score higher; no research or stale/irrelevant research scores low — do not guess a date that isn't shown).
- context: how well the research situates the note in what's actually happening right now (real regulatory news, real industry data, real incidents) — not just "some sources exist."
- content: how complete and specific the raw note itself already is (does it already contain a real number/mechanism/incident, or is it vague).
- checkability: whether the claims involved (in the note and in the research) are independently verifiable — real sources, real numbers — versus vague or unsourced.

Do not invent research findings that aren't in the SEARCH RESULTS below. If there are no search results, score recency and context low and say so in your reasoning.

Respond with ONLY JSON in this exact shape, no other text:
{"relevance": 1-10, "recency": 1-10, "context": 1-10, "content": 1-10, "checkability": 1-10, "reasoning": "<2-3 sentences citing specifics from the note and/or research>"}`;

  const userText = `RAW NOTE:\n${note}\n\nEXTRACTED ANGLE:\n${angle}\n\nSEARCH RESULTS:\n${sources || '(none found)'}`;

  const parsed = await callGemini({ systemInstruction: system, userText });

  const dims = ['relevance', 'recency', 'context', 'content', 'checkability'];
  const values = dims.map((k) => Math.max(1, Math.min(10, Math.round(Number(parsed[k]) || 1))));
  const raw = Object.fromEntries(dims.map((k, i) => [k, values[i]]));

  // Weighted, not a flat average: the note's own merit (relevance, content,
  // checkability) counts more than whether free news search happened to find
  // something (recency, context). Meera's own strongest posts are often
  // self-contained founder stories with zero external news behind them (see
  // linkedin_post_002 in the voice guide) — a flat average would backlog
  // those too, purely for lacking external grounding they never needed.
  const WEIGHTS = { relevance: 0.3, content: 0.3, checkability: 0.2, context: 0.1, recency: 0.1 };
  const weightedScore = dims.reduce((sum, k) => sum + raw[k] * WEIGHTS[k], 0);
  const score = Math.round(weightedScore);

  let tier;
  if (score < 7) tier = 'not postable';
  else if (score === 7) tier = 'low';
  else if (score === 8) tier = 'medium';
  else tier = 'high';

  return { ...raw, score, tier, reasoning: parsed.reasoning || '' };
}

// Drafts (or revises) a LinkedIn post in Meera's voice. `searchResults` are
// used ONLY as citable source material — see the anti-hallucination rules
// below, which implement "the Cut" from the automation brief: enrichment
// stays, but every external fact is traceable and marked unverified.
async function draftPost({ note, angle, searchResults = [], feedback, priorDraft }) {
  const voiceGuide = getVoiceGuide();
  const sources = searchResults
    .map((r, i) => `[${i + 1}] ${r.title} (${r.publishedAt || 'date unknown'}) — ${r.url}\n${(r.content || '').slice(0, 500)}`)
    .join('\n\n');

  const system = `You write LinkedIn posts as Meera Pillai, founder of Skinstinct. Follow the voice guide below exactly: structure, tone, sentence-level rules, rhetorical moves, and the pre-publish checklist in Section 14. Always produce the LINKEDIN POST format (Section 4), not the newsletter format.

${voiceGuide}

ANTI-HALLUCINATION RULES (in addition to Section 13 above — these are non-negotiable):
- You may state a fact as certain only if it appears in the RAW NOTE or in the SEARCH RESULTS provided below.
- Any fact taken from a search result MUST be followed immediately by its bracket number, e.g. "...effective above 2% concentration [1]."
- Never invent a percentage, pH value, date, study, or statistic that isn't in the note or the search results. If the note doesn't give you enough for a specific number she'd normally cite, flag the gap in her voice (Section 13) instead of inventing one.
- Never attach a citation number to a fact that came from the raw note itself — citations are only for the search results.

Respond with ONLY a JSON object matching this exact shape, no other text, no markdown fences:
{"text": "<the finished LinkedIn post, no markdown formatting>", "citations": [{"n": 1, "title": "...", "url": "..."}]}
"citations" must list only the numbers actually used in the post text — an empty array if none were used.`;

  let userContent = `RAW NOTE:\n${note}\n\nANGLE TO DEVELOP:\n${angle || '(none extracted — use your judgment from the note)'}\n\nSEARCH RESULTS:\n${sources || '(none provided — draft using only the note; do not invent external facts)'}`;

  if (feedback && priorDraft) {
    userContent += `\n\nPRIOR DRAFT:\n${priorDraft}\n\nMEERA'S FEEDBACK — revise the prior draft accordingly, same rules apply:\n${feedback}`;
  }

  const parsed = await callGemini({ systemInstruction: system, userText: userContent });
  return { text: parsed.text, citations: parsed.citations || [] };
}

module.exports = { extractAngle, rateNote, draftPost };
