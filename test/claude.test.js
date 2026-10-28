import assert from "node:assert/strict";
import { test } from "node:test";
import { accountEmail, pickOrganization, toReading } from "../src/claude.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0);
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

test("toReading maps the five_hour and seven_day windows", () => {
  const r = toReading({
    five_hour: { utilization: 37, resets_at: iso(NOW + 2 * HOUR) },
    seven_day: { utilization: 22.5, resets_at: iso(NOW + 50 * HOUR) },
    seven_day_opus: null,
  }, NOW);
  assert.deepEqual(r, {
    at: NOW,
    session: { usedPct: 37, resetsAt: NOW + 2 * HOUR },
    weekly: { usedPct: 22.5, resetsAt: NOW + 50 * HOUR },
  });
});

test("a window with no reset time yet is no open window", () => {
  const r = toReading({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 5, resets_at: iso(NOW + HOUR) } }, NOW);
  assert.equal(r.session, null);
  assert.equal(r.weekly.usedPct, 5);
});

test("toReading also accepts the limits array shape and epoch-second resets", () => {
  const r = toReading({ limits: [
    { kind: "five_hour", percent: 10, resets_at: (NOW + HOUR) / 1000 },
    { kind: "seven_day", percent: 40, resets_at: (NOW + 9 * HOUR) / 1000 },
  ] }, NOW);
  assert.deepEqual(r.session, { usedPct: 10, resetsAt: NOW + HOUR });
  assert.deepEqual(r.weekly, { usedPct: 40, resetsAt: NOW + 9 * HOUR });
});

test("toReading rejects responses without limits", () => {
  assert.equal(toReading({ error: "x" }, NOW), null);
  assert.equal(toReading(null, NOW), null);
});

test("pickOrganization prefers the subscription organization", () => {
  const orgs = [
    { uuid: "api", capabilities: ["api"] },
    { uuid: "chat", capabilities: ["chat"] },
    { uuid: "pro", capabilities: ["chat", "claude_pro"] },
  ];
  assert.equal(pickOrganization(orgs).uuid, "pro");
  assert.equal(pickOrganization(orgs.slice(0, 2)).uuid, "chat");
  assert.equal(pickOrganization([]), null);
});

test("accountEmail reads and normalizes the email", () => {
  assert.equal(accountEmail({ email_address: "Me@Example.com" }), "me@example.com");
  assert.equal(accountEmail({ account: { email_address: "a@b.co" } }), "a@b.co");
  assert.equal(accountEmail({}), null);
});
