// Pure charge-detection helpers — no module state, no imports of any kind.
// Extracted out of controller.js so the "is this car snapshot frozen"
// decision can be unit tested directly, without pulling in server/config.js,
// server/db.js, or the live hardware polling the rest of controller.js
// depends on.

// A car snapshot is FROZEN when it claims to be charging but its energy
// accumulator hasn't advanced for a while — TeslaMate served a stale-but-
// successful response (no API error, so the existing car.stale guard in
// controller.js never sees it). A real charge always increases
// charge_energy_added (kWh added this session), so this can never fire on a
// genuine charge — the accumulator only goes flat when nothing is actually
// being added, which is precisely the phantom condition. Pure — no module
// state; controller.js owns tracking lastChangedAt across fetches.
export function isTelemetryFrozen({ chargingState, chargeEnergyAdded, lastChangedAt, nowMs, freezeMs }) {
  if (chargingState !== 'Charging') return false; // only 'Charging' can be a phantom; 'Starting' exempt
  if (chargeEnergyAdded == null || !lastChangedAt) return false; // no signal -> never flag (fail safe)
  return nowMs - lastChangedAt >= freezeMs;
}
