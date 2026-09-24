const fs = require('fs');
const config = require('./config');

let cached = null;

function getVoiceGuide() {
  if (!cached) {
    cached = fs.readFileSync(config.VOICE_FILE_PATH, 'utf8');
  }
  return cached;
}

// Pulls just Section 2 (Core Beliefs) out of the full guide, for the cheap
// gatekeeper call — it doesn't need the full structural/style rules.
function getCoreBeliefs() {
  const guide = getVoiceGuide();
  const start = guide.indexOf('2. CORE BELIEFS');
  if (start === -1) return guide.slice(0, 2000);
  const end = guide.indexOf('\n3. THE VOICE', start);
  return guide.slice(start, end === -1 ? start + 2000 : end).trim();
}

module.exports = { getVoiceGuide, getCoreBeliefs };
