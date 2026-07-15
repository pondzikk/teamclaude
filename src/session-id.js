// Extract Claude Code's session_id from a /v1/messages request body WITHOUT
// parsing the whole JSON. Claude Code sends metadata.user_id as a stringified
// JSON:  {"device_id":"...","account_uuid":"...","session_id":"<uuid>"}
// so inside the (escaped) user_id string value the bytes read
//   session_id\":\"<36 chars>
//
// Same streaming byte-exact JSON state machine as AccountUuidPatcher — no
// regex, no whole-body buffering — and it only inspects a string value at
// top-level `metadata.user_id`, so the same byte pattern appearing in message
// content or tool results can never produce a false match.
//
// The session id is the affinity key for cache-preserving routing: Anthropic's
// prompt cache is per-account, so all of a session's requests must land on the
// same account to stay cache-warm (see AccountManager.getAccountForSession).

const PREFIX = Buffer.from('session_id\\":\\"', 'latin1');

// KMP failure table: unlike account-uuid's pattern, PREFIX repeats its first
// byte internally ("seSSion"), so the naive reset-to-0-or-1 used by the
// patcher could skip a real match after an overlapping partial one.
const FAIL = (() => {
  const f = new Array(PREFIX.length).fill(0);
  for (let i = 1, k = 0; i < PREFIX.length; i++) {
    while (k > 0 && PREFIX[i] !== PREFIX[k]) k = f[k - 1];
    if (PREFIX[i] === PREFIX[k]) k++;
    f[i] = k;
  }
  return f;
})();

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export class SessionIdFinder {
  constructor() {
    this.frames = [];          // container stack: { container:'obj'|'arr', name, key, awaitingKey }
    this.inStr = false;
    this.esc = false;
    this.readingKey = false;
    this.keyBuf = [];
    this.target = false;       // inside the metadata.user_id string value
    this.matchPos = 0;         // PREFIX match progress (within target)
    this.captureRemaining = 0; // value bytes left to capture
    this.captured = [];
    this.pending = null;       // captured 36 bytes awaiting their delimiter
    this.awaitDelim = false;
    this.done = false;
    this.value = null;         // the extracted session id (or null)
  }

  /** Feed a chunk (read-only; chunks may split the pattern anywhere). */
  push(chunk) {
    if (this.done) return;
    for (let i = 0; i < chunk.length; i++) {
      this.#byte(chunk[i]);
      if (this.done) return;
    }
  }

  #top() { return this.frames[this.frames.length - 1]; }

  #byte(b) {
    if (this.target) return this.#targetByte(b);

    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.readingKey) this.keyBuf.push(b); return; }
      if (b === 0x5c) { this.esc = true; return; }               // backslash
      if (b === 0x22) {                                          // end of string
        this.inStr = false;
        if (this.readingKey) { this.#top().key = Buffer.from(this.keyBuf).toString('latin1'); this.keyBuf = []; this.readingKey = false; }
        return;
      }
      if (this.readingKey) this.keyBuf.push(b);
      return;
    }

    const top = this.#top();
    switch (b) {
      case 0x7b: this.frames.push({ container: 'obj', name: top ? top.key : null, key: null, awaitingKey: true }); break; // {
      case 0x5b: this.frames.push({ container: 'arr', name: top ? top.key : null, key: null, awaitingKey: false }); break; // [
      case 0x7d: case 0x5d: this.frames.pop(); break;            // } ]
      case 0x3a: if (top) top.awaitingKey = false; break;        // : (key → value)
      case 0x2c: if (top && top.container === 'obj') top.awaitingKey = true; break; // ,
      case 0x22:                                                 // string start
        if (top && top.container === 'obj' && top.awaitingKey) {
          this.readingKey = true; this.keyBuf = []; this.inStr = true; this.esc = false;
        } else {
          this.inStr = true; this.esc = false; this.readingKey = false;
          if (top && top.container === 'obj' && top.name === 'metadata' && top.key === 'user_id' && this.frames.length === 2) {
            this.target = true; this.matchPos = 0; this.captureRemaining = 0;
          }
        }
        break;
      default: break; // scalars / whitespace
    }
  }

  // Inside the metadata.user_id string value: stream-match the session_id key
  // and capture its 36-byte value, then require the value's own closing
  // delimiter (the \" that ends it inside the stringified JSON) so a longer
  // uuid-charset-prefixed value is rejected rather than silently truncated —
  // truncation could collide two distinct sessions onto one binding.
  #targetByte(b) {
    if (this.captureRemaining > 0) {
      this.captured.push(b);
      this.captureRemaining--;
      if (this.captureRemaining === 0) {
        const s = Buffer.from(this.captured).toString('latin1');
        this.pending = UUID_RE.test(s) ? s : null;
        if (this.pending == null) { this.done = true; return; } // invalid regardless of delimiter
        this.awaitDelim = true;
      }
      return;
    }
    if (this.awaitDelim) {
      this.value = (b === 0x5c || b === 0x22) ? this.pending : null;
      this.done = true; // one user_id per body
      return;
    }
    if (this.esc) { this.esc = false; this.#match(b); return; }
    if (b === 0x5c) { this.esc = true; this.#match(b); return; }
    if (b === 0x22) {
      // Unescaped quote: the user_id value ends — and so does the enclosing
      // JSON string. inStr must drop with it, or the outer machine would treat
      // the rest of the body as string content (desync: the metadata frame
      // never pops and later message content could match as if it were the
      // target — the source of phantom session ids for plain-string user_ids).
      this.target = false;
      this.inStr = false;
      this.matchPos = 0;
      return;
    }
    this.#match(b);
  }

  #match(b) {
    while (this.matchPos > 0 && b !== PREFIX[this.matchPos]) this.matchPos = FAIL[this.matchPos - 1];
    if (b === PREFIX[this.matchPos]) this.matchPos++;
    if (this.matchPos === PREFIX.length) { this.captureRemaining = 36; this.matchPos = 0; }
  }
}

/** One-shot convenience: the session id in `buf`, or null. */
export function extractSessionId(buf) {
  const f = new SessionIdFinder();
  f.push(buf);
  return f.value;
}
