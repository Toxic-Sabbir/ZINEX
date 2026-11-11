'use strict';

/*
 * Local mock backend for the Coco AI clone.
 *
 * The mirrored frontend talks to three external services at runtime:
 *   1. Firebase Auth REST  (identitytoolkit / securetoken)  -> registration + login
 *   2. Firebase Realtime Database (WebSocket protocol)      -> user profile + usage
 *   3. The Next.js server routes (/api/analyze, /api/signals/*, /api/news)
 *
 * This server reimplements all three in-process so the clone is fully
 * self-contained: any dummy email/password registers and signs in, and the
 * internal interfaces load real (locally generated) data.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 12000;
const ROOT = path.resolve(__dirname, '..');
const PROJECT_ID = 'coco-ai-c363d';
// Tier granted to local accounts. Defaults to "free" so the mirror behaves
// exactly like the real site: a fresh account gets plan:"free" (quota 0) and
// every generation tool is locked. Set COCO_TIER to another tier only if you
// deliberately want to unlock the tools for local testing.
const LOCAL_TIER = process.env.COCO_TIER || 'free';

/* ------------------------------------------------------------------ */
/* Tiny in-memory Realtime Database                                    */
/* ------------------------------------------------------------------ */

const db = Object.create(null);

function pathParts(p) {
  return String(p || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

function readPath(p) {
  let node = db;
  for (const key of pathParts(p)) {
    if (node === null || typeof node !== 'object' || !(key in node)) return null;
    node = node[key];
  }
  return node === undefined ? null : node;
}

function writePath(p, value) {
  const parts = pathParts(p);
  if (parts.length === 0) {
    for (const k of Object.keys(db)) delete db[k];
    if (value && typeof value === 'object') Object.assign(db, clone(value));
    return;
  }
  let node = db;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (node[key] === null || typeof node[key] !== 'object') node[key] = Object.create(null);
    node = node[key];
  }
  const last = parts[parts.length - 1];
  if (value === null) delete node[last];
  else node[last] = clone(value);
}

function mergePath(p, value) {
  const parts = pathParts(p);
  if (parts.length === 0) {
    mergeInto(db, value);
    return;
  }
  const current = readPath(p);
  const merged = mergeInto(
    current && typeof current === 'object' ? clone(current) : Object.create(null),
    value
  );
  writePath(p, merged);
}

function mergeInto(target, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return clone(value);
  for (const [k, v] of Object.entries(value)) {
    if (v === null) delete target[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      target[k] = mergeInto(target[k], v);
    } else {
      target[k] = clone(v);
    }
  }
  return target;
}

function clone(v) {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function isPrefix(a, b) {
  // true when path a is an ancestor-or-equal of path b
  const pa = pathParts(a);
  const pb = pathParts(b);
  if (pa.length > pb.length) return false;
  return pa.every((seg, i) => seg === pb[i]);
}

// The mirrored client always writes plan:"free" for a new account. Upgrade the
// stored profile so the local tier grants access to the internal tools.
function applyLocalTier(p, value) {
  if (LOCAL_TIER === 'free' || !value || typeof value !== 'object') return value;
  if (!/^users\/[^/]+$/.test(pathParts(p).join('/'))) return value;
  if (!('plan' in value)) return value;
  return { ...value, plan: LOCAL_TIER };
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeToken(uid) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: uid,
    user_id: uid,
    firebase: { identities: {}, sign_in_provider: 'password' },
  };
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}

function decodeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Firebase Auth REST emulation                                        */
/* ------------------------------------------------------------------ */

const accounts = new Map(); // email(lower) -> { localId, email, password, displayName }

function authError(res, code, message) {
  sendJson(res, 400, { error: { code: 400, message: code, errors: [{ message: code, domain: 'global', reason: message || code }] } });
}

function signUp(body) {
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const key = email.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'INVALID_EMAIL' };
  if (password.length < 6) return { error: 'WEAK_PASSWORD' };
  if (accounts.has(key)) return { error: 'EMAIL_EXISTS' };
  const localId = 'u' + crypto.randomBytes(12).toString('hex');
  accounts.set(key, { localId, email, password, displayName: '' });
  return { localId, email, idToken: makeToken(localId), refreshToken: 'rt-' + crypto.randomBytes(16).toString('hex'), expiresIn: '3600' };
}

function signIn(body) {
  const key = String(body.email || '').trim().toLowerCase();
  const account = accounts.get(key);
  if (!account || account.password !== String(body.password || '')) return { error: 'INVALID_LOGIN_CREDENTIALS' };
  return { localId: account.localId, email: account.email, displayName: account.displayName, idToken: makeToken(account.localId), refreshToken: 'rt-' + crypto.randomBytes(16).toString('hex'), expiresIn: '3600', registered: true };
}

/* ------------------------------------------------------------------ */
/* App data generation                                                 */
/* ------------------------------------------------------------------ */

const MARKETS = [
  { id: 'm1', base: 'EUR', quote: 'USD', type: 'real' },
  { id: 'm2', base: 'GBP', quote: 'USD', type: 'real' },
  { id: 'm3', base: 'USD', quote: 'JPY', type: 'real' },
  { id: 'm4', base: 'AUD', quote: 'CAD', type: 'real' },
  { id: 'm5', base: 'USD', quote: 'BRL', type: 'otc' },
  { id: 'm6', base: 'EUR', quote: 'JPY', type: 'otc' },
  { id: 'm7', base: 'NZD', quote: 'USD', type: 'otc' },
  { id: 'm8', base: 'USD', quote: 'ARS', type: 'otc' },
];

function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateCandles(pair, count, seed) {
  const rnd = seeded(seed || Math.floor(Date.now() / 60000));
  let price = 1 + rnd();
  const candles = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i--) {
    const open = price;
    const drift = (rnd() - 0.48) * 0.004;
    const close = Math.max(0.0001, open * (1 + drift));
    const high = Math.max(open, close) * (1 + rnd() * 0.0015);
    const low = Math.min(open, close) * (1 - rnd() * 0.0015);
    const t = new Date(now - i * 60000);
    candles.push({
      date: t.toISOString().slice(0, 10),
      time: t.toISOString().slice(11, 16),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
    });
    price = close;
  }
  return candles;
}

function buildAnalysis(mode) {
  const otc = mode === 'otc';
  const pair = otc ? 'USD/BRL (OTC)' : 'EUR/USD';
  const signal = otc ? 'UP' : 'DOWN';
  return {
    validation: { isValidChart: true, isOtc: otc },
    description: {
      pair,
      timeframe: '1 Min',
      trend: otc ? 'Bullish' : 'Bearish',
      candlePattern: otc ? 'Bullish Engulfing' : 'Bearish Engulfing',
      marketStructure: otc
        ? 'Higher lows into a compressed range with an OTC wick sweep below the prior session low.'
        : 'Lower highs beneath the session VWAP with a failed reclaim of the prior close.',
      indicatorsRead: 'RSI diverging from price, MACD histogram flattening, momentum still committed to the dominant side.',
    },
    analysis: {
      signal,
      confidence: otc ? 88 : 84,
      option: otc ? 'CALL' : 'PUT',
      support: otc ? '5.4210' : '1.0842',
      resistance: otc ? '5.4690' : '1.0910',
      probabilityScores: { continuation: 0.72, reversal: 0.28 },
      logic: otc
        ? 'Reverse-logic read: the OTC feed swept liquidity under support and reclaimed it on the close, favouring an upside continuation for the next candle.'
        : 'Structure read: price rejected resistance on declining volume; a downside continuation is favoured until the range is reclaimed.',
    },
  };
}

const NEWS_TEMPLATES = [
  { title: 'Non-Farm Payrolls', currency: 'USD', country: 'US', impact: 'high' },
  { title: 'CPI y/y', currency: 'GBP', country: 'GB', impact: 'high' },
  { title: 'ECB Interest Rate Decision', currency: 'EUR', country: 'EU', impact: 'high' },
  { title: 'Retail Sales m/m', currency: 'CAD', country: 'CA', impact: 'medium' },
  { title: 'Trade Balance', currency: 'JPY', country: 'JP', impact: 'medium' },
  { title: 'RBA Rate Statement', currency: 'AUD', country: 'AU', impact: 'high' },
  { title: 'Unemployment Claims', currency: 'USD', country: 'US', impact: 'low' },
  { title: 'Bank Holiday', currency: 'NZD', country: 'NZ', impact: 'holiday' },
];

function buildNews() {
  const now = new Date();
  const events = NEWS_TEMPLATES.map((tpl, i) => {
    const d = new Date(now);
    d.setHours(now.getHours() + i - 2, (i * 7) % 60, 0, 0);
    const dir = i % 3 === 0 ? 'UP' : i % 3 === 1 ? 'DOWN' : 'flat';
    return {
      ...tpl,
      date: d.toISOString(),
      time: d.toISOString(),
      forecast: (0.1 + i * 0.05).toFixed(2) + '%',
      previous: (0.05 + i * 0.04).toFixed(2) + '%',
      actual: i % 2 === 0 ? (0.12 + i * 0.03).toFixed(2) + '%' : '',
      direction: dir,
    };
  });
  return { updatedAt: Date.now(), events };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const SHIM = fs.readFileSync(path.join(__dirname, 'firebase-local.js'), 'utf8');

function serveHtml(res, abs, stat) {
  let html = fs.readFileSync(abs, 'utf8');
  const tag = `<script>${SHIM}</script>`;
  html = html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
  const body = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const candidates = [rel, rel + '/index.html', rel + '.html'];
  for (const cand of candidates) {
    const abs = path.normalize(path.join(ROOT, cand));
    if (!abs.startsWith(ROOT)) break;
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        if (path.extname(abs).toLowerCase() === '.html') {
          serveHtml(res, abs, stat);
        } else {
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
          });
          fs.createReadStream(abs).pipe(res);
        }
        return true;
      }
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Request routing                                                     */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (process.env.DEBUG_REQ) console.log(`[http] ${req.method} ${pathname}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    return res.end();
  }

  // Firebase Auth REST
  if (pathname === '/v1/accounts:signUp') {
    const out = signUp(await readBody(req));
    return out.error ? authError(res, out.error, out.error) : sendJson(res, 200, { kind: 'identitytoolkit#SignupNewUserResponse', ...out });
  }
  if (pathname === '/v1/accounts:signInWithPassword') {
    const out = signIn(await readBody(req));
    return out.error ? authError(res, out.error, out.error) : sendJson(res, 200, { kind: 'identitytoolkit#VerifyPasswordResponse', ...out });
  }
  if (pathname === '/v1/accounts:update') {
    const body = await readBody(req);
    const claims = decodeToken(body.idToken);
    const account = claims && accounts.get(claims.sub) ? accounts.get(claims.sub) : [...accounts.values()].find((a) => a.localId === (claims && claims.sub));
    if (!account) return authError(res, 'USER_NOT_FOUND', 'USER_NOT_FOUND');
    if (typeof body.displayName === 'string') account.displayName = body.displayName;
    return sendJson(res, 200, { kind: 'identitytoolkit#SetAccountInfoResponse', localId: account.localId, email: account.email, displayName: account.displayName, idToken: body.idToken, expiresIn: '3600' });
  }
  if (pathname === '/v1/accounts:lookup') {
    const body = await readBody(req);
    const claims = decodeToken(body.idToken);
    const account = claims && [...accounts.values()].find((a) => a.localId === claims.sub);
    return sendJson(res, 200, { kind: 'identitytoolkit#GetAccountInfoResponse', users: account ? [{ localId: account.localId, email: account.email, displayName: account.displayName }] : [] });
  }
  if (pathname === '/v1/token' || pathname === '/v1/accounts:signInWithCustomToken') {
    const body = await readBody(req);
    const refresh = body.refresh_token || body.token || '';
    const account = [...accounts.values()].find((a) => refresh.includes(a.localId)) || [...accounts.values()][0];
    const uid = account ? account.localId : 'u' + crypto.randomBytes(8).toString('hex');
    return sendJson(res, 200, { access_token: makeToken(uid), expires_in: '3600', token_type: 'Bearer', refresh_token: body.refresh_token || 'rt-' + crypto.randomBytes(16).toString('hex'), user_id: uid, id_token: makeToken(uid), project_id: PROJECT_ID });
  }

  // App APIs
  if (pathname === '/api/analyze' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.image) return sendJson(res, 400, { error: 'No image supplied.' });
    return sendJson(res, 200, buildAnalysis(body.mode === 'otc' ? 'otc' : 'real'));
  }
  if (pathname === '/api/signals/future' && req.method === 'POST') {
    const body = await readBody(req);
    const count = Math.max(1, Math.min(20, Number(body.count) || 5));
    const pairs = Array.isArray(body.pairs) && body.pairs.length ? body.pairs : ['EURUSD', 'GBPUSD_otc'];
    const picks = Array.from({ length: count }, (_, i) => ({
      pair: pairs[i % pairs.length],
      direction: i % 2 === 0 ? 'UP' : 'DOWN',
      offsetMin: 3 + (i % 3),
    }));
    return sendJson(res, 200, { picks });
  }
  if (pathname === '/api/signals/injector' && req.method === 'POST') {
    const body = await readBody(req);
    const candles = generateCandles(body.pair || 'EURUSD', 40, Math.floor(Date.now() / 60000));
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    return sendJson(res, 200, { direction: last.close >= prev.close ? 'UP' : 'DOWN', candles });
  }
  if (pathname === '/api/signals/live' && req.method === 'POST') {
    const body = await readBody(req);
    const seed = seeded(Math.floor(Date.now() / 60000));
    return sendJson(res, 200, { direction: seed() > 0.5 ? 'UP' : 'DOWN' });
  }
  if (pathname === '/api/news' && req.method === 'GET') {
    return sendJson(res, 200, buildNews());
  }

  // Realtime Database REST (handy for debugging)
  if (pathname.endsWith('.json')) {
    const dbPath = pathname.slice(0, -'.json'.length);
    if (req.method === 'GET') return sendJson(res, 200, readPath(dbPath));
    if (req.method === 'PUT') return (writePath(dbPath, await readBody(req)), sendJson(res, 200, readPath(dbPath)));
    if (req.method === 'PATCH') return (mergePath(dbPath, await readBody(req)), sendJson(res, 200, readPath(dbPath)));
    if (req.method === 'DELETE') return (writePath(dbPath, null), sendJson(res, 200, null));
  }

  if (serveStatic(req, res, pathname)) return;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>404</title><h1>404 - Not found</h1>');
});

/* ------------------------------------------------------------------ */
/* Realtime Database WebSocket protocol                                */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  if (process.env.DEBUG_REQ) console.log(`[ws-upgrade] ${req.url}`);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const state = { ws, listens: new Map(), reqNo: 0 };
  clients.add(state);
  if (process.env.DEBUG_REQ) console.log(`[ws-open] ${req.url}`);

  const host = req.headers.host || `localhost:${PORT}`;
  const sessionId = crypto.randomBytes(8).toString('hex');

  ws.send(JSON.stringify({ t: 'c', d: { t: 'h', d: { ts: Date.now(), v: '5', h: host, s: sessionId } } }));

  ws.on('message', (raw) => {
    if (process.env.DEBUG_FRAMES) console.log('[ws<-]', raw.toString().slice(0, 400));
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (frame.t === 'c') return; // control (ping/pong/ack)
    if (frame.t !== 'd') return;
    if (process.env.DEBUG_FRAMES) console.log('[ws<-]', JSON.stringify(frame).slice(0, 400));

    const req = frame.d || {};
    const r = req.r;
    const action = req.a;
    const body = req.b || {};

    const reply = (b) => ws.send(JSON.stringify({ t: 'd', d: { r, b } }));

    switch (action) {
      case 'auth':
        reply({ s: 'ok', d: { auth: decodeToken(body.cred) ? { user_id: decodeToken(body.cred).sub } : null, expires: Date.now() + 3600_000 } });
        break;
      case 'unauth':
        reply({ s: 'ok', d: '' });
        break;
      case 'g': {
        reply({ s: 'ok', d: readPath(body.p) });
        break;
      }
      case 'q': {
        const key = `${body.p}|${body.t ?? ''}`;
        state.listens.set(key, { path: body.p, tag: body.t });
        reply({ s: 'ok', d: readPath(body.p) });
        pushListen(state, body.p);
        break;
      }
      case 'n':
        state.listens.clear();
        break;
      case 'p':
        writePath(body.p, applyLocalTier(body.p, body.d));
        reply({ s: 'ok', d: '' });
        broadcast(body.p);
        break;
      case 'm':
        mergePath(body.p, applyLocalTier(body.p, body.d));
        reply({ s: 'ok', d: '' });
        broadcast(body.p);
        break;
      case 'o': // onDisconnect - acknowledged, no-op locally
        reply({ s: 'ok', d: '' });
        break;
      case 's': // stats
        reply({ s: 'ok', d: '' });
        break;
      default:
        reply({ s: 'ok', d: '' });
    }
  });

  ws.on('close', () => clients.delete(state));
  ws.on('error', () => clients.delete(state));
});

function pushListen(state, changedPath) {
  for (const listen of state.listens.values()) {
    if (isPrefix(listen.path, changedPath) || isPrefix(changedPath, listen.path)) {
      const msg = { a: 'd', b: { p: listen.path, d: readPath(listen.path) } };
      if (listen.tag !== undefined) msg.b.t = listen.tag;
      state.ws.send(JSON.stringify({ t: 'd', d: msg }));
    }
  }
}

function broadcast(changedPath) {
  for (const state of clients) pushListen(state, changedPath);
}

server.listen(PORT, () => {
  console.log(`[coco-mock] listening on http://localhost:${PORT}`);
  console.log(`[coco-mock] serving static site from ${ROOT}`);
});
