const fs = require('node:fs');
const path = require('node:path');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '../samples/sample-scan.json'), 'utf8'));
console.log('Seed stub loaded sample scan with findings:', sample.findings.length);
console.log('TODO: insert into Postgres via Prisma client');
