#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const output = resolve(process.cwd(), process.argv[2] ?? '.env.alpha');
let exists = true;
try { await access(output, constants.F_OK); } catch { exists = false; }
if (exists) throw new Error(`${output} already exists; refuse to overwrite an alpha token`);
const password = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('base64url');
const databaseUrl = `postgresql://a11y:${password}@postgres:5432/a11y`;
await writeFile(output, `POSTGRES_USER=a11y\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=${databaseUrl}\nPLAYWRIGHT_WS_TOKEN=${token}\n` , { mode: 0o600 });
console.log(`Wrote fresh local-alpha environment: ${output}`);
