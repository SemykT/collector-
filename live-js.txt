// live.js: реальная торговля на сервере (VPS).
// Робот следит за кошельками китов и открывает/закрывает сделки на счёте пользователя,
// даже когда страница закрыта. Логика та же, что у робота на странице (index.html).
//
// Безопасность:
//  - ключ API-кошелька Hyperliquid (он торгует, но не может выводить деньги) приходит в браузере,
//    зашифрованный открытым ключом этого сервера (RSA-OAEP), и лежит в базе только в зашифрованном
//    виде (AES-256-GCM). Мастер-ключ и приватный RSA-ключ лежат в файлах рядом с базой (chmod 600).
//  - ключ никогда не отдаётся обратно и не пишется в логи.
//  - mainnet включается только переменной LIVE_MAINNET=1; аварийная остановка: файл LIVE_STOP рядом с базой.
//
// ENV (всё необязательно):
//   LIVE=0              выключить модуль целиком
//   LIVE_MAINNET=1      разрешить реальную сеть (без этого работает только testnet)
//   LIVE_MAX_LEV=20     максимальное плечо;   LIVE_MAX_PER=5000 максимальная маржа на сделку, $
//   LIVE_POLL_MS=20000  период опроса китов;  LIVE_REQ_MS=200 пауза между запросами к бирже
//   SITE_URL=https://semykt.vercel.app   откуда проверять вход пользователя
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, d) => Number.isFinite(+v) ? +v : d;
const sh = a => a.slice(0, 6) + '…' + a.slice(-4);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const API = { main: 'https://api.hyperliquid.xyz', test: 'https://api.hyperliquid-testnet.xyz' };

// ---- msgpack для подписи действий (как на странице; числа до 2^64) ----
function mp(v) {
  const o = [];
  (function w(v) {
    if (typeof v === 'boolean') o.push(v ? 0xc3 : 0xc2);
    else if (typeof v === 'number') {
      if (v < 128) o.push(v);
      else if (v < 256) o.push(0xcc, v);
      else if (v < 65536) o.push(0xcd, v >> 8, v & 255);
      else if (v < 4294967296) o.push(0xce, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      else { let b = BigInt(v); const t = []; for (let i = 0; i < 8; i++) { t.unshift(Number(b & 255n)); b >>= 8n; } o.push(0xcf, ...t); }
    } else if (typeof v === 'string') { const b = new TextEncoder().encode(v); if (b.length < 32) o.push(0xa0 | b.length); else o.push(0xd9, b.length); b.forEach(x => o.push(x)); }
    else if (Array.isArray(v)) { o.push(0x90 | v.length); v.forEach(w); }
    else { const k = Object.keys(v); o.push(0x80 | k.length); k.forEach(x => { w(x); w(v[x]); }); }
  })(v);
  return o;
}
const fx = (n, d) => { let t = n.toFixed(d); if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, ''); return t; };
const p5 = (p, d) => fx(Number(p.toPrecision(5)), Math.max(0, 6 - d));
const stat = (r, n) => {
  const x = r && r.response && r.response.data && r.response.data.statuses && r.response.data.statuses[n || 0];
  if (!x || x.error) throw new Error((x && x.error) || JSON.stringify(r).slice(0, 140));
  return x;
};

export async function initLive({ db, env = process.env, dbPath, ethersLib, log = console.log }) {
  let ethers = ethersLib || null;
  if (!ethers) { try { ({ ethers } = await import('ethers')); } catch {} }
  const ON = !!ethers && env.LIVE !== '0';
  const MAINNET_OK = env.LIVE_MAINNET === '1';
  const MAX_LEV = +env.LIVE_MAX_LEV || 20;
  const MAX_PER = +env.LIVE_MAX_PER || 5000;
  const POLL_MS = +env.LIVE_POLL_MS || 20000;
  const REQ_MS = env.LIVE_REQ_MS !== undefined ? +env.LIVE_REQ_MS : 200;
  const SITE = String(env.SITE_URL || 'https://semykt.vercel.app').replace(/\/+$/, '');
  const DIR = path.dirname(dbPath);
  const STOP_FILE = path.join(DIR, 'LIVE_STOP');
  const stopped = () => { try { return fs.existsSync(STOP_FILE); } catch { return false; } };
  const out = { enabled: ON };
  if (!ON) {
    log(!ethers ? 'live: библиотека ethers не установлена, реальная торговля выключена (npm install в папке приложения)' : 'live: выключено (LIVE=0)');
    out.handle = (req, res, h) => { send(res, h, 503, { error: 'Реальная торговля на сервере не включена', enabled: false }); return true; };
    return out;
  }

  // ---- ключи шифрования ----
  const readOrMake = (file, make) => {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    const v = make(); fs.writeFileSync(file, v, { mode: 0o600 }); return v;
  };
  const MASTER = Buffer.from(readOrMake(path.join(DIR, 'live.key'), () => crypto.randomBytes(32).toString('hex')).trim(), 'hex');
  const RSA_PEM = readOrMake(path.join(DIR, 'live-rsa.pem'), () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey);
  const RSA_PRIV = crypto.createPrivateKey(RSA_PEM);
  const RSA_PUB = crypto.createPublicKey(RSA_PRIV).export({ type: 'spki', format: 'pem' });
  const enc = s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', MASTER, iv), ct = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); };
  const dec = b => { const x = Buffer.from(b, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', MASTER, x.subarray(0, 12)); d.setAuthTag(x.subarray(12, 28)); return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8'); };

  db.exec(`CREATE TABLE IF NOT EXISTS live_users(uid TEXT PRIMARY KEY, me TEXT, net TEXT, enc TEXT, agent TEXT, cfg TEXT, pos TEXT, lg TEXT, ts INTEGER) WITHOUT ROWID`);
  const upU = db.prepare('INSERT OR REPLACE INTO live_users VALUES(?,?,?,?,?,?,?,?,?)');
  const delU = db.prepare('DELETE FROM live_users WHERE uid=?');
  const USERS = new Map();
  const persist = U => upU.run(U.uid, U.me, U.cfg.net, U.enc, U.agent, JSON.stringify(U.cfg), JSON.stringify(U.pos), JSON.stringify(U.lg), Date.now());
  const lg = (U, s) => { U.lg.unshift({ t: Date.now(), s: String(s).slice(0, 240) }); U.lg = U.lg.slice(0, 100); try { persist(U); } catch {} };
  const enqueue = (U, fn) => { U.q = U.q.then(fn).catch(e => { try { lg(U, '✗ ' + (e && e.message || e)); } catch {} }); return U.q; };

  // ---- настройки: чистим всё, что пришло от страницы ----
  function cleanCfg(c) {
    c = c && typeof c === 'object' ? c : {};
    const o = { net: c.net === 'test' ? 'test' : 'main', me: ADDR.test(c.me || '') ? c.me.toLowerCase() : '', auto: !!c.auto, sl: clamp(numOr(c.sl, 15), 0, 99), slip: clamp(numOr(c.slip, 3), 0.1, 10), w: [] };
    for (const x of (Array.isArray(c.w) ? c.w : []).slice(0, 60)) {
      if (!x || !ADDR.test(x.a || '')) continue;
      o.w.push({
        a: x.a.toLowerCase(), n: String(x.n || '').slice(0, 40), on: !!x.on,
        dep: clamp(numOr(x.dep, 100), 1, 1e7), per: clamp(numOr(x.per, 20), 0, MAX_PER), lev: Math.round(clamp(numOr(x.lev, 3), 1, MAX_LEV)),
        max: Math.round(clamp(numOr(x.max, 3), 1, 20)), sl: x.sl == null ? null : clamp(numOr(x.sl, 0), 0, 99), tp: clamp(numOr(x.tp, 0), 0, 1000),
        minv: clamp(numOr(x.minv, 0), 0, 1e9), slip: x.slip == null ? null : clamp(numOr(x.slip, 3), 0.1, 10),
        long: x.long !== false, short: x.short !== false, coins: String(x.coins || '').slice(0, 300),
      });
    }
    return o;
  }

  // ---- биржа ----
  async function post(net, kind, body) {
    const r = await fetch(API[net] + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const info = (net, body) => post(net, 'info', body);
  async function sendAct(U, action) {
    const net = U.cfg.net, nonce = Math.max(Date.now(), (U.nonce || 0) + 1); U.nonce = nonce;
    const b = mp(action); for (let i = 7; i >= 0; i--) b.push(Math.floor(nonce / 2 ** (8 * i)) & 255); b.push(0);
    const cid = ethers.keccak256(new Uint8Array(b));
    const sig = ethers.Signature.from(await U.wallet.signTypedData({ name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ethers.ZeroAddress }, { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, { source: net === 'test' ? 'b' : 'a', connectionId: cid }));
    return post(net, 'exchange', { action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v } });
  }
  const META = {};
  async function mkt(net, coin) {
    if (!META[net] || Date.now() - META[net].t > 3600e3) META[net] = { t: Date.now(), u: (await info(net, { type: 'meta' })).universe };
    const i = META[net].u.findIndex(x => x.name === coin); if (i < 0) throw new Error('нет рынка ' + coin);
    return { i, d: META[net].u[i].szDecimals };
  }
  async function place(U, coin, buy, usd, reduce, lev, sz0, sp) {
    const net = U.cfg.net, { i, d } = await mkt(net, coin), mid = +(await info(net, { type: 'allMids' }))[coin];
    if (!mid) throw new Error('нет цены ' + coin);
    if (lev) { const lr = await sendAct(U, { type: 'updateLeverage', asset: i, isCross: true, leverage: lev }); if (!lr || lr.status !== 'ok') throw new Error('плечо: ' + JSON.stringify(lr).slice(0, 120)); }
    const slip = ((sp != null ? sp : U.cfg.slip) || 3) / 100, px = buy ? mid * (1 + slip) : mid * (1 - slip), f = 10 ** d;
    const sz = Math.floor((sz0 != null ? sz0 : usd / mid) * f) / f;
    if (sz <= 0 || (!reduce && sz * mid < 10.5)) throw new Error('размер меньше минимума биржи ($10)');
    const st = stat(await sendAct(U, { type: 'order', orders: [{ a: i, b: buy, p: p5(px, d), s: fx(sz, d), r: reduce, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' }));
    if (!st.filled) throw new Error('ордер не исполнился (нет ликвидности/проскальзывание)');
    return { sz: +st.filled.totalSz, px: +st.filled.avgPx, i, d };
  }
  async function trigger(U, o, buy, pct, kind) {
    const t = o.px * (buy ? (kind === 'sl' ? 1 - pct / 100 : 1 + pct / 100) : (kind === 'sl' ? 1 + pct / 100 : 1 - pct / 100)), lim = t * (buy ? 0.9 : 1.1);
    stat(await sendAct(U, { type: 'order', orders: [{ a: o.i, b: !buy, p: p5(lim, o.d), s: fx(o.sz, o.d), r: true, t: { trigger: { isMarket: true, triggerPx: p5(t, o.d), tpsl: kind } } }], grouping: 'na' }));
  }
  async function ours(U, coin) {
    const st = await info(U.cfg.net, { type: 'clearinghouseState', user: U.me });
    const p = (st.assetPositions || []).map(x => x.position).find(x => x.coin === coin && +x.szi);
    return p ? +p.szi : 0;
  }
  async function cancelTriggers(U, coin) { // после закрытия убираем остатки стопов/тейков этой монеты
    try {
      const net = U.cfg.net, oo = await info(net, { type: 'frontendOpenOrders', user: U.me });
      const ids = (Array.isArray(oo) ? oo : []).filter(o => o.coin === coin && o.isTrigger && o.oid);
      if (!ids.length) return;
      const { i } = await mkt(net, coin);
      await sendAct(U, { type: 'cancel', cancels: ids.map(o => ({ a: i, o: o.oid })) });
    } catch (e) { lg(U, '⚠ не удалось снять стопы ' + coin + ': ' + e.message); }
  }
  async function closeCoin(U, coin) {
    const z = await ours(U, coin); if (!z) return null;
    const r = await place(U, coin, z < 0, 0, true, 0, Math.abs(z));
    await cancelTriggers(U, coin);
    return r;
  }

  // ---- логика копирования (как act() на странице) ----
  const PV = new Map();
  async function act(U, w, coin, side) {
    if (!U.cfg.auto || U.bad || stopped() || coin.includes(':')) return;
    const nm = w.n || sh(w.a), ps = U.pos[coin];
    try {
      if (ps && ps.a === w.a && (!side || ps.side !== side)) { await closeCoin(U, coin); delete U.pos[coin]; lg(U, '✓ закрыл ' + coin + ' вслед за ' + nm); }
      if (!side) return;
      if (U.pos[coin]) return;
      if (Object.values(U.pos).filter(x => x.a === w.a).length >= w.max) { lg(U, 'пропуск ' + coin + ': лимит сделок кита ' + w.max); return; }
      if (await ours(U, coin)) { lg(U, 'пропуск ' + coin + ': у вас уже есть позиция'); return; }
      if (side === 'LONG' ? w.long === false : w.short === false) { lg(U, 'пропуск ' + coin + ': ' + side + ' отключён для ' + nm); return; }
      if (w.coins && !w.coins.toLowerCase().split(',').map(s => s.trim()).includes(coin.toLowerCase())) { lg(U, 'пропуск ' + coin + ': монеты нет в списке кита ' + nm); return; }
      if (w.minv > 0 && (PV.get(U.cfg.net + '|' + w.a + '|' + coin) || 0) < w.minv) { lg(U, 'пропуск ' + coin + ': позиция кита меньше $' + w.minv); return; }
      const per = Math.min(MAX_PER, w.per > 0 ? w.per : w.dep / Math.max(1, w.max)), used = Object.values(U.pos).filter(x => x.a === w.a).reduce((z, x) => z + (+x.margin || 0), 0);
      if (used + per > w.dep + 1e-6) { lg(U, 'пропуск ' + coin + ': депозит кита ' + nm + ' $' + w.dep + ' исчерпан'); return; }
      const buy = side === 'LONG', o = await place(U, coin, buy, per * w.lev, false, w.lev, null, w.slip);
      U.pos[coin] = { a: w.a, side, margin: o.sz * o.px / w.lev, t: Date.now() };
      lg(U, '✓ открыл ' + side + ' ' + coin + ' по ' + o.px + ' на ' + nm);
      const sl = w.sl != null ? w.sl : U.cfg.sl;
      if (sl > 0) { try { await trigger(U, o, buy, sl, 'sl'); } catch (e) { lg(U, '⚠ стоп-лосс ' + coin + ' не выставлен: ' + e.message); } }
      if (w.tp > 0) { try { await trigger(U, o, buy, w.tp, 'tp'); } catch (e) { lg(U, '⚠ тейк-профит ' + coin + ' не выставлен: ' + e.message); } }
    } catch (e) { lg(U, '✗ ' + coin + ': ' + e.message); }
  }

  // ---- опрос китов ----
  const PREV = new Map();
  async function pollWhales() {
    const watch = new Map();
    for (const U of USERS.values()) {
      if (!U.cfg.auto || U.bad) continue;
      for (const w of U.cfg.w) if (w.on) { const k = U.cfg.net + '|' + w.a; if (!watch.has(k)) watch.set(k, { net: U.cfg.net, a: w.a, f: [] }); watch.get(k).f.push([U, w]); }
    }
    for (const k of [...PREV.keys()]) if (!watch.has(k)) PREV.delete(k); // не следили, значит старый снимок устарел
    for (const [k, g] of watch) {
      try {
        const st = await info(g.net, { type: 'clearinghouseState', user: g.a }), cur = {};
        (st.assetPositions || []).forEach(p => { if (+p.position.szi) { cur[p.position.coin] = +p.position.szi > 0 ? 'LONG' : 'SHORT'; PV.set(g.net + '|' + g.a + '|' + p.position.coin, +p.position.positionValue || 0); } });
        const old = PREV.get(k); PREV.set(k, cur);
        if (old) {
          const ev = [];
          Object.keys(cur).forEach(c => { if (old[c] !== cur[c]) ev.push([c, cur[c]]); });
          Object.keys(old).forEach(c => { if (!cur[c]) ev.push([c, null]); });
          for (const [c, side] of ev) for (const [U, w] of g.f) {
            lg(U, (w.n || sh(w.a)) + ' ' + (side ? 'открыл ' + side : 'закрыл ' + old[c]) + ' ' + c);
            enqueue(U, () => act(U, w, c, side));
          }
        }
      } catch {}
      if (REQ_MS) await sleep(REQ_MS);
    }
  }
  // сделка пропала с биржи (стоп, тейк, ликвидация): снимаем её с нашего учёта
  async function reconcile(U) {
    if (!Object.keys(U.pos).length) return;
    try {
      const st = await info(U.cfg.net, { type: 'clearinghouseState', user: U.me });
      if (!st || !Array.isArray(st.assetPositions)) return;
      const have = new Set(st.assetPositions.map(x => x.position).filter(p => p && +p.szi).map(p => p.coin));
      let ch = false;
      for (const c of Object.keys(U.pos)) if (!have.has(c) && Date.now() - (U.pos[c].t || 0) > 15000) { delete U.pos[c]; ch = true; lg(U, 'позиция ' + c + ' закрыта на бирже'); }
      if (ch) persist(U);
    } catch {}
  }
  async function checkAgent(U) {
    try {
      const a = await info(U.cfg.net, { type: 'extraAgents', user: U.me });
      if (!(a || []).some(x => x.address.toLowerCase() === U.agent.toLowerCase())) { U.bad = true; U.cfg.auto = false; lg(U, '⚠ API-кошелёк больше не найден у вашего адреса: автоторговля выключена'); }
      else U.bad = false;
    } catch {}
  }
  let n = 0;
  async function loop() {
    for (;;) {
      const t0 = Date.now();
      try {
        if (!stopped()) {
          await pollWhales();
          n++;
          if (n % 3 === 0) for (const U of USERS.values()) await reconcile(U);
          if (n % 180 === 1) for (const U of USERS.values()) if (U.cfg.auto) await checkAgent(U);
        }
      } catch (e) { log('live', e.message); }
      await sleep(Math.max(1000, POLL_MS - (Date.now() - t0)));
    }
  }

  // ---- пользователи ----
  function mkUser(row, keyHex) {
    const U = { uid: row.uid, me: row.me, enc: row.enc, agent: '', cfg: cleanCfg(JSON.parse(row.cfg || '{}')), pos: JSON.parse(row.pos || '{}'), lg: JSON.parse(row.lg || '[]'), q: Promise.resolve(), bad: false, nonce: 0 };
    U.wallet = new ethers.Wallet('0x' + keyHex); U.agent = U.wallet.address;
    return U;
  }
  for (const row of db.prepare('SELECT * FROM live_users').all()) {
    try { USERS.set(row.uid, mkUser(row, dec(row.enc))); } catch (e) { log('live: не удалось загрузить пользователя ' + row.uid + ': ' + e.message); }
  }

  // ---- HTTP ----
  const TOK = new Map(), RL = new Map();
  async function whoami(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return null;
    const t = m[1], hit = TOK.get(t);
    if (hit && hit.exp > Date.now()) return hit.uid;
    const r = await fetch(SITE + '/api/me', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ action: 'get' }) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null), uid = j && j.user && j.user.id; if (!uid) return null;
    if (TOK.size > 2000) TOK.clear();
    TOK.set(t, { uid: String(uid), exp: Date.now() + 300e3 });
    return String(uid);
  }
  function limited(uid) {
    const now = Date.now(); let r = RL.get(uid);
    if (!r || r.t < now) { r = { t: now + 60e3, n: 0 }; RL.set(uid, r); }
    return ++r.n > 40;
  }
  function body(req) {
    return new Promise((ok, no) => {
      let s = ''; req.on('data', c => { s += c; if (s.length > 100000) { no(new Error('слишком большой запрос')); req.destroy(); } });
      req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('неверный JSON')); } });
      req.on('error', no);
    });
  }
  const view = U => ({
    enabled: true, mainnetAllowed: MAINNET_OK, paused: stopped(), hasKey: !!U, agent: U ? U.agent : '', me: U ? U.me : '', net: U ? U.cfg.net : '',
    auto: U ? U.cfg.auto && !U.bad : false, bad: U ? U.bad : false, maxLev: MAX_LEV, maxPer: MAX_PER,
    pos: U ? Object.fromEntries(Object.entries(U.pos).map(([c, p]) => [c, { a: p.a, side: p.side }])) : {}, log: U ? U.lg.slice(0, 40) : [],
  });
  async function panic(U) {
    U.cfg.auto = false; persist(U);
    const st = await info(U.cfg.net, { type: 'clearinghouseState', user: U.me });
    for (const p of (st.assetPositions || []).map(x => x.position).filter(x => x && +x.szi)) {
      try { await place(U, p.coin, +p.szi < 0, 0, true, 0, Math.abs(+p.szi)); await cancelTriggers(U, p.coin); lg(U, '✓ закрыл ' + p.coin); }
      catch (e) { lg(U, '✗ ' + p.coin + ': ' + e.message); }
    }
    U.pos = {}; persist(U);
  }
  out.handle = (req, res, h, url) => {
    (async () => {
      try {
        const p = url.pathname;
        if (p === '/live/pubkey' && req.method === 'GET') return send(res, h, 200, { pem: RSA_PUB, enabled: true, mainnetAllowed: MAINNET_OK });
        const uid = await whoami(req);
        if (!uid) return send(res, h, 401, { error: 'нужен вход на сайте' });
        if (limited(uid)) return send(res, h, 429, { error: 'слишком часто' });
        const U = USERS.get(uid);
        if (p === '/live/status' && req.method === 'GET') return send(res, h, 200, view(U));
        if (req.method !== 'POST') return send(res, h, 404, { error: 'not found' });
        const b = await body(req);
        if (p === '/live/key') {
          const net = b.net === 'test' ? 'test' : 'main', me = String(b.me || '').toLowerCase();
          if (!ADDR.test(me)) return send(res, h, 400, { error: 'неверный адрес основного кошелька' });
          if (net === 'main' && !MAINNET_OK) return send(res, h, 403, { error: 'Реальная сеть на сервере пока выключена администратором. Включите testnet для проверки.' });
          let hex; try { hex = crypto.privateDecrypt({ key: RSA_PRIV, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(String(b.k || ''), 'base64')).toString('utf8').trim().replace(/^0x/, ''); } catch { return send(res, h, 400, { error: 'не удалось расшифровать ключ, обновите страницу' }); }
          if (!/^[0-9a-fA-F]{64}$/.test(hex)) return send(res, h, 400, { error: 'нужен ключ из 64 hex-символов' });
          const w = new ethers.Wallet('0x' + hex);
          const ag = await info(net, { type: 'extraAgents', user: me }).catch(() => null);
          if (!(ag || []).some(x => x.address.toLowerCase() === w.address.toLowerCase())) return send(res, h, 400, { error: 'этот API-кошелёк не найден у адреса ' + sh(me) + ' в сети ' + (net === 'test' ? 'testnet' : 'mainnet') });
          const cfg = U ? U.cfg : cleanCfg({ net, me });
          cfg.net = net; cfg.me = me; if (U && (U.me !== me || U.agent.toLowerCase() !== w.address.toLowerCase())) cfg.auto = false;
          const row = { uid, me, enc: enc(hex), cfg: JSON.stringify(cfg), pos: JSON.stringify(U && U.me === me ? U.pos : {}), lg: JSON.stringify(U ? U.lg : []) };
          const NU = mkUser(row, hex); lg(NU, 'ключ API-кошелька ' + sh(w.address) + ' загружен на сервер');
          USERS.set(uid, NU);
          return send(res, h, 200, { ok: true, agent: w.address });
        }
        if (!U) return send(res, h, 400, { error: 'сначала загрузите ключ API-кошелька на сервер' });
        if (p === '/live/config') {
          const c = cleanCfg(b.cfg), warn = [];
          for (const x of (b.cfg && Array.isArray(b.cfg.w) ? b.cfg.w : [])) { if (x && (+x.lev > MAX_LEV || +x.per > MAX_PER)) { warn.push('Сервер ограничивает плечо до ' + MAX_LEV + 'x и маржу на сделку до $' + MAX_PER); break; } }
          if (c.me !== U.me || c.net !== U.cfg.net) return send(res, h, 409, { error: 'адрес или сеть не совпадают с загруженным ключом, загрузите ключ заново' });
          if (c.auto && c.net === 'main' && !MAINNET_OK) { c.auto = false; warn.push('Реальная сеть на сервере выключена администратором'); }
          if (c.auto && U.bad) { c.auto = false; warn.push('API-кошелёк не найден у вашего адреса'); }
          const was = U.cfg.auto; U.cfg = c;
          if (c.auto && !was) lg(U, 'автоторговля на сервере включена');
          if (!c.auto && was) lg(U, 'автоторговля на сервере выключена');
          persist(U);
          return send(res, h, 200, { ok: true, auto: c.auto, warn });
        }
        if (p === '/live/panic') { await enqueue(U, () => panic(U)); return send(res, h, 200, { ok: true }); }
        if (p === '/live/delete') {
          U.cfg.auto = false; USERS.delete(uid); delU.run(uid);
          return send(res, h, 200, { ok: true });
        }
        return send(res, h, 404, { error: 'not found' });
      } catch (e) { return send(res, h, 500, { error: String(e && e.message || e) }); }
    })();
    return true;
  };
  out.start = () => { loop(); log('live: включено' + (MAINNET_OK ? ' (mainnet разрешён)' : ' (только testnet)') + ', пользователей: ' + USERS.size); };
  out._t = { act, pollWhales, reconcile, cleanCfg, USERS, PREV, PV, place, closeCoin, panic, mp, sendAct, enc, dec };
  return out;
}

function send(res, h, code, obj) { res.writeHead(code, h); res.end(JSON.stringify(obj)); }
