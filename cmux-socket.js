'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Client direct du socket de contrôle cmux.
//
// Le CLI cmux résout l'authentification et la connexion à chaque appel : ça
// coûte ~150 ms par commande. En gardant une seule connexion ouverte, un
// appel coûte ~3 ms. C'est ce qui rend l'interface fluide.
//
// Protocole (v2) : une ligne "auth <mot de passe>", puis des lignes JSON
// {"id":…,"method":…,"params":{…}} et une réponse
// {"id":…,"ok":true,"result":{…}} ou {"ok":false,"error":{…}}.
// ---------------------------------------------------------------------------

class CmuxSocket {
  constructor(options) {
    this.socket = null;
    this.pending = new Map();
    this.buffer = '';
    this.seq = 0;
    this.authenticated = false;
    this.connecting = null;
    this.password = (options && options.password) || '';
  }

  socketPath() {
    const candidates = [
      process.env.CMUX_SOCKET_PATH,
      path.join(os.homedir(), '.local', 'state', 'cmux', 'last-socket-path'),
      '/tmp/cmux-last-socket-path',
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const value = fs.readFileSync(candidate, 'utf8').trim();
        if (value) return value;
      } catch { /* on essaie le suivant */ }
    }
    return path.join(os.homedir(), '.local', 'state', 'cmux', 'cmux.sock');
  }

  connect() {
    if (this.socket && !this.socket.destroyed && this.authenticated) {
      return Promise.resolve(this);
    }
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath());
      const onError = (e) => {
        socket.destroy();
        this.connecting = null;
        reject(e);
      };
      socket.once('error', onError);

      socket.on('connect', () => {
        const secret = typeof this.password === 'function' ? this.password() : this.password;
        socket.write('auth ' + secret + '\n');
      });

      socket.on('data', (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (!line) continue;
          if (line.startsWith('OK:')) {
            this.authenticated = true;
            this.connecting = null;
            socket.removeListener('error', onError);
            socket.on('error', () => this.reset());
            resolve(this);
            continue;
          }
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            pending(message);
          }
        }
      });

      socket.on('close', () => {
        this.reset();
        for (const pending of this.pending.values()) {
          pending({ ok: false, error: { code: 'disconnected', message: 'socket closed' } });
        }
        this.pending.clear();
      });

      this.socket = socket;
      setTimeout(() => {
        if (!this.authenticated) onError(new Error('cmux socket authentication timeout'));
      }, 5000).unref();
    });

    return this.connecting;
  }

  reset() {
    this.authenticated = false;
    this.connecting = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async call(method, params, options) {
    const retry = !options || options.retry !== false;
    await this.connect();
    const response = await new Promise((resolve) => {
      const id = 'w' + (++this.seq) + '-' + Date.now().toString(36);
      this.pending.set(id, resolve);
      try {
        this.socket.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'disconnected', message: String(e.message || e) } });
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ ok: false, error: { code: 'timeout', message: 'socket timeout' } });
        }
      }, 10000).unref();
    });

    // Le serveur peut demander un court délai sur les lectures polligées.
    if (response.ok === false && response.error
        && response.error.code === 'rate_limited' && retry) {
      const data = response.error.data || {};
      const delay = Math.min(Number(data.retry_after_ms) || 200, 2000);
      await new Promise((r) => setTimeout(r, delay));
      return this.call(method, params, { retry: false });
    }
    return response;
  }
}

module.exports = { CmuxSocket };
