/**
 * Anthropic Messages API ⇄ OpenAI Chat Completions API translation.
 *
 * Claude Code only speaks the Anthropic `/v1/messages` protocol, but some
 * upstreams (OpenCode Zen's kimi, glm, qwen and deepseek models, vLLM, Ollama,
 * …) only serve `/chat/completions`. An account marked `"protocol": "openai"`
 * runs its requests and responses through this module; every other account is
 * untouched (server.js gates all of it on `account.protocol === 'openai'`).
 *
 * Everything here is pure: buffers/objects in, objects/strings out. The only
 * stateful piece is OpenAIToAnthropicStream, which is a line-oriented SSE
 * transducer, and translateOpenAIStream, which wraps it in a ReadableStream so
 * the existing streamResponse() can consume it unchanged.
 */

// OpenAI finish_reason → Anthropic stop_reason.
const FINISH_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

export function mapFinishReason(reason) {
  if (reason == null || reason === '') return null;
  return FINISH_REASON_MAP[reason] || 'end_turn';
}

let idCounter = 0;
function genId(prefix) {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}`;
}

function safeParseJson(text, fallback = {}) {
  if (typeof text !== 'string' || text.trim() === '') return fallback;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Flatten an Anthropic content value (string, or array of blocks) to plain
 * text. Non-text blocks (thinking, images, …) contribute nothing.
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// An Anthropic image block → an OpenAI image_url part (base64 data URI).
function imageBlockToPart(block) {
  const src = block.source || {};
  if (src.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/**
 * Translate an Anthropic Messages request into an OpenAI Chat Completions
 * request. Accepts a Buffer/string of JSON or an already-parsed object; always
 * returns a fresh plain object (the input is never mutated).
 *
 * Unknown / Anthropic-only fields (context_management, thinking, metadata,
 * anthropic_version, top_k, …) are dropped — third-party OpenAI-compatible
 * backends reject unknown fields with a 400.
 */
export function anthropicToOpenAIRequest(input, { includeUsage = true } = {}) {
  const src = (Buffer.isBuffer(input) || typeof input === 'string')
    ? JSON.parse(input.toString('utf8'))
    : input;
  if (!src || typeof src !== 'object') throw new Error('request body is not a JSON object');

  const out = { model: src.model, messages: [] };

  // system (string or array of text blocks) → a leading system message.
  if (src.system != null) {
    const sys = blocksToText(src.system);
    if (sys) out.messages.push({ role: 'system', content: sys });
  }

  for (const msg of Array.isArray(src.messages) ? src.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    if (typeof msg.content === 'string') {
      out.messages.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    // tool_result blocks become their own `role:'tool'` messages, emitted
    // BEFORE whatever else the user turn carries (OpenAI wants tool replies
    // adjacent to the assistant turn that requested them).
    const toolMessages = [];
    const parts = [];
    const toolCalls = [];

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text });
          break;
        case 'image': {
          const part = imageBlockToPart(block);
          if (part) parts.push(part);
          break;
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id || genId('call'),
            type: 'function',
            function: { name: block.name || '', arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case 'tool_result':
          toolMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id || '',
            content: blocksToText(block.content),
          });
          break;
        default:
          // thinking / redacted_thinking / server-tool blocks: dropped.
          break;
      }
    }

    for (const tm of toolMessages) out.messages.push(tm);

    const hasImage = parts.some(p => p.type === 'image_url');
    const textOnly = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (role === 'assistant') {
      if (parts.length || toolCalls.length) {
        const m = { role: 'assistant', content: hasImage ? parts : textOnly };
        if (toolCalls.length) m.tool_calls = toolCalls;
        out.messages.push(m);
      }
    } else if (parts.length) {
      out.messages.push({ role: 'user', content: hasImage ? parts : textOnly });
    }
  }

  if (Array.isArray(src.tools) && src.tools.length) {
    const tools = [];
    for (const t of src.tools) {
      if (!t || !t.name) continue;
      const fn = { name: t.name, parameters: sanitizeSchemaForPython(t.input_schema || { type: 'object', properties: {} }) };
      if (t.description) fn.description = t.description;
      tools.push({ type: 'function', function: fn });
    }
    if (tools.length) out.tools = tools;
  }

  const tc = src.tool_choice;
  if (tc && typeof tc === 'object') {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    if (tc.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  }

  if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (Array.isArray(src.stop_sequences) && src.stop_sequences.length) out.stop = src.stop_sequences;
  if (src.stream === true) {
    out.stream = true;
    // OpenAI streams carry no usage unless asked; without this the account's
    // token counters would stay at zero for every streaming request.
    if (includeUsage) out.stream_options = { include_usage: true };
  }

  return out;
}

function usageToAnthropic(u) {
  const usage = {
    input_tokens: Number(u?.prompt_tokens) || 0,
    output_tokens: Number(u?.completion_tokens) || 0,
  };
  const cached = Number(u?.prompt_tokens_details?.cached_tokens);
  if (cached > 0) usage.cache_read_input_tokens = cached;
  return usage;
}

/**
 * Translate a non-streaming OpenAI Chat Completions response into an Anthropic
 * Messages response.
 */
export function openAIToAnthropicResponse(oai, model) {
  const choice = (oai && Array.isArray(oai.choices) ? oai.choices[0] : null) || {};
  const message = choice.message || {};

  const content = [];
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('')
      : '';
  if (text) content.push({ type: 'text', text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    if (!call) continue;
    content.push({
      type: 'tool_use',
      id: call.id || genId('toolu'),
      name: call.function?.name || '',
      input: safeParseJson(call.function?.arguments),
    });
  }

  const stopReason = toolCalls.length ? 'tool_use' : (mapFinishReason(choice.finish_reason) || 'end_turn');

  return {
    id: oai?.id || genId('msg'),
    type: 'message',
    role: 'assistant',
    model: oai?.model || model || '',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageToAnthropic(oai?.usage),
  };
}

/**
 * Translate an OpenAI-shaped error body into an Anthropic error body, so a
 * failing upstream still produces something Claude Code can render.
 */
/**
 * JSON Schema regexes that Python's `re` cannot compile.
 *
 * OpenAI-compatible servers built on Python (sglang, vLLM) validate every tool's
 * `parameters` against the JSON Schema metaschema, which requires each `pattern`
 * to be format "regex" — checked with Python's own engine. Claude Code ships
 * JavaScript regexes, and a single incompatible one fails the WHOLE request:
 *
 *   Tool 1 function has invalid 'parameters' schema:
 *   '^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$' is not a 'regex'
 *
 * The conversation then 400s before the model sees anything. Dropping the offending
 * `pattern` costs nothing that matters — it is an advisory constraint models do not
 * enforce anyway — while keeping it costs the entire session.
 *
 * Deliberately narrow: only constructs Python genuinely lacks. Lookbehind is NOT
 * listed, because Python supports (?<= and (?<!; only JS-style named groups (?<name>
 * differ, Python spelling them (?P<name>.
 */
const PY_INCOMPATIBLE_REGEX = [
  /\\[pP]\{/,        // \p{Cc} Unicode property escapes — the observed breakage
  /\(\?<[^=!]/,       // (?<name>  JS named group; Python needs (?P<name>
  /\\[hRX]/,          // \h \R \X — PCRE, absent from Python re
  /[*+?}]\+/,          // possessive quantifiers a*+ a++ a{2,}+
];

function regexPortableToPython(pattern) {
  return typeof pattern === 'string' && !PY_INCOMPATIBLE_REGEX.some(re => re.test(pattern));
}

/**
 * Deep copy of a JSON Schema with every non-portable `pattern` removed (and any
 * `patternProperties` key whose regex is non-portable dropped along with its
 * subschema). Returns the input untouched when nothing needed changing, so the
 * common case allocates nothing.
 */
export function sanitizeSchemaForPython(schema) {
  let changed = false;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'pattern' && !regexPortableToPython(v)) { changed = true; continue; }
      if (k === 'patternProperties' && v && typeof v === 'object') {
        const kept = {};
        for (const [rx, sub] of Object.entries(v)) {
          if (regexPortableToPython(rx)) kept[rx] = walk(sub); else changed = true;
        }
        if (Object.keys(kept).length) out[k] = kept;
        continue;
      }
      out[k] = walk(v);
    }
    return out;
  };
  const result = walk(schema);
  return changed ? result : schema;
}

export function openAIToAnthropicError(oai) {
  const err = oai?.error || {};
  // Two shapes in the wild. OpenAI nests: {"error":{"message","type"}}. sglang and
  // vLLM do NOT — they answer {"object":"error","message":"…","type":"BadRequestError",
  // "code":400} with everything at the TOP level. Reading only err.message turned
  // every one of those into a bare "upstream error", which is exactly the string a
  // user sees instead of the real reason (measured against sglang 0.0.0.dev1).
  const message = err.message
    ?? (typeof oai?.message === 'string' ? oai.message : null)
    ?? (typeof oai === 'string' ? oai : 'upstream error');

  // Keep the type within the set Anthropic clients branch on — an unknown string
  // like "BadRequestError" can defeat their retry logic. Derive it from the status
  // code when the upstream gives one, else fall back to the nested type.
  const code = Number(oai?.code ?? err.code);
  const type = err.type
    ?? (code >= 500 ? 'api_error'
      : code === 429 ? 'rate_limit_error'
        : code === 401 || code === 403 ? 'authentication_error'
          : code >= 400 ? 'invalid_request_error'
            : 'api_error');

  return { type: 'error', error: { type, message } };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Line-oriented transducer: feed it OpenAI SSE text with push(), get back
 * Anthropic SSE text. Call flush() once the upstream stream ends to close out
 * anything the upstream left open (some backends never send `[DONE]`).
 *
 * Emitted sequence:
 *   message_start → ping → (content_block_start → content_block_delta* →
 *   content_block_stop)* → message_delta → message_stop
 */
export class OpenAIToAnthropicStream {
  constructor({ model = '', id = null } = {}) {
    this.model = model;
    this.id = id;
    this.buffer = '';
    this.started = false;     // message_start emitted
    this.finished = false;    // message_stop emitted
    this.nextIndex = 0;       // next Anthropic content block index
    this.openIndex = null;    // currently open content block index
    this.textOpen = false;
    this.finishReason = null;
    this.sawToolCall = false;
    // OpenAI tool_call index → { id, name, blockIndex|null, started }
    this.tools = new Map();
    this.usage = { input_tokens: 0, output_tokens: 0 };
  }

  /** Consume a chunk of OpenAI SSE text; returns Anthropic SSE text (may be ''). */
  push(text) {
    if (this.finished) return '';
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    let out = '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue; // event:/comment/blank lines
      const payload = line.slice(5).trim();
      if (payload === '') continue;
      if (payload === '[DONE]') { out += this._finalize(); return out; }
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      out += this._handleChunk(chunk);
    }
    return out;
  }

  /** Close out the message if the upstream ended without `[DONE]`. */
  flush() {
    if (this.finished) return '';
    let out = '';
    // A trailing line without its newline (rare, but a legal split point).
    if (this.buffer.startsWith('data:')) {
      const payload = this.buffer.slice(5).trim();
      this.buffer = '';
      if (payload === '[DONE]') return this._finalize();
      try { out += this._handleChunk(JSON.parse(payload)); } catch { /* partial JSON — drop */ }
    }
    return out + this._finalize();
  }

  _start(chunk) {
    if (this.started) return '';
    this.started = true;
    this.id = this.id || chunk?.id || genId('msg');
    if (chunk?.model) this.model = chunk.model;
    const message = {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.model || '',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // Real token counts only arrive at the END of an OpenAI stream; the
      // server hands the final `usage` to accountManager separately.
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    return sse('message_start', { type: 'message_start', message }) +
      sse('ping', { type: 'ping' });
  }

  _closeOpenBlock() {
    if (this.openIndex == null) return '';
    const out = sse('content_block_stop', { type: 'content_block_stop', index: this.openIndex });
    this.openIndex = null;
    this.textOpen = false;
    return out;
  }

  _handleChunk(chunk) {
    let out = this._start(chunk);

    if (chunk?.usage) {
      const u = usageToAnthropic(chunk.usage);
      if (u.input_tokens) this.usage.input_tokens = u.input_tokens;
      if (u.output_tokens) this.usage.output_tokens = u.output_tokens;
      if (u.cache_read_input_tokens) this.usage.cache_read_input_tokens = u.cache_read_input_tokens;
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
    if (!choice) return out;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta || {};

    // Some backends put the whole message in `choice.message` on the last
    // chunk instead of a delta; treat it as text so nothing is lost.
    const textDelta = typeof delta.content === 'string' && delta.content !== ''
      ? delta.content
      : (typeof choice.message?.content === 'string' && !delta.content ? choice.message.content : '');

    if (textDelta) {
      if (!this.textOpen) {
        out += this._closeOpenBlock();
        this.openIndex = this.nextIndex++;
        this.textOpen = true;
        out += sse('content_block_start', {
          type: 'content_block_start', index: this.openIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      out += sse('content_block_delta', {
        type: 'content_block_delta', index: this.openIndex,
        delta: { type: 'text_delta', text: textDelta },
      });
    }

    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of calls) {
      if (!call) continue;
      const key = call.index ?? 0;
      let state = this.tools.get(key);
      if (!state) { state = { id: null, name: '', blockIndex: null, started: false }; this.tools.set(key, state); }
      this.sawToolCall = true;
      if (call.id && !state.started) state.id = call.id;
      const fname = call.function?.name;
      if (typeof fname === 'string' && fname && !state.started) state.name += fname;
      const args = call.function?.arguments;

      // Open the block once we have a name (or as soon as arguments start
      // flowing, for backends that stream the name in fragments).
      if (!state.started && (state.name || (typeof args === 'string' && args !== ''))) {
        out += this._closeOpenBlock();
        state.blockIndex = this.nextIndex++;
        state.started = true;
        this.openIndex = state.blockIndex;
        out += sse('content_block_start', {
          type: 'content_block_start', index: state.blockIndex,
          content_block: { type: 'tool_use', id: state.id || genId('toolu'), name: state.name, input: {} },
        });
      }
      if (state.started && typeof args === 'string' && args !== '') {
        // A tool block that was closed by later text has to be reopened —
        // interleaving never happens in practice, so just append to whatever
        // block this tool owns.
        out += sse('content_block_delta', {
          type: 'content_block_delta', index: state.blockIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }

    return out;
  }

  _finalize() {
    if (this.finished) return '';
    let out = this.started ? '' : this._start(null);
    out += this._closeOpenBlock();

    // A tool_call announced but never opened (no name, no arguments) still
    // needs a well-formed block so the client isn't left with a dangling id.
    for (const state of this.tools.values()) {
      if (state.started) continue;
      state.blockIndex = this.nextIndex++;
      state.started = true;
      out += sse('content_block_start', {
        type: 'content_block_start', index: state.blockIndex,
        content_block: { type: 'tool_use', id: state.id || genId('toolu'), name: state.name, input: {} },
      });
      out += sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex });
    }

    const stopReason = this.sawToolCall ? 'tool_use' : (mapFinishReason(this.finishReason) || 'end_turn');
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        ...(this.usage.cache_read_input_tokens ? { cache_read_input_tokens: this.usage.cache_read_input_tokens } : {}),
      },
    });
    out += sse('message_stop', { type: 'message_stop' });
    this.finished = true;
    return out;
  }
}

/**
 * Wrap an upstream OpenAI SSE ReadableStream in one that yields Anthropic SSE
 * bytes, so server.js's streamResponse() (which parses message_start /
 * message_delta for usage) can consume it unchanged.
 *
 * `onUsage` is called once with the final usage totals — OpenAI only reports
 * them in the last chunk, long after our message_start went out with zeros.
 */
export function translateOpenAIStream(webStream, { model = '', onUsage = null } = {}) {
  const translator = new OpenAIToAnthropicStream({ model });
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let done = false;

  return new ReadableStream({
    // Keep reading until this pull produces bytes (or upstream ends): a pull
    // that enqueues nothing is NOT retried by the streams spec, so returning
    // empty-handed on a usage-only / keep-alive chunk would wedge the reader.
    async pull(controller) {
      while (!done) {
        let result;
        try {
          result = await reader.read();
        } catch (err) {
          done = true;
          controller.error(err);
          return;
        }
        if (result.done) {
          done = true;
          const tail = translator.flush();
          if (tail) controller.enqueue(encoder.encode(tail));
          try { onUsage?.(translator.usage); } catch { /* usage accounting must never break the stream */ }
          controller.close();
          return;
        }
        const out = translator.push(decoder.decode(result.value, { stream: true }));
        if (out) { controller.enqueue(encoder.encode(out)); return; }
      }
    },
    cancel(reason) {
      done = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Build the Chat Completions URL for an account's `upstream` base. Accepts a
 * base with or without the trailing `/v1` (both `https://opencode.ai/zen` and
 * `https://opencode.ai/zen/v1` resolve to `…/zen/v1/chat/completions`), and
 * leaves a base that already names the endpoint alone.
 */
export function openAIChatCompletionsUrl(base) {
  const trimmed = String(base || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}
