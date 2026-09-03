#!/usr/bin/env node
// CLI: find (and unless --dry-run, repair) flat runs in the samples table.
//   node server/repair-flat.js --dry-run
//   node server/repair-flat.js --since 2026-08-01
// Stop the dashboard first or run it against a copy (DB_PATH=...): SQLite
// handles the concurrent writes, but the live loop's rollup cache does not
// see the deleted daily_stats rows until its next read.
import { repairFlatRuns, SETTING_KEY } from './repair.js';
import * as db from './db.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? Date.parse(args[sinceIdx + 1]) : 0;
if (Number.isNaN(since)) { console.error('bad --since date'); process.exit(2); }

const r = await repairFlatRuns({ since, dryRun });
if (!r.runs.length) console.log('[repair] no flat runs found');
if (!dryRun && r.runs.length) db.setSetting(SETTING_KEY, new Date().toISOString());
