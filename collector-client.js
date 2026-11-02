// Вставьте в <script> вашего HTML. Если сервер недоступен, все функции вернут null,
// и приложение работает как раньше (только живой поток).
const COLLECTOR = 'https://YOUR-SERVICE'; // адрес сервера, https, без / в конце

async function cj(path) {
  if (!COLLECTOR || COLLECTOR.includes('YOUR-SERVICE')) return null;
  try {
    const r = await fetch(COLLECTOR + path, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const loadCandles   = (coin, tf = 1, limit = 900) => cj(`/candles?coin=${encodeURIComponent(coin)}&tf=${tf}&limit=${limit}`);
const loadBigTrades = (coin, min = 10000, limit = 200) => cj(`/bigtrades?coin=${encodeURIComponent(coin)}&min=${min}&limit=${limit}`);
const loadWhales    = (coin, win = '15m', min = 100000) => cj(`/whales?coin=${encodeURIComponent(coin)}&window=${win}&min=${min}`);

// история + живые свечи без дублей (ключ t, живые перекрывают историю)
function mergeCandles(hist, live) {
  const m = new Map();
  for (const c of hist || []) m.set(c.t, c);
  for (const c of live || []) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
}
// секунды без сделок на сервере не хранятся: дорисовываем плоские свечи по последней цене
function fillGaps(cs, tf = 1, maxFill = 5000) {
  const out = []; let added = 0;
  for (const c of cs) {
    const p = out[out.length - 1];
    if (p) for (let t = p.t + tf; t < c.t && added < maxFill; t += tf, added++)
      out.push({ t, o: p.c, h: p.c, l: p.c, c: p.c, v: 0 });
    out.push(c);
  }
  return out;
}
// лента: историю с сервера и живые сделки объединяем по ts+px+sz+side
function mergeTrades(hist, live) {
  const m = new Map();
  for (const x of [...(hist || []), ...(live || [])]) m.set(`${x.ts}|${x.px}|${x.sz}|${x.side}`, x);
  return [...m.values()].sort((a, b) => b.ts - a.ts);
}
