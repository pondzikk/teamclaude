import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelHealth, isLocalFault } from '../src/model-health.js';

const OPUS = 'claude-opus-5';
const HAIKU = 'claude-haiku-4-5';

function err(code, message = 'boom') {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

// A clock we control, so no test depends on wall time.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function mh(overrides = {}) {
  const c = overrides.clock || clock();
  const h = new ModelHealth({ now: c.now, ...overrides });
  return { h, c };
}

// --- guard 1: local faults are never the provider's fault -------------------

test('DNS and connect failures never trip the breaker', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    const { h } = mh();
    h.recordSuccess(HAIKU); // network proven up
    assert.equal(h.recordFailure(OPUS, 0, err(code)), false, code);
    assert.equal(h.recordFailure(OPUS, 1, err(code)), false, code);
    assert.equal(h.isOpen(OPUS), false, `${code} must never open the breaker`);
  }
});

test('a bare "fetch failed" with no code is treated as local', () => {
  const { h } = mh();
  h.recordSuccess(HAIKU);
  const e = new Error('fetch failed');
  h.recordFailure(OPUS, 0, e);
  h.recordFailure(OPUS, 1, e);
  assert.equal(h.isOpen(OPUS), false);
  assert.equal(isLocalFault(e), true);
});

test('a connect fault wrapped in cause is still local', () => {
  const e = new Error('fetch failed');
  e.code = 'UND_ERR_SOCKET';
  e.cause = err('ENETUNREACH');
  assert.equal(isLocalFault(e), true);
});

// --- guard 2: the train case ------------------------------------------------

test('TRAIN: with no recent success, nothing can trip the breaker', () => {
  const { h } = mh();
  // Never any success — signal was gone from the start.
  for (let i = 0; i < 10; i++) {
    assert.equal(h.recordFailure(OPUS, i % 3, err('TEAMCLAUDE_HEADERS_TIMEOUT')), false);
  }
  assert.equal(h.isOpen(OPUS), false, 'no proof the network works → never blame the provider');
});

test('TRAIN: proof of health expires, so a tunnel mid-session disarms it', () => {
  const { h, c } = mh({ healthWindowMs: 120_000 });
  h.recordSuccess(HAIKU);        // signal was up...
  c.advance(121_000);            // ...then the train entered a tunnel
  h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  h.recordFailure(OPUS, 1, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  assert.equal(h.isOpen(OPUS), false, 'stale health proof must not arm the breaker');
});

test('flaky link: intermittent success keeps requests flowing, one account at a time', () => {
  const { h, c } = mh();
  // Signal comes and goes; each failure is on the SAME account, then a success.
  for (let i = 0; i < 5; i++) {
    h.recordSuccess(OPUS);
    c.advance(5_000);
    assert.equal(h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT')), false);
    assert.equal(h.isOpen(OPUS), false);
  }
});

// --- guard 3: two distinct accounts -----------------------------------------

test('one account failing repeatedly is that account, not the model', () => {
  const { h } = mh();
  h.recordSuccess(HAIKU);
  for (let i = 0; i < 5; i++) h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  assert.equal(h.isOpen(OPUS), false, 'a single credential is never proof of an outage');
});

// --- the real incident ------------------------------------------------------

test('OUTAGE: same model failing on two accounts while other traffic flows trips it', () => {
  const { h } = mh();
  h.recordSuccess(HAIKU);   // Haiku is serving normally — exactly what we measured
  assert.equal(h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT')), false);
  assert.equal(h.recordFailure(OPUS, 1, err('TEAMCLAUDE_HEADERS_TIMEOUT')), true, 'second account trips it');
  assert.equal(h.isOpen(OPUS), true);
  assert.equal(h.isOpen(HAIKU), false, 'the healthy model is untouched');
  assert.ok(h.retryAfterSeconds(OPUS) > 0);
});

test('a 5xx counts the same as a headers timeout', () => {
  const { h } = mh();
  h.recordSuccess(HAIKU);
  h.recordFailure(OPUS, 0, err('TEAMCLAUDE_UPSTREAM_5XX'));
  assert.equal(h.recordFailure(OPUS, 1, err('TEAMCLAUDE_UPSTREAM_5XX')), true);
});

// --- recovery ---------------------------------------------------------------

test('any success for the model clears the trip immediately', () => {
  const { h } = mh();
  h.recordSuccess(HAIKU);
  h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  h.recordFailure(OPUS, 1, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  assert.equal(h.isOpen(OPUS), true);
  h.recordSuccess(OPUS);
  assert.equal(h.isOpen(OPUS), false, 'recovery must not wait out the timer');
});

test('the trip expires on its own and the next request probes for real', () => {
  const { h, c } = mh({ openMs: 60_000 });
  h.recordSuccess(HAIKU);
  h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  h.recordFailure(OPUS, 1, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  assert.equal(h.isOpen(OPUS), true);
  c.advance(61_000);
  assert.equal(h.isOpen(OPUS), false);
  // State was forgotten, so a single failure does not instantly re-trip.
  h.recordSuccess(HAIKU);
  assert.equal(h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT')), false);
});

test('disabled breaker never trips', () => {
  const { h } = mh({ enabled: false });
  h.recordSuccess(HAIKU);
  h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  h.recordFailure(OPUS, 1, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  assert.equal(h.isOpen(OPUS), false);
});

test('getStatus reports health and open models', () => {
  const { h } = mh();
  h.recordSuccess(HAIKU);
  h.recordFailure(OPUS, 0, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  h.recordFailure(OPUS, 1, err('TEAMCLAUDE_HEADERS_TIMEOUT'));
  const s = h.getStatus();
  assert.equal(s.networkHealthy, true);
  assert.equal(s.openModels.length, 1);
  assert.equal(s.openModels[0].model, OPUS);
});
