const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, afterEach, before, describe, it } = require('node:test');
const axios = require('axios');
const express = require('express');
const { DateTime } = require('luxon');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'historico-cache-test-'));
const cacheFile = path.join(temporaryDirectory, 'historico-cache.json');
const seedFile = path.join(temporaryDirectory, 'historico-seed.json');
process.env.HISTORICO_CACHE_FILE = cacheFile;
process.env.HISTORICO_SEED_FILE = seedFile;
process.env.HISTORICO_PROVIDER_BUDGET_MS = '80';
process.env.HISTORICO_PROVIDER_TIMEOUT_MS = '30';
process.env.HISTORICO_PROVIDER_MAX_CALLS = '2';
process.env.HISTORICO_PROVIDER_COOLDOWN_MS = '60000';
process.env.APIREDTADAURI = 'https://provider.test/prices?start_date=old&end_date=old';
fs.writeFileSync(seedFile, '{}', 'utf8');

const historico = require('../services/historico');
const historicoRouter = require('../routes/api/historico');

function day(fecha, media) {
  return { fecha, media, minimo: media - 1, maximo: media + 1 };
}

function dates(kind) {
  return historico.datesForRange(kind);
}

function cacheForDates(requestedDates, zone = 'peninsular') {
  return {
    [zone]: Object.fromEntries(requestedDates.map((date, index) => [date, day(date, index + 1)]))
  };
}

async function saveCache(cache) {
  await fsp.writeFile(cacheFile, JSON.stringify(cache), 'utf8');
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(route) {
  const app = express();
  app.use('/api/historico', historicoRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const address = server.address();
      http.get({ hostname: '127.0.0.1', port: address.port, path: route }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('historico cache resilience', () => {
  const originalAxiosGet = axios.get;

  before(async () => {
    await saveCache({});
  });

  after(async () => {
    axios.get = originalAxiosGet;
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  });

  afterEach(() => {
    axios.get = originalAxiosGet;
  });

  it('migrates legacy root days to peninsular without overwriting valid nested data', () => {
    const cache = {
      '2024-01-01': day('2024-01-01', 10),
      '2024-01-02': day('2024-01-02', 20),
      peninsular: { '2024-01-02': day('2024-01-02', 99) },
      canarias: { '2024-01-01': day('2024-01-01', 50) }
    };

    assert.equal(historico.migrateLegacyRoot(cache), true);
    assert.equal(cache.peninsular['2024-01-01'].media, 10);
    assert.equal(cache.peninsular['2024-01-02'].media, 99);
    assert.equal(cache.canarias['2024-01-01'].media, 50);
    assert.equal(historico.migrateLegacyRoot(cache), false);
  });

  it('loads a seed on cold start without changing the seed file', async () => {
    const seed = path.join(temporaryDirectory, 'seed.json');
    const missingRuntimeCache = path.join(temporaryDirectory, 'cold', 'historico-cache.json');
    await fsp.writeFile(seed, JSON.stringify({ '2024-01-01': day('2024-01-01', 42) }), 'utf8');
    const beforeHash = digest(seed);

    const result = await historico.readCacheDetails(missingRuntimeCache, seed);

    assert.equal(result.fromSeed, true);
    assert.equal(result.cache['2024-01-01'].media, 42);
    assert.equal(fs.existsSync(missingRuntimeCache), false);
    assert.equal(digest(seed), beforeHash);
  });

  it('materializes a stale seed into runtime and refreshes within the provider call cap', async () => {
    const annualDates = dates('anio');
    await fsp.writeFile(seedFile, JSON.stringify(cacheForDates(annualDates.slice(0, 3))), 'utf8');
    const seedHash = digest(seedFile);
    await fsp.rm(cacheFile, { force: true });
    let providerCalls = 0;
    axios.get = async () => {
      providerCalls += 1;
      return { data: { included: [] } };
    };

    const result = await historico.getHistoricoResult('anio', 'peninsular');

    assert.equal(result.partial, true);
    assert.equal(result.metadata.availableDays, 3);
    assert.equal(providerCalls, 2);
    assert.equal(fs.existsSync(cacheFile), true);
    assert.equal(JSON.parse(await fsp.readFile(cacheFile, 'utf8')).peninsular[annualDates[0]].media, 1);
    assert.equal(digest(seedFile), seedHash);
  });

  it('returns a complete year as numeric weekly buckets instead of daily null placeholders', async () => {
    await saveCache(cacheForDates(dates('anio')));

    const response = await request('/api/historico/anio');

    assert.equal(response.status, 200);
    assert.equal(response.body.partial, false);
    assert.equal(response.body.metadata.availableDays, 365);
    assert.ok(response.body.values.length >= 52 && response.body.values.length <= 54);
    assert.ok(response.body.values.every(value => Number.isFinite(value.media)));
    assert.notEqual(response.body.values.length, 365);
  });

  it('keeps available numbers and reports missing days for a partial annual cache', async () => {
    const annualDates = dates('anio');
    await saveCache(cacheForDates([...annualDates.slice(0, 12), ...annualDates.slice(-2)]));
    axios.get = async () => ({ data: { included: [] } });

    const result = await historico.getHistoricoResult('anio', 'peninsular');

    assert.equal(result.partial, true);
    assert.equal(result.metadata.availableDays, 14);
    assert.equal(result.metadata.missingDays, 351);
    assert.ok(result.values.length >= 2);
    assert.ok(result.values.every(value => Number.isFinite(value.media)));
    assert.match(result.message, /partial/i);
  });

  it('refreshes a missing annual day and includes it in the window', async () => {
    const annualDates = dates('anio');
    const latestDate = annualDates.at(-1);
    await saveCache(cacheForDates(annualDates.slice(0, -1)));
    let providerCalls = 0;
    axios.get = async (url) => {
      providerCalls += 1;
      assert.match(url, new RegExp(latestDate));
      return { data: { included: [{ attributes: { values: [{ datetime: `${latestDate}T12:00:00+02:00`, value: 42 }] } }] } };
    };

    const result = await historico.getHistoricoResult('anio', 'peninsular');

    assert.equal(result.partial, false);
    assert.equal(result.metadata.availableDays, 365);
    assert.equal(providerCalls, 1);
    assert.equal(JSON.parse(await fsp.readFile(cacheFile, 'utf8')).peninsular[latestDate].media, 42);
  });

  it('fills consecutive and interior annual gaps with one range call', async () => {
    const annualDates = dates('anio');
    const missingDates = [annualDates[40], annualDates[41], annualDates[200]];
    const cache = cacheForDates(annualDates);
    for (const date of missingDates) delete cache.peninsular[date];
    await saveCache(cache);
    let providerCalls = 0;
    axios.get = async () => {
      providerCalls += 1;
      return {
        data: {
          included: [{
            attributes: {
              values: missingDates.map((date, index) => ({ datetime: `${date}T12:00:00+02:00`, value: 50 + index }))
            }
          }]
        }
      };
    };

    const result = await historico.getHistoricoResult('anio', 'peninsular');

    assert.equal(result.partial, false);
    assert.equal(result.metadata.availableDays, 365);
    assert.equal(providerCalls, 1);
    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    assert.ok(missingDates.every(date => Number.isFinite(persisted.peninsular[date].media)));
  });

  it('returns a partial annual snapshot under budget and cooldown when the provider is down', async () => {
    const annualDates = dates('anio');
    await saveCache(cacheForDates(annualDates.slice(-1)));
    let providerCalls = 0;
    axios.get = (_url, options) => {
      providerCalls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
      });
    };
    const startedAt = Date.now();

    const first = await historico.getHistoricoResult('anio', 'peninsular');
    const callsAfterFirst = providerCalls;
    const second = await historico.getHistoricoResult('anio', 'peninsular');

    assert.equal(first.partial, true);
    assert.equal(second.partial, true);
    assert.equal(callsAfterFirst, 2);
    assert.equal(providerCalls, callsAfterFirst);
    assert.ok(callsAfterFirst <= 2, 'annual fallback exceeded the provider call cap');
    assert.ok(Date.now() - startedAt < 500);
  });

  it('serves the annual snapshot while a weekly provider backfill holds the mutation queue', async () => {
    const annualDates = dates('anio');
    const cache = cacheForDates(annualDates);
    delete cache.peninsular[dates('semana').at(-1)];
    await saveCache(cache);

    let providerCalls = 0;
    let releaseProvider;
    let markProviderStarted;
    const originalApiTemplate = process.env.APIREDTADAURI;
    process.env.APIREDTADAURI = 'https://provider.test/prices?start_date=old&end_date=old';
    const providerStarted = new Promise(resolve => { markProviderStarted = resolve; });
    axios.get = async () => {
      providerCalls += 1;
      markProviderStarted();
      return new Promise(resolve => {
        releaseProvider = () => resolve({ data: { included: [] } });
      });
    };

    const weeklyBackfill = historico.getHistorico('semana');
    await providerStarted;

    let timeout;
    try {
      const annual = await Promise.race([
        historico.getHistoricoResult('anio', 'peninsular'),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 100); })
      ]);

      assert.notEqual(annual, null, 'annual read waited behind the provider backfill');
      assert.equal(annual.partial, true);
      assert.equal(annual.metadata.availableDays, 364);
      assert.equal(providerCalls, 1);
    } finally {
      clearTimeout(timeout);
      releaseProvider();
      await weeklyBackfill;
      if (originalApiTemplate === undefined) delete process.env.APIREDTADAURI;
      else process.env.APIREDTADAURI = originalApiTemplate;
    }
  });

  it('keeps week and month shapes unchanged when their cache is complete', async () => {
    const allDates = [...new Set([...dates('mes'), ...dates('semana')])];
    await saveCache(cacheForDates(allDates));
    let providerCalls = 0;
    axios.get = async () => {
      providerCalls += 1;
      throw new Error('provider must not be called for complete cache');
    };

    const week = await historico.getHistorico('semana');
    const month = await historico.getHistorico('mes');

    assert.equal(week.length, 7);
    assert.equal(month.length, 30);
    assert.ok([...week, ...month].every(value => Number.isFinite(value.media)));
    assert.equal(providerCalls, 0);
  });

  it('writes valid JSON atomically under concurrent in-process writes', async () => {
    await saveCache({ peninsular: { previous: day('2024-01-01', 7) } });
    const writes = Array.from({ length: 20 }, (_, index) => historico.writeCache({ peninsular: { value: index } }));
    await Promise.all(writes);

    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    assert.equal(persisted.peninsular.value, 19);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(`${cacheFile}.bak`, 'utf8')));
    const leftovers = (await fsp.readdir(temporaryDirectory)).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('recovers from a valid backup while preserving corrupt primary bytes', async () => {
    const annualDates = dates('anio');
    await fsp.writeFile(`${cacheFile}.bak`, JSON.stringify(cacheForDates(annualDates.slice(0, 2))), 'utf8');
    await fsp.writeFile(cacheFile, '{broken', 'utf8');
    const beforeHash = digest(cacheFile);

    const result = await historico.getHistoricoResult('anio');

    assert.equal(result.metadata.availableDays, 2);
    assert.equal(digest(cacheFile), beforeHash);
    assert.equal(await fsp.readFile(cacheFile, 'utf8'), '{broken');
  });

  it('recovers from a valid seed while preserving corrupt primary bytes', async () => {
    const annualDates = dates('anio');
    await fsp.rm(`${cacheFile}.bak`, { force: true });
    await fsp.writeFile(seedFile, JSON.stringify(cacheForDates(annualDates.slice(0, 1))), 'utf8');
    await fsp.writeFile(cacheFile, '{broken-seed-fallback', 'utf8');
    const beforeHash = digest(cacheFile);

    const result = await historico.getHistoricoResult('anio');

    assert.equal(result.metadata.availableDays, 1);
    assert.equal(digest(cacheFile), beforeHash);
  });

  it('quarantines corrupt primary bytes before a future atomic write', async () => {
    await fsp.writeFile(`${cacheFile}.bak`, JSON.stringify({ peninsular: { safe: day('2024-01-01', 5) } }), 'utf8');
    await fsp.writeFile(cacheFile, '{corrupt-before-write', 'utf8');

    await historico.writeCache({ peninsular: { current: day('2024-01-02', 6) } });

    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    const quarantine = (await fsp.readdir(temporaryDirectory)).find(name => name.startsWith('historico-cache.json.corrupt.'));
    assert.equal(persisted.peninsular.current.media, 6);
    assert.ok(quarantine);
    assert.equal(await fsp.readFile(path.join(temporaryDirectory, quarantine), 'utf8'), '{corrupt-before-write');
    assert.equal(JSON.parse(await fsp.readFile(`${cacheFile}.bak`, 'utf8')).peninsular.safe.media, 5);
  });

  it('fails explicitly when corrupt cache has no valid recovery source', async () => {
    await fsp.rm(`${cacheFile}.bak`, { force: true });
    await fsp.writeFile(seedFile, '{broken-seed', 'utf8');
    await fsp.writeFile(cacheFile, '{broken-primary', 'utf8');

    await assert.rejects(() => historico.getHistoricoResult('anio'), { code: 'HISTORICO_CACHE_CORRUPT' });
    assert.equal(await fsp.readFile(cacheFile, 'utf8'), '{broken-primary');
  });

  it('bounds provider calls and duration, then persists cooldown for missing days', async () => {
    await fsp.writeFile(seedFile, '{}', 'utf8');
    await saveCache({});
    let providerCalls = 0;
    axios.get = (_url, options) => {
      providerCalls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
      });
    };
    const startedAt = Date.now();

    const values = await historico.getHistorico('mes');

    assert.equal(values.length, 30);
    assert.ok(values.every(value => value.media === null));
    assert.ok(providerCalls <= 2);
    assert.ok(Date.now() - startedAt < 500);
    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    assert.equal(Object.keys(persisted._retry.peninsular).length, 30);
  });

  it('does not call the provider again within cooldown', async () => {
    let providerCalls = 0;
    axios.get = async () => {
      providerCalls += 1;
      throw new Error('provider should be cooling down');
    };

    const values = await historico.getHistorico('mes');

    assert.equal(values.length, 30);
    assert.equal(providerCalls, 0);
  });

  it('allows another bounded retry after cooldown expires', async () => {
    const cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    for (const retry of Object.values(cache._retry.peninsular)) retry.retryAfter = 0;
    await saveCache(cache);
    let providerCalls = 0;
    axios.get = async () => {
      providerCalls += 1;
      throw Object.assign(new Error('provider down'), { code: 'ECONNRESET' });
    };

    await historico.getHistorico('mes');

    assert.ok(providerCalls > 0);
    assert.ok(providerCalls <= 2);
  });
});
