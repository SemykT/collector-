# Whale collector

Круглосуточно копит данные Hyperliquid (секундные свечи + крупные сделки), пока страница закрыта.

## Запуск
    node --no-warnings server.js        # Node 22.13+, зависимостей нет
    # ENV: PORT=8080 TOP=60 COINS=BTC,ETH,ZEC MIN_BIG=10000 DB=./data.db

Деплой: Railway / Fly.io / Render / VPS. Нужен постоянный процесс и диск (volume) под data.db,
например DB=/data/data.db. На Vercel нельзя. Запускать ровно один экземпляр.

## API
- `GET /candles?coin=ZEC&tf=1|15&limit=900` -> `[{t,o,h,l,c,v}]`, t в секундах, v в монетах
- `GET /bigtrades?coin=ZEC&min=10000&limit=200&ex=hyperliquid` -> `[{ts,side,usd,px,sz,buyer,seller,ex}]` (min не ниже MIN_BIG)
- `GET /whales?coin=ZEC&window=15m&min=100000` (5m,15m,30m,1h,4h,24h)
- `GET /health`
