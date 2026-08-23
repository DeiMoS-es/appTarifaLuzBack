const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { DateTime } = require('luxon');
const { normalizeProviderValues } = require('../models/electricidad.precios');
const { buildProviderUrl } = require('../routes/api/precios');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'historico-cache.json');
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

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
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

async function fetchProviderForDay(dateIso) {
  // dateIso: YYYY-MM-DD
  const start = DateTime.fromISO(dateIso, { zone: TIME_ZONE }).startOf('day');
  const end = start.plus({ days: 1 });
  const day = {
    startsAt: start.toISO({ suppressMilliseconds: true }),
    endsAt: end.toISO({ suppressMilliseconds: true })
  };
  const url = buildProviderUrl(API_TEMPLATE(), day);
  const response = await axios.get(url, { timeout: 30_000 });
  const items = response?.data?.included ? response.data.included.flatMap(g => g.attributes.values) : [];
  const normalized = normalizeProviderValues(items);
  return groupByDate(normalized.values)[0] || null; // should be single day
}

async function ensureDaysCached(dates) {
  const cache = await readCache();
  const missing = dates.filter(d => !(d in cache));
  if (missing.length === 0) return cache;

  for (const day of missing) {
    try {
      const fetched = await fetchProviderForDay(day);
      if (fetched) cache[day] = fetched;
      else cache[day] = { fecha: day, media: null, minimo: null, maximo: null, missing: true };
    } catch (err) {
      cache[day] = { fecha: day, media: null, minimo: null, maximo: null, error: String(err.message || err) };
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

async function getHistorico(kind) {
  const dates = datesForRange(kind);
  const cache = await ensureDaysCached(dates);
  const daily = dates.map(d => {
    const fromCache = cache[d];
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

module.exports = { getHistorico, ensureDaysCached, CACHE_FILE, aggregateDay, groupByDate };
