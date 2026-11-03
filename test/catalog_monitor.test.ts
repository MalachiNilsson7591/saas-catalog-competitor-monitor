import assert from "node:assert/strict";
import test from "node:test";
import { CatalogMonitor, DomainError, type InfraiClient } from "../src/catalog_monitor.ts";

function fakeClient(contents: string[]): InfraiClient {
  return {
    web: {
      scrape: async () => ({ content: contents.shift() ?? "$49" }),
    },
    cron: {
      create: async () => ({ job_id: "job_demo_01" }),
    },
  };
}

test("records a baseline, detects a change, then blocks a suspended tenant", async () => {
  const monitor = new CatalogMonitor(fakeClient(["Team plan: $49", "Team plan: $59"]));
  monitor.onboard("tenant-acme");
  monitor.addTarget("tenant-acme", "https://competitor.example/team");

  const baseline = await monitor.check(
    "tenant-acme",
    "https://competitor.example/team",
  );
  assert.equal(baseline.decision, "baseline_recorded");
  assert.equal(baseline.observedAmount, 49);

  const changed = await monitor.check(
    "tenant-acme",
    "https://competitor.example/team",
  );
  assert.equal(changed.decision, "changed");
  assert.equal(changed.previousAmount, 49);
  assert.equal(changed.observedAmount, 59);

  monitor.setAccountState("tenant-acme", "suspended");
  await assert.rejects(
    monitor.check("tenant-acme", "https://competitor.example/team"),
    (error: unknown) =>
      error instanceof DomainError && error.code === "ACCOUNT_NOT_ACTIVE",
  );
});
