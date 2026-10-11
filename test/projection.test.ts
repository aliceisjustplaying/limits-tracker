import { expect, test } from "bun:test";
import { burnRate, currentPeriod, linearFit, projectWindow, type UsageSample } from "../src/projection.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-10-11T00:00:00Z");
const sample = (hours: number, usedPercent: number, resetsAt: number | null = T0 + 5 * H): UsageSample => ({
  observedAt: T0 + hours * H,
  usedPercent,
  resetsAt,
});

test("linearFit recovers an exact line and rejects degenerate input", () => {
  const fit = linearFit([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
  expect(fit?.slope).toBeCloseTo(2);
  expect(fit?.intercept).toBeCloseTo(1);
  expect(linearFit([{ x: 0, y: 1 }])).toBeNull();
  expect(linearFit([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBeNull();
});

test("currentPeriod stops at a usage drop (a reset between polls)", () => {
  const samples = [sample(-3, 80, T0), sample(-2, 95, T0), sample(0, 5), sample(1, 20)];
  expect(currentPeriod(samples)).toEqual([sample(0, 5), sample(1, 20)]);
});

test("currentPeriod stops when the reset time changes, but tolerates jitter", () => {
  const jitter = T0 + 5 * H + 30_000;
  const samples = [sample(-1, 0, T0 + 10 * H), sample(0, 10, jitter), sample(1, 20)];
  expect(currentPeriod(samples)).toEqual([sample(0, 10, jitter), sample(1, 20)]);
  expect(currentPeriod([])).toEqual([]);
});

test("projects time to 100% when it lands before the reset", () => {
  // 10%/h from 10% at t=0; reset at t=12h -> 100% at t=9h.
  const samples = [0, 1, 2, 3].map((h) => sample(h, 10 + 10 * h, T0 + 12 * H));
  const projection = projectWindow(samples)!;
  expect(projection.percentPerHour).toBeCloseTo(10);
  expect(projection.hitsLimitAt).toBe(T0 + 9 * H);
  expect(projection.projectedAtReset).toBe(100);
  expect(projection.samples).toBe(4);
});

test("no time to 100% when the reset comes first", () => {
  // 5%/h from 10%; reset at t=5h -> 35% at reset, never reaches 100.
  const samples = [0, 1].map((h) => sample(h, 10 + 5 * h));
  const projection = projectWindow(samples)!;
  expect(projection.hitsLimitAt).toBeNull();
  expect(projection.projectedAtReset).toBeCloseTo(35);
});

test("flat or falling usage never projects a limit hit", () => {
  expect(projectWindow([sample(0, 40), sample(1, 40)])!.hitsLimitAt).toBeNull();
  expect(projectWindow([sample(0, 40), sample(1, 40)])!.projectedAtReset).toBe(40);
});

test("no hit time without a known reset; too little data gives no projection", () => {
  const unknownReset = projectWindow([sample(0, 10, null), sample(1, 50, null)])!;
  expect(unknownReset.hitsLimitAt).toBeNull();
  expect(unknownReset.projectedAtReset).toBeNull();
  expect(projectWindow([sample(0, 10)])).toBeNull();
  expect(projectWindow([sample(0, 10), sample(0.1, 12)])).toBeNull();
});

test("an already-full window has no hit time", () => {
  expect(projectWindow([sample(0, 90), sample(1, 100)])!.hitsLimitAt).toBeNull();
});

test("burn counts only decreases, so top-ups don't hide spend", () => {
  const day = 24 * H;
  const burn = burnRate([
    { observedAt: T0, value: 100 },
    { observedAt: T0 + day / 2, value: 90 },
    { observedAt: T0 + day / 2 + H, value: 140 },
    { observedAt: T0 + 2 * day, value: 120 },
  ])!;
  expect(burn.perDay).toBeCloseTo(15);
  expect(burn.daysLeft).toBeCloseTo(8);
});

test("burn needs an hour of data; zero spend has no runway", () => {
  expect(burnRate([{ observedAt: T0, value: 10 }, { observedAt: T0 + 60_000, value: 9 }])).toBeNull();
  expect(burnRate([{ observedAt: T0, value: 10 }, { observedAt: T0 + 2 * H, value: 10 }])).toEqual({ perDay: 0, daysLeft: null });
});
