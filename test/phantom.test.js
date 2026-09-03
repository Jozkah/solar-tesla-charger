// Regression test for the "10k phantom charge" bug: when TeslaMate serves a
// SUCCESSFUL but FROZEN chargingState:'Charging' snapshot (no API error, so
// car.stale never gets set), controller.js used to fall back to
// computeChargeW(car, voltage) — the car's chargerActualCurrent * voltage,
// ~10 kW — even though nothing was actually flowing. The existing stale-vote
// guard only fires on an API error and so misses this exact case.
//
// v1/v2 of this fix used an indirect meter-based inference (grid import vs.
// solar). An adversarial review found that approach fundamentally could not
// honor "a real charge must ALWAYS show as charging": during an ACTIVE solar
// charge the controller itself drives exportW toward ~0 (the car eats the
// surplus), which defeated the export guard exactly when a real charge was
// happening, and a lagging SolaX reading could still make a real morning
// charge look like grid import. The meter is an indirect inference over
// laggy/circular signals — replaced with a DIRECT root-cause detector below.
//
// isTelemetryFrozen (server/charge-detect.js) checks the car's own energy
// accumulator, charge_energy_added (kWh), which strictly increases during
// any real charge (TeslaMateApi-reported, see tesla.js). If it's flat for
// minutes while chargingState='Charging', the telemetry — not the charge —
// is what stopped. This can never misfire on a genuine charge: the
// accumulator has no dependency on solar, exporting, or anything the
// controller itself influences. It's pure and imports nothing, so it's
// tested directly here — no config.js/db.js/network mocking required for the
// core logic (see the bottom of this file for why a full controlCycle()-
// level integration test was not attempted).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTelemetryFrozen } from '../server/charge-detect.js';

test('LOAD-BEARING: real charge (energy accumulator advanced recently) is never frozen (false)', () => {
  // The hard constraint this test exists to prove: as long as
  // charge_energy_added is moving, isTelemetryFrozen must never fire,
  // regardless of how long ago the session started or what the meters read.
  const nowMs = 1_000_000;
  const result = isTelemetryFrozen({
    chargingState: 'Charging', chargeEnergyAdded: 12.4, lastChangedAt: nowMs - 30_000, nowMs, freezeMs: 5 * 60_000,
  });
  assert.equal(result, false);
});

test('phantom: chargingState Charging, energy accumulator flat past freezeMs — frozen (true)', () => {
  const nowMs = 1_000_000;
  const result = isTelemetryFrozen({
    chargingState: 'Charging', chargeEnergyAdded: 12.4, lastChangedAt: nowMs - 5 * 60_000 - 1, nowMs, freezeMs: 5 * 60_000,
  });
  assert.equal(result, true);
});

test('just-started: lastChangedAt very recent — not frozen (false)', () => {
  const nowMs = 1_000_000;
  const result = isTelemetryFrozen({
    chargingState: 'Charging', chargeEnergyAdded: 0.1, lastChangedAt: nowMs - 1_000, nowMs, freezeMs: 5 * 60_000,
  });
  assert.equal(result, false);
});

test('not charging: chargingState Stopped — never frozen (false) regardless of accumulator age', () => {
  const nowMs = 1_000_000;
  const result = isTelemetryFrozen({
    chargingState: 'Stopped', chargeEnergyAdded: 12.4, lastChangedAt: nowMs - 60 * 60_000, nowMs, freezeMs: 5 * 60_000,
  });
  assert.equal(result, false);
});

test('no signal: chargeEnergyAdded null — fail safe, never flag (false)', () => {
  const nowMs = 1_000_000;
  const result = isTelemetryFrozen({
    chargingState: 'Charging', chargeEnergyAdded: null, lastChangedAt: nowMs - 60 * 60_000, nowMs, freezeMs: 5 * 60_000,
  });
  assert.equal(result, false);
});

test('boundary: exactly freezeMs elapsed — frozen (true)', () => {
  const nowMs = 1_000_000;
  const result = isTelemetryFrozen({
    chargingState: 'Charging', chargeEnergyAdded: 12.4, lastChangedAt: nowMs - 5 * 60_000, nowMs, freezeMs: 5 * 60_000,
  });
  assert.equal(result, true);
});

// An integration-style test exercising computeDecision()/controlCycle() end
// to end (as retention.test.js does for stats.js via CONFIG_PATH/DB_PATH)
// was considered but not implemented: computeDecision is intentionally not
// exported (the task spec calls this out explicitly), and controlCycle()
// reaches through shelly.readMeters(), wallconnector.readVitals(), and
// tesla.getVehicleData() — all real outbound HTTP calls with no dependency
// injection or mocking seam in this codebase. Standing up a real Shelly/WC/
// Tesla double, or exporting computeDecision purely to make it testable,
// was judged out of scope for a minimal, surgical safety fix — especially
// since state mutated across carCycle() fetches (lastChargeEnergyAdded,
// chargeEnergyAddedAt) is module-private and would leak between test runs
// without a reset hook that doesn't currently exist. The pure-helper tests
// above cover the instantaneous decision; the wiring around it in
// controller.js (tracking the accumulator in carCycle, routing `frozen`
// through the existing carState guard) is a direct structural mirror of the
// pre-existing, already-tested car.stale handling.
