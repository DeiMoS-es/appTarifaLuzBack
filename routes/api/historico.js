const express = require('express');
const { normalizeZone } = require('./precios');
const { getHistorico, getHistoricoResult, ensureDaysCached } = require('../../services/historico');

const axios = require('axios');
const { buildProviderUrl } = require('./precios');
const router = express.Router();

function resolveZone(req) {
  const raw = req.query.zone ?? 'peninsular';
  return normalizeZone(raw);
}

// GET /api/historico/semana
router.get('/semana', async (req, res) => {
  try {
    const zone = resolveZone(req);
    const data = await getHistorico('semana', zone.geo_limit);
    return res.status(200).json({ range: 'semana', zone: zone.geo_limit, values: data });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Unsupported zone:')) {
      return res.status(400).json({ error: 'invalid_zone', message: 'zone must be one of peninsular, canarias, baleares, ceuta or melilla' });
    }
    return res.status(500).json({ error: 'historico_error', message: String(err.message || err) });
  }
});

// GET /api/historico/mes
router.get('/mes', async (req, res) => {
  try {
    const zone = resolveZone(req);
    const data = await getHistorico('mes', zone.geo_limit);
    return res.status(200).json({ range: 'mes', zone: zone.geo_limit, values: data });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Unsupported zone:')) {
      return res.status(400).json({ error: 'invalid_zone', message: 'zone must be one of peninsular, canarias, baleares, ceuta or melilla' });
    }
    return res.status(500).json({ error: 'historico_error', message: String(err.message || err) });
  }
});

// GET /api/historico/anio
router.get('/anio', async (req, res) => {
  const startedAt = Date.now();
  try {
    const zone = resolveZone(req);
    const result = await getHistoricoResult('anio', zone.geo_limit);
    console.info(JSON.stringify({ component: 'historico', event: 'annual_response', zone: zone.geo_limit, partial: result.partial, latencyMs: Date.now() - startedAt, ...result.metadata }));
    return res.status(200).json({ range: 'anio', zone: zone.geo_limit, ...result });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Unsupported zone:')) {
      return res.status(400).json({ error: 'invalid_zone', message: 'zone must be one of peninsular, canarias, baleares, ceuta or melilla' });
    }
    console.error(JSON.stringify({ component: 'historico', event: 'annual_failure', latencyMs: Date.now() - startedAt, code: err && err.code }));
    return res.status(500).json({ error: 'historico_error', message: 'Annual historical data is temporarily unavailable.' });
  }
});

// GET /api/historico/week?start=YYYY-MM-DD
// Returns the 7 daily entries starting at 'start' (inclusive)
router.get('/week', async (req, res) => {
  try {
    const zone = resolveZone(req);
    const start = req.query.start;
    if (!start || typeof start !== 'string') return res.status(400).json({ error: 'invalid_start', message: 'start query param required as YYYY-MM-DD' });
    const startDate = start;
    const { DateTime } = require('luxon');
    const tz = 'Europe/Madrid';
    const parsed = DateTime.fromISO(startDate, { zone: tz });
    if (!parsed.isValid) return res.status(400).json({ error: 'invalid_start', message: 'start must be a valid ISO date YYYY-MM-DD' });

    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(parsed.plus({ days: i }).toISODate());

    const cache = await ensureDaysCached(dates, zone.geo_limit);
    const result = dates.map(d => {
      const fromCache = cache[zone.geo_limit]?.[d];
      if (!fromCache) return { fecha: d, media: null, minimo: null, maximo: null };
      return { fecha: fromCache.fecha, media: fromCache.media, minimo: fromCache.minimo, maximo: fromCache.maximo };
    });
    return res.status(200).json({ start: startDate, zone: zone.geo_limit, values: result });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Unsupported zone:')) {
      return res.status(400).json({ error: 'invalid_zone', message: 'zone must be one of peninsular, canarias, baleares, ceuta or melilla' });
    }
    return res.status(500).json({ error: 'historico_error', message: String(err.message || err) });
  }
});

// New helper route: proxy to provider to fetch full-year raw data (today minus 1 year -> today)
// GET /api/historico/provider/anio
router.get('/provider/anio', async (req, res) => {
  try {
    const zone = resolveZone(req);
    const { DateTime } = require('luxon');
    const tz = 'Europe/Madrid';
    const now = DateTime.now().setZone(tz);
    const start = now.minus({ years: 1 }).startOf('day');
    const end = now.endOf('day');

    const day = {
      startsAt: start.toISO({ suppressMilliseconds: true }),
      endsAt: end.toISO({ suppressMilliseconds: true })
    };

    const apiTemplate = process.env.APIREDTADAURI;
    if (!apiTemplate) return res.status(500).json({ error: 'missing_api_template', message: 'APIREDTADAURI not configured in environment' });

    const url = buildProviderUrl(apiTemplate, day, zone.geo_limit);
    // Proxy the provider call and return raw provider payload so you can inspect hourly values for the full year
    const response = await axios.get(url, { timeout: 120000 });
    return res.status(200).json(response.data);
  } catch (err) {
    return res.status(502).json({ error: 'provider_error', message: String(err.message || err) });
  }
});

module.exports = router;
module.exports.createRouter = () => router; // for testability
