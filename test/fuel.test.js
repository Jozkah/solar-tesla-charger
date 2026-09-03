import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let parsePrice, averageType;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-fuel-'));
  process.env.CONFIG_PATH = path.join(dir, 'config.json');
  fs.copyFileSync(path.join(repoRoot, 'config.json.example'), process.env.CONFIG_PATH);
  process.env.DB_PATH = path.join(dir, 'test.db');
  ({ parsePrice, averageType } = await import('../server/fuel.js'));
});

test('parsePrice handles DGEG formats (comma decimal, €/litro, mojibake, junk)', () => {
  assert.ok(Math.abs(parsePrice('2,201 €/litro') - 2.201) < 1e-9);
  assert.ok(Math.abs(parsePrice('1,899 €') - 1.899) < 1e-9);
  assert.ok(Math.abs(parsePrice('2,194 �') - 2.194) < 1e-9); // mojibake euro sign
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice('0,000 €'), null); // zero rejected
});

const row = (fuel, preco, date) => ({ Combustivel: fuel, Preco: preco, DataAtualizacao: date });

test('averageType filters to the fuel label and averages the price', () => {
  const rows = [
    row('Gasolina especial 98', '2,00 €/litro', '2026-07-10 09:00'),
    row('Gasolina especial 98', '2,20 €/litro', '2026-07-14 09:00'),
    row('Gasolina simples 95', '1,80 €/litro', '2026-07-15 09:00'), // ignored
    row('Gasóleo simples', '1,70 €/litro', '2026-07-16 09:00'),      // ignored
  ];
  const avg = averageType(rows, 'Gasolina especial 98');
  assert.equal(avg.n, 2);
  assert.ok(Math.abs(avg.price - 2.10) < 1e-9);
  assert.equal(avg.date, '2026-07-14'); // most recent matched row
});

test('averageType skips unparseable prices', () => {
  const rows = [
    row('Gasolina especial 98', '2,20 €/litro', '2026-07-14'),
    row('Gasolina especial 98', '', '2026-07-15'), // no price -> skipped
  ];
  const avg = averageType(rows, 'Gasolina especial 98');
  assert.equal(avg.n, 1);
  assert.ok(Math.abs(avg.price - 2.20) < 1e-9);
});

test('averageType returns null when no rows match', () => {
  assert.equal(averageType([row('Gasolina simples 95', '1,80 €', '2026-07-14')], 'Gasolina especial 98'), null);
  assert.equal(averageType([], 'Gasolina especial 98'), null);
});
