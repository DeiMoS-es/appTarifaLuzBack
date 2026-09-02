const express = require('express');
const { normalizeZone } = require('./precios');
const { getHistorico, ensureDaysCached } = require('../../services/historico');

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
  try {
    const zone = resolveZone(req);
    const data = await getHistorico('anio', zone.geo_limit);
    return res.status(200).json({ range: 'anio', zone: zone.geo_limit, values: data });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Unsupported zone:')) {
      return res.status(400).json({ error: 'invalid_zone', message: 'zone must be one of peninsular, canarias, baleares, ceuta or melilla' });
    }
    return res.status(500).json({ error: 'historico_error', message: String(err.message || err) });
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

module.exports = router;
module.exports.createRouter = () => router; // for testability
