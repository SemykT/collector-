// Whale Terminal collector v2: работает 24/7, копит данные, пока страница закрыта.
// Нужен Node 22.13+ (node:sqlite без флага). Зависимостей нет.
//   node --no-warnings server.js
// ENV (всё необязательно):
//   PORT=8080  DB=./data.db  TOP=60  COINS=BTC,ETH,ZEC
//   MIN_BIG=10000            сохраняем сделки от этой суммы, $ (10k/50k/100k/250k/1M — фильтры на странице)
//   KEEP_CANDLES_H=168       секундные свечи, часов
//   KEEP_1M_D=90             минутные свечи, дней (5m и старше хранятся без ограничений)
//   KEEP_TRADES_H=72         сделки < $100k, часов
//   KEEP_TRADES100_D=30      сделки $100k..$1M, дней
//   KEEP_TRADES1M_D=365      сделки от $1M, дней
//   BOOK_COINS=20            для скольких топ-монет писать стакан (0 = выкл)   BOOK=BTC,ETH — свой список
//   BOOK_SEC=10              период снимков стакана, сек
//   KEEP_BOOK_H=72           снимки стакана, часов;  KEEP_BOOKSTAT_D=14 — метрики стакана, дней
//   WHALE_MIN=100000         адрес считается китом, если у него были сделки от этой суммы за 24ч
//   WHALE_N=200              сколько китов опрашивать;  WHALE_POLL_MS=2000 — пауза между опросами
//   WHALE_POS_MIN=10000      позиции меньше этой суммы не храним
//   BACKFILL=0               отключить подгрузку истории свечей с биржи;  BF_DELAY_MS=3000
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';

const env = process.env;
const PORT = +env.PORT || 8080;
const MIN_BIG = +env.MIN_BIG || 10000;
const H = 3600e3, D = 24 * H;
const KEEP_1S = (+env.KEEP_CANDLES_H || 168) * H;
const KEEP_1M = (+env.KEEP_1M_D || 90) * D;
const KEEP_BIG = (+env.KEEP_TRADES_H || 72) * H;
const KEEP_BIG100 = (+env.KEEP_TRADES100_D || 30) * D;
const KEEP_BIG1M = (+env.KEEP_TRADES1M_D || 365) * D;
const KEEP_BOOK = (+env.KEEP_BOOK_H || 72) * H;
const KEEP_BOOKSTAT = (+env.KEEP_BOOKSTAT_D || 14) * D;
const BOOK_N = env.BOOK_COINS !== undefined ? +env.BOOK_COINS : 20;
const BOOK_SEC = +env.BOOK_SEC || 10;
const WHALE_MIN = +env.WHALE_MIN || 100000;
const WHALE_N = +env.WHALE_N || 200;
const WHALE_POLL_MS = +env.WHALE_POLL_MS || 2000;
const WHALE_POS_MIN = +env.WHALE_POS_MIN || 10000;
const BF_DELAY = +env.BF_DELAY_MS || 3000;
const HL = 'https://api.hyperliquid.xyz/info';
const DB_PATH = env.DB || './data.db';

// таймфреймы (сек), которые собираются и хранятся на сервере; 1s — отдельная таблица
const TFS = [60, 180, 300, 900, 1800, 3600, 14400, 86400];
const HLINT = { 60: '1m', 180: '3m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 14400: '4h', 86400: '1d' };
const TIERS = [10000, 50000, 100000, 250000, 1000000];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS candles1s(coin TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY(coin,t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candles(tf INTEGER, coin TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY(tf,coin,t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS big(id TEXT PRIMARY KEY, coin TEXT, ts INTEGER, side TEXT, usd REAL, px REAL, sz REAL, buyer TEXT, seller TEXT, ex TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS big_coin_ts ON big(coin, ts);
CREATE INDEX IF NOT EXISTS big_ts ON big(ts);
CREATE TABLE IF NOT EXISTS book(coin TEXT, ts INTEGER, bids TEXT, asks TEXT, PRIMARY KEY(coin,ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bookstat(coin TEXT, ts INTEGER, mid REAL, spr REAL, bid REAL, ask REAL, PRIMARY KEY(coin,ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS whalepos(addr TEXT, coin TEXT, ts INTEGER, szi REAL, entry REAL, val REAL, upnl REAL, liq REAL, lev REAL, PRIMARY KEY(addr,coin)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS whalepos_coin ON whalepos(coin);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
`);
const UPSERT = `ON CONFLICT DO UPDATE SET h=max(h,excluded.h), l=min(l,excluded.l), c=excluded.c, v=v+excluded.v`;
const upCandle = db.prepare(`INSERT INTO candles1s VALUES(?,?,?,?,?,?,?) ${UPSERT}`);
const upTf = db.prepare(`INSERT INTO candles VALUES(?,?,?,?,?,?,?,?) ${UPSERT}`);
const insBf = db.prepare(`INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?,?)`);
const insBig = db.prepare(`INSERT OR IGNORE INTO big VALUES(?,?,?,?,?,?,?,?,?,?)`);
const insBook = db.prepare(`INSERT OR REPLACE INTO book VALUES(?,?,?,?)`);
const insStat = db.prepare(`INSERT OR REPLACE INTO bookstat VALUES(?,?,?,?,?,?)`);
const delPos = db.prepare(`DELETE FROM whalepos WHERE addr=?`);
const insPos = db.prepare(`INSERT OR REPLACE INTO whalepos VALUES(?,?,?,?,?,?,?,?,?)`);

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
  // из секундных свечей сразу собираем все старшие таймфреймы (по одной записи на свечу за флаш)
  const agg = new Map();
  for (const d of dirty.values()) for (const tf of TFS) {
    const b = Math.floor(d.t / tf) * tf, key = tf + ':' + d.coin + ':' + b, a = agg.get(key);
    if (!a) agg.set(key, { tf, coin: d.coin, t: b, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
    else { a.h = Math.max(a.h, d.h); a.l = Math.min(a.l, d.l); a.c = d.c; a.v += d.v; }
  }
  db.exec('BEGIN');
  try {
    for (const d of dirty.values()) upCandle.run(d.coin, d.t, d.o, d.h, d.l, d.c, d.v);
    for (const a of agg.values()) upTf.run(a.tf, a.coin, a.t, a.o, a.h, a.l, a.c, a.v);
    db.exec('COMMIT'); dirty.clear();
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('flush', e.message); } // dirty остаётся — повторим
}
setInterval(() => flush(), 1000);

function cleanup() {
  const now = Date.now();
  try {
    db.prepare('DELETE FROM candles1s WHERE t < ?').run(Math.floor((now - KEEP_1S) / 1000));
    db.prepare('DELETE FROM candles WHERE tf=60 AND t < ?').run(Math.floor((now - KEEP_1M) / 1000));
    db.prepare('DELETE FROM big WHERE ts < ? AND usd < 100000').run(now - KEEP_BIG);
    db.prepare('DELETE FROM big WHERE ts < ? AND usd < 1000000').run(now - KEEP_BIG100);
    db.prepare('DELETE FROM big WHERE ts < ?').run(now - KEEP_BIG1M);
    db.prepare('DELETE FROM book WHERE ts < ?').run(now - KEEP_BOOK);
    db.prepare('DELETE FROM bookstat WHERE ts < ?').run(now - KEEP_BOOKSTAT);
    db.prepare('DELETE FROM whalepos WHERE ts < ?').run(now - 2 * D);
  } catch (e) { console.error('cleanup', e.message); }
}
setInterval(cleanup, 10 * 60e3);
setTimeout(cleanup, 30e3);
// при остановке/рестарте контейнера сохраняем то, что в памяти
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { flush(true); } catch {} process.exit(0); });

// ---- стакан: держим последний в памяти, раз в BOOK_SEC пишем снимок + метрики ----
const lastBook = new Map(); // coin -> {ts, bids:[[px,sz]], asks:[[px,sz]]}
let bookCoinsList = [];
const enc = L => L.map(([p, s]) => p + ':' + s).join('|');
const dec = s => s ? s.split('|').map(x => x.split(':').map(Number)) : [];
function snapBooks() {
  const now = Date.now(), step = BOOK_SEC * 1000, ts = Math.floor(now / step) * step;
  const rows = [];
  for (const [coin, b] of lastBook) if (now - b.ts < 30000 && b.bids.length && b.asks.length) rows.push([coin, b]);
  if (!rows.length) return;
  db.exec('BEGIN');
  try {
    for (const [coin, b] of rows) {
      insBook.run(coin, ts, enc(b.bids), enc(b.asks));
      const sum = L => L.reduce((a, [p, s]) => a + p * s, 0);
      const bb = b.bids[0][0], ba = b.asks[0][0], mid = (bb + ba) / 2;
      insStat.run(coin, ts, mid, (ba - bb) / mid * 1e4, sum(b.bids), sum(b.asks));
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('snapBooks', e.message); }
}
setInterval(snapBooks, BOOK_SEC * 1000);

// ---- Hyperliquid: REST helper, история свечей, позиции китов ----
async function hl(body) {
  const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// сколько свечей истории подгружать для каждого ТФ (вес запросов ограничен, поэтому не по максимуму)
const BF_N = { 60: 1440, 180: 960, 300: 1000, 900: 1000, 1800: 1000, 3600: 1000, 14400: 1000, 86400: 500 };
async function backfill(coins) { // один раз на монету: закрытые свечи берём у биржи, чтобы графики ТФ не были пустыми
  if (env.BACKFILL === '0') return;
  for (const coin of coins) {
    if (db.prepare('SELECT 1 FROM meta WHERE k=?').get('bf:' + coin)) continue;
    let ok = true;
    for (const tf of TFS) {
      const end = Math.floor(Date.now() / 1000 / tf) * tf * 1000 - 1; // только закрытые свечи
      const start = end - BF_N[tf] * tf * 1000;
      let r = null;
      for (let a = 0; a < 3 && !Array.isArray(r); a++) {
        try { r = await hl({ type: 'candleSnapshot', req: { coin, interval: HLINT[tf], startTime: start, endTime: end } }); }
        catch (e) { console.error('backfill', coin, HLINT[tf], e.message); await sleep(20000); }
      }
      if (!Array.isArray(r)) { ok = false; continue; }
      db.exec('BEGIN');
      try { for (const k of r) insBf.run(tf, coin, Math.floor(k.t / 1000), +k.o, +k.h, +k.l, +k.c, +k.v); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('backfill write', e.message); ok = false; }
      await sleep(BF_DELAY);
    }
    if (ok) db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('bf:' + coin, '1');
  }
  console.log('backfill done');
}

let wq = [];
async function fetchPositions(addr) {
  const s = await hl({ type: 'clearinghouseState', user: addr });
  const now = Date.now();
  db.exec('BEGIN');
  try {
    delPos.run(addr);
    for (const ap of s.assetPositions || []) {
      const p = ap.position; if (!p) continue;
      const szi = +p.szi, val = Math.abs(+p.positionValue);
      if (!szi || !(val >= WHALE_POS_MIN)) continue;
      insPos.run(addr, p.coin, now, szi, +p.entryPx, val, +p.unrealizedPnl, p.liquidationPx == null ? null : +p.liquidationPx, +(p.leverage?.value) || null);
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
async function whaleLoop() { // опрашиваем открытые позиции самых крупных адресов по кругу
  for (;;) {
    try {
      if (!wq.length) {
        const since = Date.now() - D;
        wq = db.prepare(`SELECT addr, SUM(usd) s FROM (
            SELECT buyer addr, usd FROM big WHERE ts>=? AND usd>=? AND buyer IS NOT NULL
            UNION ALL SELECT seller, usd FROM big WHERE ts>=? AND usd>=? AND seller IS NOT NULL)
          GROUP BY addr ORDER BY s DESC LIMIT ?`).all(since, WHALE_MIN, since, WHALE_MIN, WHALE_N).map(r => r.addr);
        if (!wq.length) { await sleep(30000); continue; }
      }
      await fetchPositions(wq.shift());
    } catch (e) { console.error('whale', e.message); await sleep(10000); }
    await sleep(WHALE_POLL_MS);
  }
}

// ---- Hyperliquid WebSocket ----
async function pickCoins() {
  if (env.COINS) return env.COINS.split(',').map(s => s.trim()).filter(Boolean);
  const [meta, ctx] = await hl({ type: 'metaAndAssetCtxs' });
  return meta.universe.map((u, i) => ({ n: u.name, v: +ctx[i]?.dayNtlVlm || 0, d: u.isDelisted }))
    .filter(x => !x.d).sort((a, b) => b.v - a.v).slice(0, +env.TOP || 60).map(x => x.n);
}
let lastMsg = Date.now(), retry = 0, subscribed = 0, bfStarted = false;
async function connectHL() {
  let coins;
  try { coins = await pickCoins(); } catch (e) { console.error('coins', e.message); return setTimeout(connectHL, 5000); }
  for (const c of coins) known.set(c.toLowerCase(), c);
  bookCoinsList = env.BOOK ? env.BOOK.split(',').map(s => resolveCoin(s.trim())).filter(Boolean) : coins.slice(0, BOOK_N);
  if (!bfStarted) { bfStarted = true; backfill(coins).catch(e => console.error('backfill', e.message)); }
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  let ping;
  ws.onopen = () => {
    retry = 0; lastMsg = Date.now(); subscribed = coins.length;
    for (const coin of coins) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    for (const coin of bookCoinsList) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
    ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ method: 'ping' })), 30000);
    console.log('HL connected,', coins.length, 'coins,', bookCoinsList.length, 'books');
  };
  ws.onmessage = ev => {
    lastMsg = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.channel === 'l2Book') {
      const d = m.data; if (!d?.levels || !d.coin) return;
      const f = L => L.map(x => [+x.px, +x.sz]);
      lastBook.set(d.coin, { ts: d.time, bids: f(d.levels[0]), asks: f(d.levels[1]) });
      return;
    }
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
const WIN = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '24h': 86400, '7d': 604800 };
const TFL = { '1s': 1, '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const q = (u, k, d) => u.searchParams.get(k) ?? d;
const num = (u, k, d) => { const v = +q(u, k, d); return Number.isFinite(v) ? v : d; };
const lim = (u, d, max) => Math.min(max, Math.max(1, Math.floor(num(u, 'limit', d))));
const parseTf = s => TFL[s] || Math.max(1, Math.floor(+s) || 1);
function route(u) {
  const coin = resolveCoin(q(u, 'coin', ''));
  const p = u.pathname;
  if (p === '/health') {
    let mb = null; try { mb = +(fs.statSync(DB_PATH).size / 1e6).toFixed(1); } catch {}
    return { ok: true, subscribed, books: lastBook.size, whaleQueue: wq.length, dbMB: mb, lastMsgAgoS: (Date.now() - lastMsg) / 1000 | 0, uptime: process.uptime() | 0 };
  }
  if (p === '/coins') return { coins: [...known.values()], book: bookCoinsList, tfs: Object.keys(TFL), tiers: TIERS, bookSec: BOOK_SEC };

  if (p === '/candles') { // ?coin=ZEC&tf=1|15|60|5m|1h|1d|любое число сек&limit=900&to=<сек, необязательно> -> t в секундах
    const tf = parseTf(q(u, 'tf', '1')), limit = lim(u, 900, 5000), to = Math.floor(num(u, 'to', Date.now() / 1000));
    const from = Math.floor(to / tf) * tf - (limit - 1) * tf;
    const base = [...TFS].reverse().find(b => tf % b === 0) ?? 1; // из какой таблицы собирать
    const rows = base === 1
      ? db.prepare(`SELECT t,o,h,l,c,v FROM candles1s WHERE coin=? AND t>=? AND t<=? ORDER BY t`).all(coin, from, to)
      : db.prepare(`SELECT t,o,h,l,c,v FROM candles WHERE tf=? AND coin=? AND t>=? AND t<=? ORDER BY t`).all(base, coin, from, to);
    if (base === tf) return rows;
    const out = new Map();
    for (const x of rows) {
      const b = Math.floor(x.t / tf) * tf, k = out.get(b);
      if (!k) out.set(b, { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
      else { k.h = Math.max(k.h, x.h); k.l = Math.min(k.l, x.l); k.c = x.c; k.v += x.v; }
    }
    return [...out.values()];
  }

  // ---- лента сделок ----
  if (p === '/bigtrades') { // ?coin=ZEC|ALL&min=10000&limit=200&ex=hyperliquid&since=<мс>&before=<мс>
    const ex = q(u, 'ex', '');
    return db.prepare(`SELECT coin,ts,side,usd,px,sz,buyer,seller,ex FROM big WHERE (?='ALL' OR coin=?) AND usd>=? AND ts>=? AND ts<? AND (?='' OR ex=?) ORDER BY ts DESC LIMIT ?`)
      .all(coin, coin, num(u, 'min', MIN_BIG), num(u, 'since', 0), num(u, 'before', 1e15), ex, ex, lim(u, 200, 1000));
  }
  if (p === '/tradestats') { // ?coin=ZEC&window=1h — сколько сделок и на какую сумму по каждому порогу
    const w = WIN[q(u, 'window', '1h')] || 3600;
    const cols = TIERS.map(t => `SUM(CASE WHEN usd>=${t} THEN 1 ELSE 0 END) n${t}, SUM(CASE WHEN usd>=${t} THEN usd ELSE 0 END) u${t}`).join(',');
    const rows = db.prepare(`SELECT side, ${cols} FROM big WHERE coin=? AND ts>=? GROUP BY side`).all(coin, Date.now() - w * 1000);
    const g = (side, t) => { const r = rows.find(x => x.side === side); return { n: r ? r['n' + t] : 0, usd: r ? r['u' + t] : 0 }; };
    return { coin, window: WIN[q(u, 'window', '1h')] ? q(u, 'window', '1h') : '1h', tiers: TIERS.map(t => ({ min: t, buy: g('buy', t), sell: g('sell', t) })) };
  }

  // ---- киты по монете ----
  if (p === '/whales') { // ?coin=ZEC&window=15m&min=100000
    const w = WIN[q(u, 'window', '15m')] || 900, min = num(u, 'min', 100000), since = Date.now() - w * 1000;
    const s = db.prepare(`SELECT side, COUNT(*) n, SUM(usd) usd FROM big WHERE coin=? AND ts>=? AND usd>=? GROUP BY side`).all(coin, since, min);
    const g = side => s.find(x => x.side === side) || { n: 0, usd: 0 };
    const top = (col) => db.prepare(`SELECT ${col} addr, SUM(usd) usd, COUNT(*) n FROM big WHERE coin=? AND ts>=? AND usd>=? AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY usd DESC LIMIT 5`).all(coin, since, min);
    return { coin, window: WIN[q(u, 'window', '15m')] ? q(u, 'window', '15m') : '15m', min, buy: g('buy'), sell: g('sell'), net: g('buy').usd - g('sell').usd, topBuyers: top('buyer'), topSellers: top('seller') };
  }
  if (p === '/whaleflow') { // ?coin=ZEC&tf=300&limit=288&min=100000 — поток китов по времени (покупки/продажи по свечам)
    const tf = Math.max(1, Math.floor(num(u, 'tf', 300))), limit = lim(u, 288, 2000), min = num(u, 'min', 100000), tfms = tf * 1000;
    const since = Math.floor(Date.now() / tfms) * tfms - (limit - 1) * tfms;
    const rows = db.prepare(`SELECT CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER) AS b, side, SUM(usd) usd, COUNT(*) n
      FROM big WHERE coin=? AND ts>=? AND usd>=? GROUP BY b, side ORDER BY b`).all(tfms, tfms, coin, since, min);
    const out = new Map();
    for (const r of rows) {
      const t = r.b / 1000; let o = out.get(t);
      if (!o) out.set(t, o = { t, buy: 0, sell: 0, nBuy: 0, nSell: 0, net: 0 });
      if (r.side === 'buy') { o.buy = r.usd; o.nBuy = r.n; } else { o.sell = r.usd; o.nSell = r.n; }
      o.net = o.buy - o.sell;
    }
    return [...out.values()];
  }
  if (p === '/whalepos') { // ?coin=ZEC&min=100000 — открытые позиции китов: лонг/шорт, средний вход, цены ликвидации
    const min = num(u, 'min', 100000);
    const rows = db.prepare(`SELECT addr,szi,entry,val,upnl,liq,lev,ts FROM whalepos WHERE coin=? AND val>=?`).all(coin, min);
    const agg = side => {
      const a = rows.filter(r => (r.szi > 0 ? 'long' : 'short') === side);
      const sz = a.reduce((s, r) => s + Math.abs(r.szi), 0);
      return { n: a.length, usd: a.reduce((s, r) => s + r.val, 0), avgEntry: sz ? a.reduce((s, r) => s + r.entry * Math.abs(r.szi), 0) / sz : null, upnl: a.reduce((s, r) => s + r.upnl, 0) };
    };
    const mk = r => ({ addr: r.addr, side: r.szi > 0 ? 'long' : 'short', usd: r.val, entry: r.entry, liq: r.liq, upnl: r.upnl, lev: r.lev });
    const byVal = [...rows].sort((a, b) => b.val - a.val);
    return {
      coin, min, addresses: rows.length, long: agg('long'), short: agg('short'),
      positions: byVal.slice(0, 30).map(mk),
      liq: byVal.filter(r => r.liq != null).slice(0, 80).map(r => ({ px: r.liq, usd: r.val, side: r.szi > 0 ? 'long' : 'short' })),
      updated: rows.length ? Math.max(...rows.map(r => r.ts)) : null,
    };
  }

  // ---- стакан ----
  if (p === '/book') return lastBook.get(coin) || null; // живой стакан (последний полученный)
  if (p === '/bookhist') { // ?coin=BTC&from=<мс>&to=<мс>&limit=360 — снимки стакана (для хитмапа)
    const rows = db.prepare(`SELECT ts,bids,asks FROM book WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT ?`)
      .all(coin, num(u, 'from', Date.now() - 3600e3), num(u, 'to', Date.now()), lim(u, 360, 2000));
    return rows.reverse().map(r => ({ ts: r.ts, bids: dec(r.bids), asks: dec(r.asks) }));
  }
  if (p === '/bookstat') { // ?coin=BTC&from&to&limit — метрики: mid, спред (б.п.), объём bid/ask в $, дисбаланс
    const rows = db.prepare(`SELECT ts,mid,spr,bid,ask FROM bookstat WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT ?`)
      .all(coin, num(u, 'from', Date.now() - 3600e3), num(u, 'to', Date.now()), lim(u, 360, 5000));
    return rows.reverse().map(r => ({ ...r, imb: (r.bid - r.ask) / ((r.bid + r.ask) || 1) }));
  }
  if (p === '/density') { // ?coin=BTC&window=1h&top=15&presence=0.2 — устойчивые плотности по снимкам стакана
    const w = Math.min(WIN[q(u, 'window', '1h')] || 3600, 86400), top = lim(u, 15, 100), minPres = num(u, 'presence', 0.2);
    const rows = db.prepare(`SELECT bids,asks FROM book WHERE coin=? AND ts>=?`).all(coin, Date.now() - w * 1000);
    const m = new Map();
    for (const r of rows) for (const side of ['bids', 'asks']) for (const [px, sz] of dec(r[side])) {
      const key = String(px); let x = m.get(key);
      if (!x) m.set(key, x = { px, usd: 0, cnt: 0, b: 0, a: 0 });
      x.usd += px * sz; x.cnt++; side === 'bids' ? x.b++ : x.a++;
    }
    const N = rows.length || 1;
    const levels = [...m.values()].map(x => ({ px: x.px, usd: x.usd / N, presence: x.cnt / N, side: x.b >= x.a ? 'bid' : 'ask' }))
      .filter(x => x.presence >= minPres).sort((a, b) => b.usd - a.usd).slice(0, top);
    const lb = lastBook.get(coin);
    return { coin, window: w, snapshots: rows.length, mid: lb ? (lb.bids[0][0] + lb.asks[0][0]) / 2 : null, levels };
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

if (!env.NO_FEED) { connectHL(); whaleLoop(); }
export { ingest, flush };
