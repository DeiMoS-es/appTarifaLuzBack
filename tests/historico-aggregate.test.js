const { groupByDate, aggregateDay } = require('../services/historico');
const { normalizeZone } = require('../routes/api/precios');
const { DateTime } = require('luxon');

// Minimal test for aggregation logic
const makeHourly = (date) => {
  const zone = 'Europe/Madrid';
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  const values = [];
  for (let h = 0; h < 24; h++) {
    const dt = start.plus({ hours: h });
    values.push({
      startsAt: dt.toISO({ suppressMilliseconds: true }),
      instant: dt.toUTC().toISO({ suppressMilliseconds: true }),
      utcOffsetMinutes: dt.offset,
      valueEurMWh: h // increasing values 0..23
    });
  }
  return values;
};

const date = DateTime.now().setZone('Europe/Madrid').minus({ days: 2 }).toISODate();
const hourly = makeHourly(date);
const grouped = groupByDate(hourly);
if (!Array.isArray(grouped) || grouped.length !== 1) throw new Error('expected 1 grouped day');
const agg = grouped[0];
if (Math.abs(agg.media - (0+23)/2) > 1e-6) throw new Error('unexpected average');
if (agg.minimo !== 0 || agg.maximo !== 23) throw new Error('unexpected min/max');
const zone = normalizeZone('canarias');
if (zone.geo_limit !== 'canarias' || zone.geo_ids !== '8742') throw new Error('unexpected canarias zone mapping');
console.log('historico aggregation test passed');
