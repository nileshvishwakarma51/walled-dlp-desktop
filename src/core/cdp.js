'use strict';
/**
 * Minimal Chrome DevTools Protocol client over the browser's debugging pipe
 * (--remote-debugging-pipe: fd 3 = commands in, fd 4 = messages out).
 * Using a pipe instead of a TCP port means no other local process can
 * connect to the browser's debugger.
 */
const { EventEmitter } = require('events');

class CDPConnection extends EventEmitter {
  constructor(writable, readable) {
    super();
    this._w = writable;
    this._id = 0;
    this._callbacks = new Map();
    this._buf = '';
    this.closed = false;
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => this._onData(chunk));
    readable.on('close', () => this._onClose());
    readable.on('error', () => this._onClose());
    writable.on('error', () => this._onClose());
  }

  _onData(chunk) {
    this._buf += chunk;
    let end;
    while ((end = this._buf.indexOf('\0')) !== -1) {
      const raw = this._buf.slice(0, end);
      this._buf = this._buf.slice(end + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && this._callbacks.has(msg.id)) {
        const { resolve, reject, method } = this._callbacks.get(msg.id);
        this._callbacks.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.emit('event', msg.method, msg.params || {}, msg.sessionId);
      }
    }
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, method } of this._callbacks.values()) reject(new Error(`${method}: connection closed`));
    this._callbacks.clear();
    this.emit('close');
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = ++this._id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, method });
      this._w.write(JSON.stringify(msg) + '\0');
    });
  }
}

module.exports = { CDPConnection };
