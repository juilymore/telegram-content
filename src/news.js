const Parser = require('rss-parser');

const parser = new Parser();

// rss-parser uses its own internal HTTP client rather than global fetch, so
// it can't share fetchWithRetry directly — retry the whole call instead for
// the same class of transient serverless connection-reset error.
const NETWORK_ERROR_PATTERN = /ECONNRESET|socket disconnected|fetch failed|ETIMEDOUT|EPIPE/i;

async function parseURLWithRetry(url, retriesLeft = 2) {
  try {
    return await parser.parseURL(url);
  } catch (err) {
    const isNetworkError = NETWORK_ERROR_PATTERN.test(err?.message || '');
    if (retriesLeft <= 0 || !isNetworkError) throw err;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return parseURLWithRetry(url, retriesLeft - 1);
  }
}

// Research via Google News RSS — free, no API key. Called with a generic,
// public search phrase only (see llm.js's extractAngle), never the raw note
// — the note can contain unpublished business data (automation brief, Check 4).
async function searchNews(query) {
  if (!query) return [];

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

  let feed;
  try {
    feed = await parseURLWithRetry(url);
  } catch (err) {
    throw new Error(`Google News RSS fetch failed: ${err.message}`);
  }

  return (feed.items || []).slice(0, 5).map((item) => ({
    title: item.title || item.link,
    url: item.link,
    publishedAt: item.pubDate || item.isoDate || '',
    content: item.contentSnippet || item.content || '',
  }));
}

module.exports = { searchNews };
