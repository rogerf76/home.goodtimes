'use strict';
// Headless check: scans the configured folders and prints the events it found.
//   npm run scan [-- path/to/settings.yaml]

const { loadConfig } = require('./config');
const { scan } = require('./scanner');
const { groupIntoEvents } = require('./grouping');

(async () => {
  const cfg = loadConfig(process.argv[2]);
  console.log(`settings: ${cfg._file}`);
  const items = await scan(cfg, (p) => p.phase !== 'done' && console.log(p));
  const events = groupIntoEvents(items, cfg);
  const fmt = (t) => new Date(t).toLocaleString();
  for (const ev of events) {
    const loc = ev.lat != null ? ` @ ${ev.lat.toFixed(3)},${ev.lon.toFixed(3)}` : '';
    const vids = ev.items.filter((i) => i.type === 'video').length;
    const album = ev.album ? `[${ev.album}] ` : '[root] ';
    console.log(`unit ${ev.unit}  #${ev.id}  ${album}${fmt(ev.start)} → ${fmt(ev.end)}  ${ev.items.length} items (${vids} videos)${loc}`);
  }
  const bySource = items.reduce((m, i) => ((m[i.dateSource] = (m[i.dateSource] || 0) + 1), m), {});
  console.log(`\n${items.length} items, ${events.length} events. Date source:`, bySource);
})().catch((e) => { console.error(e.message); process.exit(1); });
