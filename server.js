// Whale Terminal collector: работает 24/7, копит сделки, пока страница закрыта.
// Нужен Node 22.13+ (node:sqlite без флага). Зависимостей нет.
//   node --no-warnings server.js
// ENV: PORT=8080  DB=./data.db  TOP=60  COINS=BTC,ETH,ZEC  MIN_BIG=10000
//      KEEP_CANDLES_H=48  KEEP_TRADES_H=72
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';

const PORT = +process.env.PORT || 8080;
const MIN_BIG = +process.env.MIN_BIG || 10000;          // сохраняем сделки от этой суммы, $
const KEEP_CANDLES_MS = (+process.env.KEEP_CANDLES_H || 48) * 3600e3;
const KEEP_TRADES_MS = (+process.env.KEEP_TRADES_H || 72) * 3600e3;
const HL = 'https://api.hyperliquid.xyz/info';

const db = new DatabaseSync(process.env.DB || './data.db');
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS candles1s(coin TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY(coin,t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS big(id TEXT PRIMARY KEY, coin TEXT, ts INTEGER, side TEXT, usd REAL, px REAL, sz REAL, buyer TEXT, seller TEXT, ex TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS big_coin_ts ON big(coin, ts);
`);
const upCandle = db.prepare(`INSERT INTO candles1s VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(coin,t) DO UPDATE SET h=max(h,excluded.h), l=min(l,excluded.l), c=excluded.c, v=v+excluded.v`);
const insBig = db.prepare(`INSERT OR IGNORE INTO big VALUES(?,?,?,?,?,?,?,?,?,?)`);

// имена монет как на бирже (kPEPE, kBONK — со строчной k), ключ — в нижнем регистре
const known = new Map();
const resolveCoin = s => { s = String(s); return known.get(s.toLowerCase()) ?? (/[a-z]/.test(s) && /[A-Z]/.test(s) ? s : s.toUpperCase()); };

// ---- приём сделки (один вход для любой биржи) ----
const cur = new Map();   // coin -> {t,o,h,l,c,v} текущая секунда в памяти
const dirty = new Map(); // `${coin}:${t}` -> готовая секундная свеча, ждёт записи
function addDirty(coin, k) { // сливаем, а не затираем (при сделках не по порядку времени)
  const key = coin + ':' + k.t, d = dirty.get(key);
  if (!d) return void dirty.set(key, { coin, ...k });
  d.h = Math.max(d.h, k.h); d.l = Math.min(d.l, k.l); d.c = k.c; d.v += k.v;
}
function ingest(tr) { // {id,coin,ts(ms),side:'buy'|'sell',px,sz,buyer?,seller?,ex}
  const usd = tr.px * tr.sz;
  if (tr.ex === 'hyperliquid') { // свечи строим из основного потока
    const t = Math.floor(tr.ts / 1000);
    let k = cur.get(tr.coin);
    if (!k || k.t !== t) {
      if (k) addDirty(tr.coin, k);
      k = { t, o: tr.px, h: tr.px, l: tr.px, c: tr.px, v: 0 };
      cur.set(tr.coin, k);
    }
    k.h = Math.max(k.h, tr.px); k.l = Math.min(k.l, tr.px); k.c = tr.px; k.v += tr.sz; // объём в монетах, как на странице
  }
  if (usd >= MIN_BIG) insBig.run(`${tr.ex}:${tr.coin}:${tr.id}`, tr.coin, tr.ts, tr.side, usd, tr.px, tr.sz, tr.buyer || null, tr.seller || null, tr.ex);
}
function flush(force = false) {
  const now = Math.floor(Date.now() / 1000);
  for (const [coin, k] of cur) if (force === true || k.t < now) { addDirty(coin, k); cur.delete(coin); }
  if (!dirty.size) return;
  db.exec('BEGIN');
  try { for (const d of dirty.values()) upCandle.run(d.coin, d.t, d.o, d.h, d.l, d.c, d.v); db.exec('COMMIT'); dirty.clear(); }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('flush', e.message); } // dirty остаётся — повторим
}
setInterval(() => flush(), 1000);
setInterval(() => {
  try {
    db.prepare('DELETE FROM candles1s WHERE t < ?').run(Math.floor((Date.now() - KEEP_CANDLES_MS) / 1000));
    db.prepare('DELETE FROM big WHERE ts < ?').run(Date.now() - KEEP_TRADES_MS);
  } catch (e) { console.error('cleanup', e.message); }
}, 10 * 60e3);
// при остановке/рестарте контейнера сохраняем то, что в памяти
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { flush(true); } catch {} process.exit(0); });

// ---- Hyperliquid WebSocket ----
async function pickCoins() {
  if (process.env.COINS) return process.env.COINS.split(',').map(s => s.trim()).filter(Boolean);
  const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
  const [meta, ctx] = await r.json();
  return meta.universe.map((u, i) => ({ n: u.name, v: +ctx[i]?.dayNtlVlm || 0, d: u.isDelisted }))
    .filter(x => !x.d).sort((a, b) => b.v - a.v).slice(0, +process.env.TOP || 60).map(x => x.n);
}
let lastMsg = Date.now(), retry = 0, subscribed = 0;
async function connectHL() {
  let coins;
  try { coins = await pickCoins(); } catch (e) { console.error('coins', e.message); return setTimeout(connectHL, 5000); }
  for (const c of coins) known.set(c.toLowerCase(), c);
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  let ping;
  ws.onopen = () => {
    retry = 0; lastMsg = Date.now(); subscribed = coins.length;
    for (const coin of coins) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ method: 'ping' })), 30000);
    console.log('HL connected,', coins.length, 'coins');
  };
  ws.onmessage = ev => {
    lastMsg = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.channel !== 'trades') return;
    for (const t of m.data) {
      try {
        ingest({
          id: t.tid ?? t.hash, coin: t.coin, ts: t.time, side: t.side === 'B' ? 'buy' : 'sell',
          px: +t.px, sz: +t.sz, buyer: t.users?.[0], seller: t.users?.[1], ex: 'hyperliquid',
        });
      } catch (e) { console.error('ingest', e.message); }
    }
  };
  const dog = setInterval(() => { if (Date.now() - lastMsg > 60000) { try { ws.close(); } catch {} } }, 10000);
  ws.onclose = () => { clearInterval(ping); clearInterval(dog); subscribed = 0; setTimeout(connectHL, Math.min(30000, 1000 * 2 ** retry++)); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---- HTTP API ----
const WIN = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '24h': 86400 };
const q = (u, k, d) => u.searchParams.get(k) ?? d;
const num = (u, k, d) => { const v = +q(u, k, d); return Number.isFinite(v) ? v : d; };
function route(u) {
  const coin = resolveCoin(q(u, 'coin', ''));
  if (u.pathname === '/health') return { ok: true, subscribed, lastMsgAgoS: (Date.now() - lastMsg) / 1000 | 0, uptime: process.uptime() | 0 };
  if (u.pathname === '/candles') { // ?coin=ZEC&tf=1|15&limit=900 -> t в секундах
    const tf = Math.max(1, Math.floor(num(u, 'tf', 1))), limit = Math.min(5000, Math.max(1, Math.floor(num(u, 'limit', 900))));
    const from = Math.floor(Date.now() / 1000 / tf) * tf - (limit - 1) * tf;
    const all = db.prepare(`SELECT t,o,h,l,c,v FROM candles1s WHERE coin=? AND t>=? ORDER BY t`).all(coin, from);
    const out = new Map();
    for (const x of all) {
      const b = Math.floor(x.t / tf) * tf, k = out.get(b);
      if (!k) out.set(b, { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
      else { k.h = Math.max(k.h, x.h); k.l = Math.min(k.l, x.l); k.c = x.c; k.v += x.v; }
    }
    return [...out.values()];
  }
  if (u.pathname === '/bigtrades') { // ?coin=ZEC&min=10000&limit=200&ex=hyperliquid
    const ex = q(u, 'ex', '');
    return db.prepare(`SELECT ts,side,usd,px,sz,buyer,seller,ex FROM big WHERE coin=? AND usd>=? AND (?='' OR ex=?) ORDER BY ts DESC LIMIT ?`)
      .all(coin, num(u, 'min', MIN_BIG), ex, ex, Math.min(1000, Math.max(1, Math.floor(num(u, 'limit', 200)))));
  }
  if (u.pathname === '/whales') { // ?coin=ZEC&window=15m&min=100000
    const w = WIN[q(u, 'window', '15m')] || 900, min = num(u, 'min', 100000), since = Date.now() - w * 1000;
    const s = db.prepare(`SELECT side, COUNT(*) n, SUM(usd) usd FROM big WHERE coin=? AND ts>=? AND usd>=? GROUP BY side`).all(coin, since, min);
    const g = side => s.find(x => x.side === side) || { n: 0, usd: 0 };
    const top = (col) => db.prepare(`SELECT ${col} addr, SUM(usd) usd, COUNT(*) n FROM big WHERE coin=? AND ts>=? AND usd>=? AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY usd DESC LIMIT 5`).all(coin, since, min);
    return { coin, window: WIN[q(u, 'window', '15m')] ? q(u, 'window', '15m') : '15m', min, buy: g('buy'), sell: g('sell'), net: g('buy').usd - g('sell').usd, topBuyers: top('buyer'), topSellers: top('seller') };
  }
  return null;
}
http.createServer((req, res) => {
  const h = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...h, 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': '*' }); return res.end(); }
  try {
    const out = route(new URL(req.url, 'http://x'));
    res.writeHead(out === null ? 404 : 200, h); res.end(JSON.stringify(out ?? { error: 'not found' }));
  } catch (e) { res.writeHead(500, h); res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, () => console.log('API on :' + PORT));

if (!process.env.NO_FEED) connectHL();
export { ingest, flush };
