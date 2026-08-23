// Cron job to update historico cache once per day after 20:15 (Europe/Madrid)
// Requires `node-cron` (install with `pnpm add node-cron`) and that the app is run with the same NODE_ENV/.env

try {
  const cron = require('node-cron');
  const { ensureDaysCached } = require('./services/historico');
  const { DateTime } = require('luxon');

  // Run once a day at 20:20 Madrid time
  cron.schedule('20 20 * * *', async () => {
    try {
      console.log('cron-historico: running daily cache update');
      // ensure last 30 days are cached as a safety net
      const tz = 'Europe/Madrid';
      const recent = [];
      for (let i = 0; i < 30; i++) recent.push(DateTime.now().setZone(tz).minus({ days: i }).toISODate());
      await ensureDaysCached(recent);
      console.log('cron-historico: cache update finished');
    } catch (err) {
      console.error('cron-historico: failed', err);
    }
  }, {
    timezone: 'Europe/Madrid'
  });

  console.log('cron-historico: scheduled (20:20 Europe/Madrid)');
} catch (err) {
  console.error('cron-historico: node-cron not installed. Install with `pnpm add node-cron` to enable scheduled caching.');
}
