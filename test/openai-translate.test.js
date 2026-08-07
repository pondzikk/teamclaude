import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  openAIToAnthropicError,
  OpenAIToAnthropicStream,
  translateOpenAIStream,
  openAIChatCompletionsUrl,
  mapFinishReason,
  blocksToText,
} from '../src/openai-translate.js';

// Covers the `protocol: "openai"` backend support: translating Claude Code's
// Anthropic Messages requests into OpenAI Chat Completions and translating the
// responses (buffered and streamed) back.

// ── request translation ──────────────────────────────────────────────────────

test('a minimal request keeps model/max_tokens and maps a string message', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3', max_tokens: 16,
    messages: [{ role: 'user', content: 'say OK' }],
  });
  assert.equal(out.model, 'kimi-k3');
  assert.equal(out.max_tokens, 16);
  assert.deepEqual(out.messages, [{ role: 'user', content: 'say OK' }]);
});

test('accepts a Buffer body (that is what server.js has in hand)', () => {
  const buf = Buffer.from(JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }));
  const out = anthropicToOpenAIRequest(buf);
  assert.equal(out.model, 'glm-5.2');
  assert.equal(out.messages[0].content, 'hi');
});

test('a string system prompt becomes a leading system message', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3', system: 'You are terse.',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'You are terse.');
  assert.equal(out.messages[1].role, 'user');
});

test('an array system prompt is flattened to text', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    system: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'line one\nline two');
});

test('an empty system prompt adds no system message', () => {
  const out = anthropicToOpenAIRequest({ model: 'kimi-k3', system: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
});

test('text blocks in a user turn collapse to a plain string', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  assert.deepEqual(out.messages, [{ role: 'user', content: 'a\nb' }]);
});

test('a base64 image block becomes an image_url data URI part', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
      ],
    }],
  });
  assert.deepEqual(out.messages[0].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
  ]);
});

test('a url image source is passed through as an image_url', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
  });
  assert.deepEqual(out.messages[0].content, [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]);
});

test('assistant tool_use becomes tool_calls with stringified arguments', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/tmp/x' } },
      ],
    }],
  });
  const m = out.messages[0];
  assert.equal(m.role, 'assistant');
  assert.equal(m.content, 'let me look');
  assert.deepEqual(m.tool_calls, [{
    id: 'toolu_1', type: 'function',
    function: { name: 'Read', arguments: JSON.stringify({ path: '/tmp/x' }) },
  }]);
});

test('tool_result becomes a separate role:tool message carrying tool_call_id', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file contents' }] },
          { type: 'text', text: 'now summarize' },
        ],
      },
    ],
  });
  assert.deepEqual(out.messages.map(m => m.role), ['assistant', 'tool', 'user']);
  assert.deepEqual(out.messages[1], { role: 'tool', tool_call_id: 'toolu_1', content: 'file contents' });
  assert.equal(out.messages[2].content, 'now summarize');
});

test('a tool_result whose content is a plain string round-trips', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }],
  });
  assert.deepEqual(out.messages, [{ role: 'tool', tool_call_id: 't1', content: 'ok' }]);
});

test('a full tool_use → tool_result → answer conversation round-trips in order', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3',
    system: 'sys',
    messages: [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
      { role: 'assistant', content: 'done' },
    ],
  });
  assert.deepEqual(out.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(out.messages[2].tool_calls[0].function.name, 'Read');
  assert.equal(out.messages[3].tool_call_id, 't1');
});

test('tools map name/description/input_schema to the function shape', () => {
  const out = anthropicToOpenAIRequest({
    model: 'kimi-k3', messages: [],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  });
  assert.deepEqual(out.tools, [{
    type: 'function',
    function: {
      name: 'Read', description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }]);
});

test('a tool without input_schema still gets a valid parameters object', () => {
  const out = anthropicToOpenAIRequest({ model: 'kimi-k3', messages: [], tools: [{ name: 'Ping' }] });
  assert.deepEqual(out.tools[0].function.parameters, { type: 'object', properties: {} });
});

test('tool_choice auto/any/tool/none map to the OpenAI forms', () => {
  const call = (tool_choice) => anthropicToOpenAIRequest({ model: 'm', messages: [], tool_choice }).tool_choice;
  assert.equal(call({ type: 'auto' }), 'auto');
  assert.equal(call({ type: 'any' }), 'required');
  assert.equal(call({ type: 'none' }), 'none');
  assert.deepEqual(call({ type: 'tool', name: 'Read' }), { type: 'function', function: { name: 'Read' } });
});

test('disable_parallel_tool_use maps to parallel_tool_calls:false', () => {
  const out = anthropicToOpenAIRequest({
    model: 'm', messages: [], tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  });
  assert.equal(out.parallel_tool_calls, false);
});

test('sampling params carry over and stop_sequences becomes stop', () => {
  const out = anthropicToOpenAIRequest({
    model: 'm', messages: [], max_tokens: 100, temperature: 0.2, top_p: 0.9,
    stop_sequences: ['\n\nHuman:'],
  });
  assert.equal(out.max_tokens, 100);
  assert.equal(out.temperature, 0.2);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop, ['\n\nHuman:']);
});

test('stream:true carries over and asks for usage', () => {
  const out = anthropicToOpenAIRequest({ model: 'm', messages: [], stream: true });
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test('include_usage can be turned off for backends that reject it', () => {
  const out = anthropicToOpenAIRequest({ model: 'm', messages: [], stream: true }, { includeUsage: false });
  assert.equal(out.stream, true);
  assert.equal(out.stream_options, undefined);
});

test('Anthropic-only and unknown fields are dropped', () => {
  const out = anthropicToOpenAIRequest({
    model: 'm', messages: [{ role: 'user', content: 'hi' }],
    context_management: { edits: [] },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    metadata: { user_id: 'session_abc' },
    anthropic_version: '2023-06-01',
    top_k: 5,
    some_future_field: true,
  });
  for (const k of ['context_management', 'thinking', 'metadata', 'anthropic_version', 'top_k', 'some_future_field']) {
    assert.equal(k in out, false, `${k} should not be forwarded`);
  }
  assert.deepEqual(Object.keys(out).sort(), ['messages', 'model']);
});

test('thinking content blocks are dropped from the transcript', () => {
  const out = anthropicToOpenAIRequest({
    model: 'm',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'answer' },
      ],
    }],
  });
  assert.deepEqual(out.messages, [{ role: 'assistant', content: 'answer' }]);
});

test('a non-object body throws so server.js can 400 instead of forwarding it', () => {
  assert.throws(() => anthropicToOpenAIRequest(Buffer.from('not json')));
  assert.throws(() => anthropicToOpenAIRequest(Buffer.from('"a string"')), /not a JSON object/);
});

// ── non-streaming response translation ───────────────────────────────────────

test('a text completion becomes an Anthropic message', () => {
  const out = openAIToAnthropicResponse({
    id: 'chatcmpl-1', model: 'kimi-k3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 2 },
  }, 'kimi-k3');
  assert.deepEqual(out, {
    id: 'chatcmpl-1', type: 'message', role: 'assistant', model: 'kimi-k3',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 2 },
  });
});

test('tool_calls become tool_use blocks with parsed input', () => {
  const out = openAIToAnthropicResponse({
    id: 'c1', model: 'glm-5.2',
    choices: [{
      message: {
        content: 'looking',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/x"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }, 'glm-5.2');
  assert.deepEqual(out.content, [
    { type: 'text', text: 'looking' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/x' } },
  ]);
  assert.equal(out.stop_reason, 'tool_use');
});

test('unparseable tool arguments degrade to an empty input object', () => {
  const out = openAIToAnthropicResponse({
    choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'X', arguments: '{"a":' } }] }, finish_reason: 'tool_calls' }],
  }, 'm');
  assert.deepEqual(out.content[0].input, {});
});

test('finish_reason mapping covers every documented value', () => {
  assert.equal(mapFinishReason('stop'), 'end_turn');
  assert.equal(mapFinishReason('length'), 'max_tokens');
  assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapFinishReason('content_filter'), 'end_turn');
  assert.equal(mapFinishReason('something_new'), 'end_turn');
  assert.equal(mapFinishReason(null), null);
});

test('length finish_reason surfaces as max_tokens', () => {
  const out = openAIToAnthropicResponse({ choices: [{ message: { content: 'trunc' }, finish_reason: 'length' }] }, 'm');
  assert.equal(out.stop_reason, 'max_tokens');
});

test('usage maps prompt/completion tokens and cached tokens', () => {
  const out = openAIToAnthropicResponse({
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } },
  }, 'm');
  assert.deepEqual(out.usage, { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 60 });
});

test('a missing usage block yields zeros rather than undefined', () => {
  const out = openAIToAnthropicResponse({ choices: [{ message: { content: 'x' } }] }, 'm');
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(out.stop_reason, 'end_turn');
});

test('an error body becomes an Anthropic error envelope', () => {
  const out = openAIToAnthropicError({ error: { message: 'bad model', type: 'invalid_request_error' } });
  assert.deepEqual(out, { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } });
});

// ── streaming translation ────────────────────────────────────────────────────

// Parse an Anthropic SSE string into [{event, data}] and sanity-check framing.
function parseEvents(sseText) {
  const out = [];
  for (const frame of sseText.split('\n\n')) {
    if (!frame.trim()) continue;
    const lines = frame.split('\n');
    const eventLine = lines.find(l => l.startsWith('event: '));
    const dataLine = lines.find(l => l.startsWith('data: '));
    assert.ok(eventLine, `frame without event line: ${frame}`);
    assert.ok(dataLine, `frame without data line: ${frame}`);
    const data = JSON.parse(dataLine.slice(6));
    assert.equal(data.type, eventLine.slice(7), 'event name must match data.type');
    out.push({ event: eventLine.slice(7), data });
  }
  return out;
}

function oaiChunk(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

test('a text stream emits message_start → content_block_* → message_delta → message_stop', () => {
  const t = new OpenAIToAnthropicStream({ model: 'kimi-k3' });
  let sse = '';
  sse += t.push(oaiChunk({ id: 'chatcmpl-9', model: 'kimi-k3', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
  sse += t.push(oaiChunk({ id: 'chatcmpl-9', choices: [{ index: 0, delta: { content: 'Hel' } }] }));
  sse += t.push(oaiChunk({ id: 'chatcmpl-9', choices: [{ index: 0, delta: { content: 'lo' } }] }));
  sse += t.push(oaiChunk({ id: 'chatcmpl-9', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  sse += t.push(oaiChunk({ id: 'chatcmpl-9', choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }));
  sse += t.push('data: [DONE]\n\n');

  const events = parseEvents(sse);
  assert.deepEqual(events.map(e => e.event), [
    'message_start', 'ping', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);

  const start = events[0].data.message;
  assert.equal(start.id, 'chatcmpl-9');
  assert.equal(start.model, 'kimi-k3');
  assert.equal(start.role, 'assistant');
  assert.deepEqual(start.usage, { input_tokens: 0, output_tokens: 0 });

  assert.deepEqual(events[2].data.content_block, { type: 'text', text: '' });
  assert.equal(events[3].data.delta.type, 'text_delta');
  const text = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('');
  assert.equal(text, 'Hello');

  assert.deepEqual(events.at(-2).data.delta, { stop_reason: 'end_turn', stop_sequence: null });
  assert.equal(events.at(-2).data.usage.output_tokens, 2);
  // The final usage is surfaced for the server's account accounting.
  assert.deepEqual(t.usage, { input_tokens: 12, output_tokens: 2 });
});

test('SSE frames split across chunk boundaries are reassembled', () => {
  const t = new OpenAIToAnthropicStream({ model: 'm' });
  const full = oaiChunk({ id: 'c', choices: [{ delta: { content: 'split me' } }] });
  const cut = Math.floor(full.length / 2);
  let sse = t.push(full.slice(0, cut));
  sse += t.push(full.slice(cut));
  sse += t.flush();
  const events = parseEvents(sse);
  const text = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('');
  assert.equal(text, 'split me');
  assert.equal(events.at(-1).event, 'message_stop');
});

test('a tool_call stream emits a tool_use block with input_json_delta fragments', () => {
  const t = new OpenAIToAnthropicStream({ model: 'glm-5.2' });
  let sse = '';
  sse += t.push(oaiChunk({ id: 'c1', model: 'glm-5.2', choices: [{ delta: { role: 'assistant', content: '' } }] }));
  sse += t.push(oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] } }] }));
  sse += t.push(oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] }));
  sse += t.push(oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/tmp/x"}' } }] } }] }));
  sse += t.push(oaiChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  sse += t.push('data: [DONE]\n\n');

  const events = parseEvents(sse);
  assert.deepEqual(events.map(e => e.event), [
    'message_start', 'ping', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.deepEqual(events[2].data.content_block, { type: 'tool_use', id: 'call_a', name: 'Read', input: {} });
  const json = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { path: '/tmp/x' });
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
});

test('text followed by a tool call produces two correctly indexed blocks', () => {
  const t = new OpenAIToAnthropicStream({ model: 'm' });
  let sse = t.push(oaiChunk({ id: 'c', choices: [{ delta: { content: 'thinking' } }] }));
  sse += t.push(oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Bash', arguments: '{}' } }] } }] }));
  sse += t.push('data: [DONE]\n\n');

  const events = parseEvents(sse);
  const starts = events.filter(e => e.event === 'content_block_start');
  const stops = events.filter(e => e.event === 'content_block_stop');
  assert.equal(starts.length, 2);
  assert.equal(stops.length, 2);
  assert.equal(starts[0].data.index, 0);
  assert.equal(starts[0].data.content_block.type, 'text');
  assert.equal(starts[1].data.index, 1);
  assert.equal(starts[1].data.content_block.type, 'tool_use');
  assert.deepEqual(stops.map(s => s.data.index), [0, 1]);
});

test('two parallel tool calls become two tool_use blocks', () => {
  const t = new OpenAIToAnthropicStream({ model: 'm' });
  let sse = t.push(oaiChunk({
    id: 'c',
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, id: 'call_a', function: { name: 'A', arguments: '{"x":1}' } },
          { index: 1, id: 'call_b', function: { name: 'B', arguments: '{"y":2}' } },
        ],
      },
    }],
  }));
  sse += t.push('data: [DONE]\n\n');
  const events = parseEvents(sse);
  const starts = events.filter(e => e.event === 'content_block_start');
  assert.deepEqual(starts.map(s => s.data.content_block.name), ['A', 'B']);
  assert.deepEqual(starts.map(s => s.data.index), [0, 1]);
  assert.equal(events.at(-1).event, 'message_stop');
});

test('a stream that ends without [DONE] is still closed out by flush()', () => {
  const t = new OpenAIToAnthropicStream({ model: 'm' });
  let sse = t.push(oaiChunk({ id: 'c', choices: [{ delta: { content: 'hi' }, finish_reason: 'length' }] }));
  sse += t.flush();
  const events = parseEvents(sse);
  assert.equal(events.at(-1).event, 'message_stop');
  assert.equal(events.at(-2).data.delta.stop_reason, 'max_tokens');
  assert.equal(events.filter(e => e.event === 'content_block_stop').length, 1);
});

test('flush() after [DONE] emits nothing (no duplicate message_stop)', () => {
  const t = new OpenAIToAnthropicStream({ model: 'm' });
  t.push(oaiChunk({ id: 'c', choices: [{ delta: { content: 'hi' } }] }));
  const tail = t.push('data: [DONE]\n\n');
  assert.match(tail, /message_stop/);
  assert.equal(t.flush(), '');
});

test('an empty stream still emits a well-formed message envelope', () => {
  const t = new OpenAIToAnthropicStream({ model: 'm' });
  const events = parseEvents(t.flush());
  assert.deepEqual(events.map(e => e.event), ['message_start', 'ping', 'message_delta', 'message_stop']);
});

test('translateOpenAIStream re-frames a ReadableStream and reports usage', async () => {
  const chunks = [
    oaiChunk({ id: 'c9', model: 'kimi-k3', choices: [{ delta: { role: 'assistant', content: 'Hi' } }] }),
    oaiChunk({ choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] }),
    oaiChunk({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 3 } }),
    'data: [DONE]\n\n',
  ];
  const enc = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

  let reported = null;
  const translated = translateOpenAIStream(source, { model: 'kimi-k3', onUsage: (u) => { reported = u; } });
  const reader = translated.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }

  const events = parseEvents(text);
  assert.deepEqual(events.map(e => e.event), [
    'message_start', 'ping', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.equal(events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join(''), 'Hi there');
  assert.deepEqual(reported, { input_tokens: 40, output_tokens: 3 });
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('openAIChatCompletionsUrl handles bases with and without /v1', () => {
  assert.equal(openAIChatCompletionsUrl('https://opencode.ai/zen'), 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(openAIChatCompletionsUrl('https://opencode.ai/zen/'), 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(openAIChatCompletionsUrl('https://opencode.ai/zen/v1'), 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(openAIChatCompletionsUrl('http://127.0.0.1:9/v1/chat/completions'), 'http://127.0.0.1:9/v1/chat/completions');
});

test('blocksToText flattens strings, arrays and non-text blocks', () => {
  assert.equal(blocksToText('plain'), 'plain');
  assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(blocksToText(undefined), '');
});
