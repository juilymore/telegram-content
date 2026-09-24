const Parser = require('rss-parser');

const parser = new Parser();

// Research via Google News RSS — free, no API key. Called with a generic,
// public search phrase only (see llm.js's extractAngle), never the raw note
// — the note can contain unpublished business data (automation brief, Check 4).
async function searchNews(query) {
  if (!query) return [];

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;

  let feed;
  try {
    feed = await parser.parseURL(url);
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
