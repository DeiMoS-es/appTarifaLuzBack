Historico endpoints

New endpoints:
- GET /api/historico/semana -> last 7 days (one aggregated datapoint per day)
- GET /api/historico/mes -> last ~30 days
- GET /api/historico/anio -> last 365 days (daily aggregation)

Response shape:
{
  range: 'semana'|'mes'|'anio',
  values: [ { fecha: 'YYYY-MM-DD', media: number|null, minimo: number|null, maximo: number|null }, ... ]
}

Notes:
- The service uses the existing REE API template in process.env.APIREDTADAURI and the normalizeProviderValues helper.
- A simple JSON cache is stored at data/historico-cache.json. Endpoints read from that cache and will backfill missing days on demand by requesting the provider.
- A cron job script is provided at ./cron-historico.js which schedules a daily update (20:20 Europe/Madrid). Install node-cron with `pnpm add node-cron` if you want to enable the scheduled run and start the script alongside the server (for example with pm2 or a separate Node process).

Developer commands:
- Install (backend): pnpm install (then pnpm add node-cron if you want scheduled jobs)
- Run server locally: pnpm dev (uses nodemon)
- Run tests: pnpm test (Node's --test runner). The new aggregation unit test is at tests/historico-aggregate.test.js

Caching behaviour and backfill:
- When a historico endpoint is requested, the service checks data/historico-cache.json for the requested dates.
- Missing dates are fetched synchronously from the provider and appended to the cache. If the provider fails for a day, the cache entry is written with null fields and an error marker so the frontend can show a meaningful message.

Timezone:
- Aggregation runs in Europe/Madrid (uses luxon) and groups hourly values by the local calendar date.

If any change to the REE API template or querying logic is desired (e.g., switching time_trunc to day if supported), update process.env.APIREDTADAURI accordingly and the service will reuse it.
