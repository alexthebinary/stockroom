import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.mjs";

test("config defaults to the local lane, three notes, and a 90-minute implement timeout", () => {
  const cfg = loadConfig({});
  assert.deepEqual({ implLane: cfg.implLane, maxPerRun: cfg.maxPerRun, codex: cfg.timeouts.codex }, {
    implLane: "local", maxPerRun: 3, codex: 5_400_000,
  });
});

test("config selects the Codex lane with five notes and a 30-minute implement timeout", () => {
  const cfg = loadConfig({ AUTO_IMPL_LANE: "codex" });
  assert.deepEqual({ implLane: cfg.implLane, maxPerRun: cfg.maxPerRun, codex: cfg.timeouts.codex }, {
    implLane: "codex", maxPerRun: 5, codex: 1_800_000,
  });
});

for (const lane of ["local", "codex"]) {
  test(`config honors explicit note and timeout overrides in the ${lane} lane`, () => {
    const cfg = loadConfig({ AUTO_IMPL_LANE: lane, AUTO_MAX_PER_RUN: "2", AUTO_CODEX_MIN: "7" });
    assert.equal(cfg.maxPerRun, 2);
    assert.equal(cfg.timeouts.codex, 420_000);
  });
}
