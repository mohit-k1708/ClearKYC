/**
 * Writes sample output files into docs/samples/ from the RUNNING API (npm run dev): the analytics overview as JSON and short
 * excerpts (header + first rows) of each CSV export. Used to produce the examples quoted in docs/SCENE5.md.
 *
 *   node scripts/writeSceneSamples.js [--rows=6]
 *
 * It exports as the demo compliance reviewer, so the exports are recorded in the audit trail like any other. Run
 * `npm run generate:scene5 -- --reset` afterwards to remove those export events from a demo database.
 */
require('../server/src/config/env');
const fs = require('fs');
const path = require('path');
const prisma = require('../server/src/utils/prisma');

const API = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}/api`;
const rows = Number((process.argv.find((a) => a.startsWith('--rows=')) || '--rows=6').split('=')[1]);
const dir = path.join(__dirname, '..', 'docs', 'samples');

async function main() {
  fs.mkdirSync(dir, { recursive: true });
  const reviewer = await prisma.reviewer.findUnique({ where: { email: 'asha.reviewer@example.com' } });
  if (!reviewer) throw new Error('The demo reviewer does not exist. Run the generators first.');
  const headers = { 'x-reviewer-id': String(reviewer.id) };

  const overview = await (await fetch(`${API}/analytics/overview?range=all`)).json();
  fs.writeFileSync(path.join(dir, 'analytics-overview.json'), `${JSON.stringify(overview.data, null, 2)}\n`);

  for (const key of ['customers', 'documents', 'completeness', 'risks', 'ownership', 'review-cases', 'alerts', 'audit-events']) {
    const res = await fetch(`${API}/exports/${key}`, { headers });
    if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
    const lines = (await res.text()).split('\r\n').filter(Boolean);
    fs.writeFileSync(path.join(dir, `${key}-sample.csv`), `${lines.slice(0, rows + 1).join('\r\n')}\r\n`);
    console.log(`${key}: ${lines.length - 1} rows exported, ${Math.min(rows, lines.length - 1)} written to docs/samples/${key}-sample.csv`);
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
