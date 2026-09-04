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
const SEED_FILE = process.env.HISTORICO_SEED_FILE || path.join(__dirname, '..', 'data', 'historico-cache.json');
const PROVIDER_REQUEST_BUDGET_MS = Number(process.env.HISTORICO_PROVIDER_BUDGET_MS) || 2_500;
const PROVIDER_CALL_TIMEOUT_MS = Number(process.env.HISTORICO_PROVIDER_TIMEOUT_MS) || 1_200;
const PROVIDER_MAX_CALLS = Number(process.env.HISTORICO_PROVIDER_MAX_CALLS) || 2;
const PROVIDER_COOLDOWN_MS = Number(process.env.HISTORICO_PROVIDER_COOLDOWN_MS) || 5 * 60_000;
let cacheMutationQueue = Promise.resolve();
const retryCooldownMemory = new Map();

function structuredLog(level, event, details = {}) {
  const record = JSON.stringify({ component: 'historico', event, ...details });
  const output = console[level] || console.log;
  output.call(console, record);
}

function isUsableDay(value) {
  return Boolean(value && typeof value === 'object' && typeof value.media === 'number' && Number.isFinite(value.media));
}

function migrateLegacyRoot(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return false;
  if (!cache.peninsular || typeof cache.peninsular !== 'object' || Array.isArray(cache.peninsular)) {
    cache.peninsular = {};
  }

  let migrated = false;
  for (const [key, value] of Object.entries(cache)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !isUsableDay(value)) continue;
    if (!isUsableDay(cache.peninsular[key])) {
      cache.peninsular[key] = value;
      migrated = true;
    }
  }
  return migrated;
}

async function parseCacheFile(file) {
  const raw = await fs.readFile(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cache root must be an object');
    return parsed;
  } catch (err) {
    const error = new Error(`historico cache is corrupt: ${file}`);
    error.code = 'HISTORICO_CACHE_CORRUPT';
    error.cause = err;
    throw error;
  }
}

async function readCacheDetails(cacheFile = CACHE_FILE, seedFile = SEED_FILE) {
  try {
    return { cache: await parseCacheFile(cacheFile), fromSeed: false };
  } catch (err) {
    const recoveryFiles = [
      { file: `${cacheFile}.bak`, source: 'backup' },
      ...(cacheFile !== seedFile ? [{ file: seedFile, source: 'seed' }] : [])
    ];
    for (const recovery of recoveryFiles) {
      try {
        const cache = await parseCacheFile(recovery.file);
        structuredLog(err && err.code === 'HISTORICO_CACHE_CORRUPT' ? 'error' : 'warn', 'cache_recovered', {
          source: recovery.source,
          cacheFile,
          code: err && err.code
        });
        return { cache, fromSeed: recovery.source === 'seed', recoveredFrom: recovery.source };
      } catch (recoveryError) {
        if (recoveryError && recoveryError.code !== 'ENOENT') {
          structuredLog('warn', 'cache_recovery_source_invalid', { source: recovery.source, code: recoveryError.code });
        }
      }
    }
    if (err && err.code === 'ENOENT') return { cache: {}, fromSeed: false };
    structuredLog('error', 'cache_recovery_failed', { cacheFile, code: err && err.code });
    throw err;
  }
}

async function readCache() {
  return (await readCacheDetails()).cache;
}

function getZoneCache(cache, zone) {
  const normalized = normalizeZone(zone);
  const zoneKey = normalized.geo_limit;
  if (!cache[zoneKey] || typeof cache[zoneKey] !== 'object' || Array.isArray(cache[zoneKey])) cache[zoneKey] = {};
  return cache[zoneKey];
}

async function writeCacheAtomic(cache, cacheFile = CACHE_FILE) {
  const directory = path.dirname(cacheFile);
  const temporary = path.join(directory, `.${path.basename(cacheFile)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const backupFile = `${cacheFile}.bak`;
  const backupTemporary = `${temporary}.bak`;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(cache, null, 2), 'utf8');
    let currentRaw;
    try {
      currentRaw = await fs.readFile(cacheFile, 'utf8');
    } catch (currentError) {
      if (!currentError || currentError.code !== 'ENOENT') throw currentError;
    }
    if (currentRaw !== undefined) {
      let currentIsValid = false;
      try {
        const current = JSON.parse(currentRaw);
        currentIsValid = Boolean(current && typeof current === 'object' && !Array.isArray(current));
      } catch (_) {}
      if (currentIsValid) {
        await fs.writeFile(backupTemporary, currentRaw, 'utf8');
        await fs.rename(backupTemporary, backupFile);
      } else {
        const quarantineFile = `${cacheFile}.corrupt.${Date.now()}.${process.pid}`;
        await fs.rename(cacheFile, quarantineFile);
        structuredLog('error', 'cache_corrupt_quarantined', { cacheFile, quarantineFile });
      }
    }
    await fs.rename(temporary, cacheFile);
  } catch (err) {
    try { await fs.unlink(temporary); } catch (cleanupError) {
      if (cleanupError && cleanupError.code !== 'ENOENT') structuredLog('warn', 'cache_temp_cleanup_failed', { code: cleanupError.code });
    }
    try { await fs.unlink(backupTemporary); } catch (cleanupError) {
      if (cleanupError && cleanupError.code !== 'ENOENT') structuredLog('warn', 'cache_backup_temp_cleanup_failed', { code: cleanupError.code });
    }
    throw err;
  }
}

function serializeCacheMutation(operation) {
  const pending = cacheMutationQueue.then(operation, operation);
  cacheMutationQueue = pending.catch(() => {});
  return pending;
}

async function writeCache(cache) {
  return serializeCacheMutation(() => writeCacheAtomic(cache));
}

async function persistCache(cache) {
  try {
    await writeCacheAtomic(cache);
    return true;
  } catch (err) {
    structuredLog('warn', 'cache_write_failed', { code: err && err.code });
    return false;
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

async function providerGet(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await axios.get(url, { timeout: timeoutMs, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProviderForDay(dateIso, zone = 'peninsular', timeoutMs = PROVIDER_CALL_TIMEOUT_MS) {
  // dateIso: YYYY-MM-DD
  const start = DateTime.fromISO(dateIso, { zone: TIME_ZONE }).startOf('day');
  const end = start.plus({ days: 1 });
  const day = {
    startsAt: start.toISO({ suppressMilliseconds: true }),
    endsAt: end.toISO({ suppressMilliseconds: true })
  };
  const url = buildProviderUrl(API_TEMPLATE(), day, zone);
  const response = await providerGet(url, timeoutMs);
  const items = response?.data?.included ? response.data.included.flatMap(g => g.attributes.values) : [];
  const normalized = normalizeProviderValues(items);
  return groupByDate(normalized.values)[0] || null; // should be single day
}

// Fetch provider data for an inclusive date range (YYYY-MM-DD start to end)
async function fetchProviderForRange(startIso, endIso, zone = 'peninsular', timeoutMs = PROVIDER_CALL_TIMEOUT_MS) {
  const start = DateTime.fromISO(startIso, { zone: TIME_ZONE }).startOf('day');
  const end = DateTime.fromISO(endIso, { zone: TIME_ZONE }).endOf('day');
  const day = {
    startsAt: start.toISO({ suppressMilliseconds: true }),
    endsAt: end.toISO({ suppressMilliseconds: true })
  };
  const url = buildProviderUrl(API_TEMPLATE(), day, zone);
  const response = await providerGet(url, timeoutMs);
  const items = response?.data?.included ? response.data.included.flatMap(g => g.attributes.values) : [];
  const normalized = normalizeProviderValues(items);
  // groupByDate returns sorted daily aggregates
  return groupByDate(normalized.values);
}

async function ensureDaysCached(dates, zone = 'peninsular') {
  return serializeCacheMutation(() => ensureDaysCachedSerialized(dates, zone));
}

async function ensureDaysCachedSerialized(dates, zone = 'peninsular') {
  const { cache, fromSeed } = await readCacheDetails();
  const migrated = migrateLegacyRoot(cache);
  const zoneCache = getZoneCache(cache, zone);
  const zoneKey = normalizeZone(zone).geo_limit;
  if (!cache._retry || typeof cache._retry !== 'object' || Array.isArray(cache._retry)) cache._retry = {};
  if (!cache._retry[zoneKey] || typeof cache._retry[zoneKey] !== 'object' || Array.isArray(cache._retry[zoneKey])) cache._retry[zoneKey] = {};
  const retryState = cache._retry[zoneKey];
  const now = Date.now();
  const retryKey = date => `${zoneKey}:${date}`;
  const missing = dates.filter(d => {
    const retryAfter = Math.max(Number(retryState[d]?.retryAfter) || 0, retryCooldownMemory.get(retryKey(d)) || 0);
    return !isUsableDay(zoneCache[d]) && retryAfter <= now;
  });
  if (missing.length === 0) {
    if (migrated || fromSeed) await persistCache(cache);
    return cache;
  }

  const deadline = now + PROVIDER_REQUEST_BUDGET_MS;
  let providerCalls = 0;
  const callTimeout = () => Math.min(PROVIDER_CALL_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
  const canCall = () => providerCalls < PROVIDER_MAX_CALLS && callTimeout() > 0;

  if (missing.length > 1 && canCall()) {
    try {
      const sortedMissing = missing.slice().sort();
      providerCalls += 1;
      const fetchedDays = await fetchProviderForRange(sortedMissing[0], sortedMissing[sortedMissing.length - 1], zone, callTimeout());
      for (const d of fetchedDays) {
        if (d && d.fecha && isUsableDay(d)) {
          zoneCache[d.fecha] = d;
          delete retryState[d.fecha];
          retryCooldownMemory.delete(retryKey(d.fecha));
        }
      }
    } catch (err) {
      structuredLog('warn', 'provider_range_failed', { zone: zoneKey, code: err && err.code });
    }
  }

  const stillMissing = missing.filter(day => !isUsableDay(zoneCache[day]));
  for (const day of stillMissing) {
    if (!canCall()) break;
    try {
      providerCalls += 1;
      const fetched = await fetchProviderForDay(day, zone, callTimeout());
      if (isUsableDay(fetched)) {
        zoneCache[day] = fetched;
        delete retryState[day];
        retryCooldownMemory.delete(retryKey(day));
      }
    } catch (err) {
      structuredLog('warn', 'provider_day_failed', { zone: zoneKey, date: day, code: err && err.code });
    }
  }
  const retryAfter = Date.now() + PROVIDER_COOLDOWN_MS;
  for (const day of missing) {
    if (!isUsableDay(zoneCache[day])) {
      retryState[day] = { retryAfter };
    }
  }
  const persisted = await persistCache(cache);
  if (!persisted) {
    for (const day of missing) {
      if (!isUsableDay(zoneCache[day])) retryCooldownMemory.set(retryKey(day), retryAfter);
    }
  }
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
  return (await getHistoricoResult(kind, zone)).values;
}

async function getHistoricoResult(kind, zone = 'peninsular') {
  const dates = datesForRange(kind);
  if (kind === 'anio') return getAnnualHistoricoResult(dates, zone);

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

  return { values: daily, partial: false };
}

async function getAnnualHistoricoResult(dates, zone) {
  // Atomic rename guarantees this read sees either the previous or next complete snapshot.
  // Keep annual reads outside the mutation queue so provider backfills cannot block them.
  const { cache } = await readCacheDetails();
  migrateLegacyRoot(cache);
  const zoneCache = getZoneCache(cache, zone);
  const available = dates.flatMap(date => {
    const day = zoneCache[date];
    return isUsableDay(day) ? [{ fecha: date, media: day.media, minimo: day.minimo, maximo: day.maximo }] : [];
  });

  const missingDays = dates.length - available.length;
  const values = aggregateWeeksFromDaily(available);
  return {
    values,
    partial: missingDays > 0,
    message: missingDays > 0 ? 'Historical data is partial; only cached numeric days are included.' : undefined,
    metadata: { requestedDays: dates.length, availableDays: available.length, missingDays, bucketCount: values.length }
  };
}

module.exports = {
  getHistorico,
  getHistoricoResult,
  ensureDaysCached,
  readCache,
  readCacheDetails,
  writeCache,
  writeCacheAtomic,
  migrateLegacyRoot,
  isUsableDay,
  CACHE_FILE,
  SEED_FILE,
  aggregateDay,
  aggregateWeeksFromDaily,
  groupByDate,
  datesForRange
};
