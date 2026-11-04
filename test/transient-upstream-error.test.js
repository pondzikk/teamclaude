import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientUpstreamError } from '../src/server.js';

const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});

test('network blips are transient (client retries, no account failover)', () => {
  for (const e of [
    err('write EPIPE', 'EPIPE'),
    err('aborted'),
    err('aborted', 'ECONNRESET'),
    err('socket hang up', 'ECONNRESET'),
    err('read ETIMEDOUT', 'ETIMEDOUT'),
    err('80FFE5:error:0A0003FC:SSL routines:ssl3_read_bytes:ssl/tls alert bad record mac'),
    err('x', 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC'),
    err('getaddrinfo EAI_AGAIN api.anthropic.com', 'EAI_AGAIN'),
    Object.assign(new Error('fetch failed'), { cause: err('other side closed', 'UND_ERR_SOCKET') }),
    err('headers timeout', 'TEAMCLAUDE_HEADERS_TIMEOUT'),
  ]) assert.equal(isTransientUpstreamError(e), true, e.message);
});

test('non-network errors still fail over', () => {
  for (const e of [
    err('Unexpected end of JSON input'),
    err('Cannot read properties of undefined'),
    'not an error',
    null,
  ]) assert.equal(isTransientUpstreamError(e), false, String(e?.message ?? e));
});
