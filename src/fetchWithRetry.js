// Serverless functions can reuse a frozen container between invocations,
// and the underlying socket a pooled connection was using can go stale
// while frozen — the first request on it then fails with a TLS/connection
// reset error, not because anything is actually wrong. Retrying once on a
// fresh connection almost always succeeds immediately.
const NETWORK_ERROR_PATTERN = /ECONNRESET|socket disconnected|fetch failed|ETIMEDOUT|EPIPE/i;

async function fetchWithRetry(url, options, retriesLeft = 2) {
  try {
    return await fetch(url, options);
  } catch (err) {
    const isNetworkError =
      NETWORK_ERROR_PATTERN.test(err?.message || '') || NETWORK_ERROR_PATTERN.test(err?.cause?.message || '');
    if (retriesLeft <= 0 || !isNetworkError) throw err;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return fetchWithRetry(url, options, retriesLeft - 1);
  }
}

module.exports = { fetchWithRetry };
