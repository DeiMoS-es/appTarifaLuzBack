const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const { DateTime } = require('luxon');
const { normalizeProviderValues } = require('../models/electricidad.precios');
const { buildProviderUrl, normalizeZone } = require('../routes/api/precios');

// Use a writable temp path when running in serverless environments (Vercel uses a read-only /var/task)
const CACHE_FILE = process.env.HISTORICO_CACHE_FILE || (process.env.VERCEL ? path.join(os.tmpdir(), 'historico-cache.json') : path.join(__dirname, '..', 'data', 'historico-cache.json'));
const API_TEMPLATE = () => process.env.APIREDTADAURI;
const TIME_ZONE = 'Europe/Madrid';

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {}; // empty cache
  }
}

function getZoneCache(cache, zone) {
  const normalized = normalizeZone(zone);
  const zoneKey = normalized.geo_limit;
  if (!cache[zoneKey]) cache[zoneKey] = {};
  return cache[zoneKey];
}

async function writeCache(cache) {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    // In serverless or read-only filesystems (e.g. Vercel), writes can fail.
    // Don't let cache write failures break the API — fallback to in-memory behavior.
    // Log the error for debugging but continue.
    try { console.warn('historico cache write failed:', err && err.message ? err.message : err); } catch (e) {}
  }
}

function aggregateDay(values) {
  // values: array of normalized items from normalizeProviderValues().values
  if (!Array.isArray(values) || values.length === 0) return null;
  let sum = 0;
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let minHour = null;
  let maxHour = null;

  for (const v of values) {
    const val = Number(v.valueEurMWh);
    if (!Number.isFinite(val)) continue;
    sum += val;
    count += 1;
    if (val < min) {
      min = val;
      minHour = v.startsAt;
    }
    if (val > max) {
      max = val;
      maxHour = v.startsAt;
    }
  }
  if (count === 0) return null;
  return {
    fecha: DateTime.fromISO(values[0].startsAt, { setZone: true }).toISODate(),
    media: sum / count,
    minimo: min,
    maximo: max,
    minimoHora: minHour,
    maximoHora: maxHour
  };
}

function groupByDate(normalizedValues) {
  const groups = new Map();
  for (const v of normalizedValues) {
    const date = DateTime.fromISO(v.startsAt, { setZone: true }).toISODate();
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(v);
  }
  const result = [];
  for (const [date, items] of groups.entries()) {
    const agg = aggregateDay(items);
    if (agg) result.push(agg);
  }
  // sort by fecha asc
  result.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return result;
}

async function fetchProviderForDay(dateIso, zone = 'peninsular') {
  // dateIso: YYYY-MM-DD
  const start = DateTime.fromISO(dateIso, { zone: TIME_ZONE }).startOf('day');
  const end = start.plus({ days: 1 });
  const day = {
    startsAt: start.toISO({ suppressMilliseconds: true }),
    endsAt: end.toISO({ suppressMilliseconds: true })
  };
  const url = buildProviderUrl(API_TEMPLATE(), day, zone);
  const response = await axios.get(url, { timeout: 30_000 });
  const items = response?.data?.included ? response.data.included.flatMap(g => g.attributes.values) : [];
  const normalized = normalizeProviderValues(items);
  return groupByDate(normalized.values)[0] || null; // should be single day
}

// Fetch provider data for an inclusive date range (YYYY-MM-DD start to end)
async function fetchProviderForRange(startIso, endIso, zone = 'peninsular') {
  const start = DateTime.fromISO(startIso, { zone: TIME_ZONE }).startOf('day');
  const end = DateTime.fromISO(endIso, { zone: TIME_ZONE }).endOf('day');
  const day = {
    startsAt: start.toISO({ suppressMilliseconds: true }),
    endsAt: end.toISO({ suppressMilliseconds: true })
  };
  const url = buildProviderUrl(API_TEMPLATE(), day, zone);
  const response = await axios.get(url, { timeout: 60_000 });
  const items = response?.data?.included ? response.data.included.flatMap(g => g.attributes.values) : [];
  const normalized = normalizeProviderValues(items);
  // groupByDate returns sorted daily aggregates
  return groupByDate(normalized.values);
}

async function ensureDaysCached(dates, zone = 'peninsular') {
  const cache = await readCache();
  const zoneCache = getZoneCache(cache, zone);
  const missing = dates.filter(d => !(d in zoneCache));
  if (missing.length === 0) return cache;

  // In serverless environments (e.g. Vercel) synchronous fetching of many days
  // can easily hit function timeouts because we may perform many external
  // HTTP requests. Prefer a single range request to the provider when
  // possible, falling back to marking days as missing if the provider call fails.
  const runningServerless = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.SERVERLESS);
  if (runningServerless) {
    try {
      // attempt to fetch as a single range from earliest missing to latest missing
      const sortedMissing = missing.slice().sort();
      const rangeStart = sortedMissing[0];
      const rangeEnd = sortedMissing[sortedMissing.length - 1];
      const fetchedDays = await fetchProviderForRange(rangeStart, rangeEnd, zone);
      // populate cache with any fetched days
      for (const d of fetchedDays) {
        if (d && d.fecha) zoneCache[d.fecha] = d;
      }

      // If range fetch did not return all days, attempt per-day fetch for remaining dates
      const stillMissing = missing.filter(day => !(day in zoneCache));
      if (stillMissing.length > 0) {
        for (const day of stillMissing) {
          try {
            const fetched = await fetchProviderForDay(day, zone);
            if (fetched) zoneCache[day] = fetched;
            else zoneCache[day] = { fecha: day, media: null, minimo: null, maximo: null, missing: true };
          } catch (e) {
            // if per-day fetching fails, mark as missing but continue
            zoneCache[day] = { fecha: day, media: null, minimo: null, maximo: null, missing: true, error: String(e && e.message ? e.message : e) };
          }
          // be polite with provider when doing multiple calls
          await new Promise(r => setTimeout(r, 250));
        }
      }

      try { await writeCache(cache); } catch (e) {}
      return cache;
    } catch (err) {
      // If range fetch fails, don't block: attempt per-day fetch as a fallback
      for (const day of missing) {
        try {
          const fetched = await fetchProviderForDay(day, zone);
          if (fetched) zoneCache[day] = fetched;
          else zoneCache[day] = { fecha: day, media: null, minimo: null, maximo: null, missing: true };
        } catch (e) {
          zoneCache[day] = { fecha: day, media: null, minimo: null, maximo: null, missing: true, error: String(e && e.message ? e.message : e) };
        }
        await new Promise(r => setTimeout(r, 250));
      }
      try { await writeCache(cache); } catch (e) {}
      return cache;
    }
  }

  for (const day of missing) {
    try {
      const fetched = await fetchProviderForDay(day, zone);
      if (fetched) zoneCache[day] = fetched;
      else zoneCache[day] = { fecha: day, media: null, minimo: null, maximo: null, missing: true };
    } catch (err) {
      zoneCache[day] = { fecha: day, media: null, minimo: null, maximo: null, error: String(err.message || err) };
    }
    // be polite with provider
    await new Promise(r => setTimeout(r, 300));
  }
  await writeCache(cache);
  return cache;
}

function datesForRange(kind) {
  const now = DateTime.now().setZone(TIME_ZONE).startOf('day');
  if (kind === 'semana') {
    const dates = [];
    for (let i = 6; i >= 0; i--) dates.push(now.minus({ days: i }).toISODate());
    return dates;
  }
  if (kind === 'mes') {
    const dates = [];
    for (let i = 29; i >= 0; i--) dates.push(now.minus({ days: i }).toISODate());
    return dates;
  }
  if (kind === 'anio') {
    // return last 365 days
    const dates = [];
    for (let i = 364; i >= 0; i--) dates.push(now.minus({ days: i }).toISODate());
    return dates;
  }
  throw new Error('unknown range');
}

function aggregateWeeksFromDaily(dailyArray) {
  // dailyArray: [{ fecha: 'YYYY-MM-DD', media, minimo, maximo }, ...] sorted ascending by fecha
  const weeksMap = new Map();
  for (const d of dailyArray) {
    if (!d || typeof d.fecha !== 'string') continue;
    const dt = DateTime.fromISO(d.fecha, { zone: TIME_ZONE });
    // compute ISO week start (Monday)
    const weekStart = dt.minus({ days: dt.weekday - 1 }).startOf('day');
    const key = weekStart.toISODate();
    if (!weeksMap.has(key)) weeksMap.set(key, []);
    weeksMap.get(key).push(d);
  }
  const weeks = [];
  for (const [weekStart, items] of Array.from(weeksMap.entries()).sort((a,b)=>a[0].localeCompare(b[0]))) {
    const medias = items.map(x => (x.media === null ? NaN : x.media)).filter(Number.isFinite);
    const minimos = items.map(x => (x.minimo === null ? NaN : x.minimo)).filter(Number.isFinite);
    const maximos = items.map(x => (x.maximo === null ? NaN : x.maximo)).filter(Number.isFinite);
    const media = medias.length ? medias.reduce((a,b)=>a+b,0)/medias.length : null;
    const minimo = minimos.length ? Math.min(...minimos) : null;
    const maximo = maximos.length ? Math.max(...maximos) : null;
    weeks.push({ fecha: weekStart, media, minimo, maximo });
  }
  return weeks;
}

async function getHistorico(kind, zone = 'peninsular') {
  const dates = datesForRange(kind);
  const cache = await ensureDaysCached(dates, zone);
  const zoneCache = getZoneCache(cache, zone);
  const daily = dates.map(d => {
    const fromCache = zoneCache[d];
    if (!fromCache) return { fecha: d, media: null, minimo: null, maximo: null };
    return {
      fecha: fromCache.fecha,
      media: fromCache.media,
      minimo: fromCache.minimo,
      maximo: fromCache.maximo
    };
  });

  if (kind === 'anio') {
    // aggregate daily into weekly buckets for a clearer yearly chart
    return aggregateWeeksFromDaily(daily);
  }

  return daily;
}

module.exports = { getHistorico, ensureDaysCached, CACHE_FILE, aggregateDay, groupByDate, datesForRange };
