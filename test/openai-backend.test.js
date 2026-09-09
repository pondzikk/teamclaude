import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { openAIToAnthropicError, sanitizeSchemaForPython, anthropicToOpenAIRequest, effortToReasoningEffort } from '../src/openai-translate.js';

// End-to-end cover for `protocol: "openai"` accounts (OpenCode Zen's kimi/glm/
// qwen/deepseek models): Claude Code speaks Anthropic /v1/messages to the proxy,
// the upstream sees an OpenAI /chat/completions request, and the client gets an
// Anthropic-shaped response back — buffered and streamed.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The Anthropic request Claude Code would send: a system prompt, a tool, and
// the fields third-party backends choke on.
const CLIENT_REQUEST = {
  model: 'kimi-k3',
  max_tokens: 64,
  system: 'You are terse.',
  messages: [{ role: 'user', content: 'say OK' }],
  tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  tool_choice: { type: 'auto' },
  context_management: { edits: [] },
  metadata: { user_id: 'session_abc' },
};

// Spin up a mock OpenAI backend + a proxy in front of it, run one request
// through, and hand back what each side saw.
async function withOpenAIBackend(handler, clientBody, run) {
  const seen = { url: null, headers: null, body: null };
  const upstream = http.createServer(async (req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    seen.body = JSON.parse(await readBody(req));
    handler(req, res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([{
    name: 'opencode-zen',
    type: 'apikey',
    apiKey: 'zen-secret',
    protocol: 'openai',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    models: ['kimi-k3'],
  }], 0.98);

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1' });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
        'x-api-key': 'k',
      },
      body: JSON.stringify(clientBody),
    });
    return await run(res, seen, am);
  } finally {
    proxy.close();
    upstream.close();
  }
}

// ── request translation, over the wire ───────────────────────────────────────

test('the upstream receives an OpenAI-shaped request at /chat/completions', async () => {
  await withOpenAIBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-1', model: 'kimi-k3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    }));
  }, CLIENT_REQUEST, async (res, seen) => {
    await res.text();

    // (b) the Messages path was replaced, not appended.
    assert.ok(seen.url.endsWith('/chat/completions'), `unexpected upstream path: ${seen.url}`);
    assert.equal(seen.url.includes('/v1/messages'), false);

    // (c)/(d) bearer auth; no Anthropic-only headers leak upstream.
    assert.equal(seen.headers.authorization, 'Bearer zen-secret');
    assert.equal(seen.headers['x-api-key'], undefined);
    assert.equal(seen.headers['anthropic-version'], undefined);
    assert.equal(seen.headers['anthropic-beta'], undefined);
    assert.equal(Number(seen.headers['content-length']), Buffer.byteLength(JSON.stringify(seen.body)));

    // (a) the body is OpenAI Chat Completions.
    assert.equal(seen.body.model, 'kimi-k3');
    assert.equal(seen.body.max_tokens, 64);
    assert.deepEqual(seen.body.messages, [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'say OK' },
    ]);
    assert.deepEqual(seen.body.tools, [{
      type: 'function',
      function: {
        name: 'Read', description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
    assert.equal(seen.body.tool_choice, 'auto');
    // Anthropic-only fields never reach an OpenAI backend (they 400 on them).
    assert.equal('context_management' in seen.body, false);
    assert.equal('metadata' in seen.body, false);
    assert.equal('system' in seen.body, false);
  });
});

// ── non-streaming response ───────────────────────────────────────────────────

test('a buffered OpenAI response reaches the client as an Anthropic message', async () => {
  await withOpenAIBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-1', model: 'kimi-k3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    }));
  }, CLIENT_REQUEST, async (res, _seen, am) => {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      id: 'chatcmpl-1', type: 'message', role: 'assistant', model: 'kimi-k3',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 2 },
    });
    // Usage accounting still works off the translated body.
    assert.equal(am.accounts[0].usage.totalInputTokens, 11);
    assert.equal(am.accounts[0].usage.totalOutputTokens, 2);
  });
});

test('an OpenAI tool call reaches the client as a tool_use block', async () => {
  await withOpenAIBackend((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-2', model: 'kimi-k3',
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"path":"/tmp/x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    }));
  }, CLIENT_REQUEST, async (res) => {
    const body = await res.json();
    assert.equal(body.stop_reason, 'tool_use');
    assert.deepEqual(body.content, [{ type: 'tool_use', id: 'call_a', name: 'Read', input: { path: '/tmp/x' } }]);
  });
});

test('an upstream error body is re-shaped into an Anthropic error envelope', async () => {
  await withOpenAIBackend((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unknown model', type: 'invalid_request_error' } }));
  }, CLIENT_REQUEST, async (res) => {
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'unknown model' },
    });
  });
});

// ── streaming response ───────────────────────────────────────────────────────

function sseChunks(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const c of chunks) res.write(typeof c === 'string' ? c : `data: ${JSON.stringify(c)}\n\n`);
  res.end();
}

// Parse an Anthropic SSE body into [{event, data}].
function parseEvents(text) {
  const out = [];
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    const lines = frame.split('\n');
    const event = lines.find(l => l.startsWith('event: '))?.slice(7);
    const data = JSON.parse(lines.find(l => l.startsWith('data: ')).slice(6));
    assert.equal(event, data.type);
    out.push({ event, data });
  }
  return out;
}

test('a streamed OpenAI response reaches the client as Anthropic SSE', async () => {
  await withOpenAIBackend((_req, res) => {
    sseChunks(res, [
      { id: 'chatcmpl-3', model: 'kimi-k3', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
      { id: 'chatcmpl-3', choices: [{ index: 0, delta: { content: 'O' } }] },
      { id: 'chatcmpl-3', choices: [{ index: 0, delta: { content: 'K' } }] },
      { id: 'chatcmpl-3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'chatcmpl-3', choices: [], usage: { prompt_tokens: 21, completion_tokens: 2 } },
      'data: [DONE]\n\n',
    ]);
  }, { ...CLIENT_REQUEST, stream: true }, async (res, seen, am) => {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    // The upstream was asked to stream, with usage included.
    assert.equal(seen.body.stream, true);
    assert.deepEqual(seen.body.stream_options, { include_usage: true });

    const events = parseEvents(await res.text());
    assert.deepEqual(events.map(e => e.event), [
      'message_start', 'ping', 'content_block_start', 'content_block_delta',
      'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.equal(events[0].data.message.model, 'kimi-k3');
    assert.equal(events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join(''), 'OK');
    assert.equal(events.at(-2).data.delta.stop_reason, 'end_turn');

    // Quota/usage tracking survives the translation: output tokens come from
    // the translated message_delta, input tokens from the final OpenAI usage.
    assert.equal(am.accounts[0].usage.totalOutputTokens, 2);
    assert.equal(am.accounts[0].usage.totalInputTokens, 21);
  });
});

test('a streamed tool call becomes a tool_use content block', async () => {
  await withOpenAIBackend((_req, res) => {
    sseChunks(res, [
      { id: 'c4', model: 'kimi-k3', choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_z', type: 'function', function: { name: 'Read', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      'data: [DONE]\n\n',
    ]);
  }, { ...CLIENT_REQUEST, stream: true }, async (res) => {
    const events = parseEvents(await res.text());
    const start = events.find(e => e.event === 'content_block_start');
    assert.deepEqual(start.data.content_block, { type: 'tool_use', id: 'call_z', name: 'Read', input: {} });
    const json = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(json), { path: '/tmp/x' });
    assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
    assert.equal(events.at(-1).event, 'message_stop');
  });
});

// ── the Anthropic path must be untouched ─────────────────────────────────────

test('an account without `protocol` still speaks Anthropic to its upstream', async () => {
  const seen = { url: null, headers: null, body: null };
  const upstream = http.createServer(async (req, res) => {
    seen.url = req.url;
    seen.headers = req.headers;
    seen.body = JSON.parse(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'anthropic', type: 'apikey', apiKey: 'sk-ant' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'k' },
      body: JSON.stringify(CLIENT_REQUEST),
    });
    const body = await res.json();

    // Path, headers and body all reach upstream exactly as before.
    assert.equal(seen.url, '/v1/messages?beta=true');
    assert.equal(seen.headers['x-api-key'], 'sk-ant');
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(seen.body, CLIENT_REQUEST);
    assert.equal(body.type, 'message');
    assert.equal(am.accounts[0].protocol, null);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// --- error shapes: OpenAI nests, sglang/vLLM do not --------------------------

test('error translation reads the sglang/vLLM top-level shape, not just OpenAI nesting', () => {
  // Verbatim from sglang 0.0.0.dev1 — no `error` wrapper anywhere.
  const sglang = {
    object: 'error',
    message: 'max_completion_tokens is too large: 9999999. This model supports at most 524288 completion tokens.',
    type: 'BadRequestError', param: null, code: 400,
  };
  const out = openAIToAnthropicError(sglang);
  assert.equal(out.type, 'error');
  assert.match(out.error.message, /max_completion_tokens is too large/,
    'the real reason must reach the user, not "upstream error"');
  assert.equal(out.error.type, 'invalid_request_error', 'code 400 → a type Anthropic clients understand');
});

test('the OpenAI nested shape still wins where present', () => {
  const openai = { error: { message: 'bad key', type: 'authentication_error' } };
  const out = openAIToAnthropicError(openai);
  assert.equal(out.error.message, 'bad key');
  assert.equal(out.error.type, 'authentication_error');
});

test('status code drives the type when the upstream names none', () => {
  for (const [code, want] of [[429, 'rate_limit_error'], [401, 'authentication_error'], [503, 'api_error'], [400, 'invalid_request_error']]) {
    assert.equal(openAIToAnthropicError({ object: 'error', message: 'x', code }).error.type, want, `code ${code}`);
  }
});

test('an unparseable body still yields a renderable error', () => {
  assert.equal(openAIToAnthropicError('plain text boom').error.message, 'plain text boom');
  assert.equal(openAIToAnthropicError(null).error.message, 'upstream error');
  assert.equal(openAIToAnthropicError({}).error.type, 'api_error');
});

// --- tool schemas: JS regexes that Python's jsonschema rejects ---------------

// Verbatim from a real Claude Code tool schema; sglang answered 400 for the whole
// request ("is not a 'regex'"), so the model never saw the conversation at all.
const JS_ONLY = '^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}"\\\\./[\\]]{1,200}$';

test('a Unicode-property pattern is dropped, a portable one is kept', () => {
  const out = sanitizeSchemaForPython({
    type: 'object',
    properties: {
      bad: { type: 'string', pattern: JS_ONLY },
      good: { type: 'string', pattern: '^[a-z0-9_-]+$' },
      deep: { type: 'object', properties: { alsoBad: { type: 'string', pattern: JS_ONLY } } },
    },
  });
  assert.equal(out.properties.bad.pattern, undefined, 'the offending pattern must go');
  assert.equal(out.properties.good.pattern, '^[a-z0-9_-]+$', 'portable patterns survive');
  assert.equal(out.properties.deep.properties.alsoBad.pattern, undefined, 'nested too');
  assert.equal(out.properties.bad.type, 'string', 'everything else is preserved');
});

test('patternProperties keys are filtered by the same rule', () => {
  const out = sanitizeSchemaForPython({
    type: 'object',
    patternProperties: { '^x-\\p{L}+$': { type: 'string' }, '^ok-[a-z]+$': { type: 'number' } },
  });
  assert.deepEqual(Object.keys(out.patternProperties), ['^ok-[a-z]+$']);
});

test('only genuinely non-portable constructs are stripped', () => {
  const keep = ['^[a-z]+$', '^(?<=x)y', '^(?!bad)ok$', '\\d{1,3}', '(?i)nope'];
  for (const pattern of keep) {
    assert.equal(sanitizeSchemaForPython({ type: 'string', pattern }).pattern, pattern, pattern);
  }
  for (const pattern of [JS_ONLY, '(?<name>a)', 'a\\h b', 'x*+']) {
    assert.equal(sanitizeSchemaForPython({ type: 'string', pattern }).pattern, undefined, pattern);
  }
});

test('a clean schema is returned untouched (same object, no needless copy)', () => {
  const clean = { type: 'object', properties: { a: { type: 'string', pattern: '^a+$' } } };
  assert.equal(sanitizeSchemaForPython(clean), clean);
});

test('tool translation applies the sanitizer, so the request can actually be sent', () => {
  const oai = anthropicToOpenAIRequest(Buffer.from(JSON.stringify({
    model: 'm', max_tokens: 10,
    tools: [{ name: 'Artifact', input_schema: { type: 'object', properties: { field: { type: 'string', pattern: JS_ONLY } } } }],
    messages: [{ role: 'user', content: 'hi' }],
  })));
  assert.equal(oai.tools[0].function.name, 'Artifact');
  assert.equal(oai.tools[0].function.parameters.properties.field.pattern, undefined,
    'the pattern that 400s a Python-based server must not be forwarded');
});

// --- effort → reasoning_effort (sglang/vLLM chat_template_kwargs) -------------

function withEffort(effort, opts) {
  return anthropicToOpenAIRequest(Buffer.from(JSON.stringify({
    model: 'm', max_tokens: 10,
    ...(effort ? { output_config: { effort } } : {}),
    messages: [{ role: 'user', content: 'hi' }],
  })), opts);
}

test('tiers above high fold down to high, never through verbatim', () => {
  // sglang does not reject an unknown value, it drops the directive — and the model
  // then thinks LESS: measured 86/99/113 tokens for low/medium/high vs 27/35 for
  // "xhigh"/"ultra". Passing them through would invert the user's intent.
  assert.equal(effortToReasoningEffort('low'), 'low');
  assert.equal(effortToReasoningEffort('medium'), 'medium');
  for (const e of ['high', 'xhigh', 'max', 'ultra', 'HIGH', ' Max ']) {
    assert.equal(effortToReasoningEffort(e), 'high', e);
  }
  for (const e of ['', 'nonsense', null, undefined, 7]) {
    assert.equal(effortToReasoningEffort(e), null, String(e));
  }
});

test('opt-in only: without the account flag nothing is added', () => {
  const out = withEffort('high', {});
  assert.equal(out.chat_template_kwargs, undefined,
    'OpenAI proper rejects unknown top-level params — never send this uninvited');
});

test('with the flag, Claude Code effort becomes reasoning_effort', () => {
  assert.deepEqual(withEffort('low', { chatTemplateEffort: true }).chat_template_kwargs,
    { reasoning_effort: 'low' });
  assert.deepEqual(withEffort('xhigh', { chatTemplateEffort: true }).chat_template_kwargs,
    { reasoning_effort: 'high' });
});

test('no effort in the request leaves the server default alone', () => {
  assert.equal(withEffort(null, { chatTemplateEffort: true }).chat_template_kwargs, undefined);
  assert.equal(withEffort('nonsense', { chatTemplateEffort: true }).chat_template_kwargs, undefined);
});
