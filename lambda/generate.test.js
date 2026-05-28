const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { handler } = require('./generate');

test('reaction requests are retired without model generation', async () => {
  const response = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ type: 'reaction' }),
  });

  assert.equal(response.statusCode, 410);
  assert.match(JSON.parse(response.body).error, /client-side fallback reactions/i);
});

test('invite page reuses stored mascot reactions without calling reaction API', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../site/app.js'), 'utf8');

  assert.match(appJs, /inviteReactions/);
  assert.match(appJs, /mascotReactions/);
  assert.match(appJs, /FALLBACK_REACTIONS/);
  assert.doesNotMatch(appJs, /type:\s*['"]reaction['"]/);
  assert.doesNotMatch(appJs, /fetchReaction\s*\(/);
});
