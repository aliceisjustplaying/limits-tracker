const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Codex derives resets from reset_after_seconds, so the same period's reset time jitters slightly between polls.
const RESET_TOLERANCE_MS = 15 * 60_000;
const MIN_FIT_SPAN_MS = 10 * 60_000;
const MIN_BURN_SPAN_MS = HOUR;

export interface UsageSample {
  observedAt: number;
  usedPercent: number;
  resetsAt: number | null;
}

export interface WindowProjection {
  /** Least-squares slope over the current reset period, in percentage points per hour. */
  percentPerHour: number;
  /** Where the fitted line puts usage at the reset time, capped at 100. */
  projectedAtReset: number | null;
  /** When usage reaches 100% at the current rate, only if that lands before the reset. */
  hitsLimitAt: number | null;
  samples: number;
}

/**
 * The samples belonging to the latest sample's reset period: walk back while the reset
 * time stays the same (within tolerance) and usage never rises going backwards, which
 * would mean a reset happened in between.
 */
export function currentPeriod(samples: UsageSample[]): UsageSample[] {
  const last = samples.at(-1);
  if (!last) return [];
  let start = samples.length - 1;
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i]!;
    const next = samples[i + 1]!;
    if (sample.usedPercent > next.usedPercent) break;
    if (last.resetsAt !== null && sample.resetsAt !== null && Math.abs(sample.resetsAt - last.resetsAt) > RESET_TOLERANCE_MS) break;
    start = i;
  }
  return samples.slice(start);
}

export function linearFit(points: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: meanY - slope * meanX };
}

/** Linear fit of used_percent over the current reset period. Samples must be sorted by time. */
export function projectWindow(samples: UsageSample[]): WindowProjection | null {
  const period = currentPeriod(samples);
  const first = period[0];
  const last = period.at(-1);
  if (!first || !last || last.observedAt - first.observedAt < MIN_FIT_SPAN_MS) return null;
  const fit = linearFit(period.map((s) => ({ x: (s.observedAt - first.observedAt) / HOUR, y: s.usedPercent })));
  if (!fit) return null;
  const percentPerHour = fit.slope;
  const resetsAt = last.resetsAt;

  let projectedAtReset: number | null = null;
  if (resetsAt !== null && resetsAt > last.observedAt) {
    projectedAtReset = Math.min(100, Math.max(last.usedPercent, last.usedPercent + (percentPerHour * (resetsAt - last.observedAt)) / HOUR));
  }

  let hitsLimitAt: number | null = null;
  if (percentPerHour > 0 && last.usedPercent < 100 && resetsAt !== null) {
    const at = last.observedAt + ((100 - last.usedPercent) / percentPerHour) * HOUR;
    if (at < resetsAt) hitsLimitAt = Math.round(at);
  }

  return { percentPerHour, projectedAtReset, hitsLimitAt, samples: period.length };
}

export interface BalanceSample {
  observedAt: number;
  value: number;
}

export interface Burn {
  /** Spend per day: only decreases count, so a top-up doesn't read as negative spend. */
  perDay: number;
  /** Days until the latest balance reaches zero at that rate; null when nothing is being spent. */
  daysLeft: number | null;
}

export function burnRate(samples: BalanceSample[]): Burn | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.observedAt - first.observedAt < MIN_BURN_SPAN_MS) return null;
  let spent = 0;
  for (let i = 1; i < samples.length; i++) {
    spent += Math.max(0, samples[i - 1]!.value - samples[i]!.value);
  }
  const perDay = spent / ((last.observedAt - first.observedAt) / DAY);
  return { perDay, daysLeft: perDay > 0 ? Math.max(0, last.value) / perDay : null };
}

export interface SpendProjection {
  /** Spend per day: the slope over this period's samples once they span an hour, else the period-to-date average. */
  perDay: number;
  /** Where spend lands at the period end at that rate. */
  projectedAtEnd: number;
}

/** Spend is cumulative within a period, so project it forward from the latest value. Samples sorted by time. */
export function projectSpend(samples: BalanceSample[], periodStart: number, periodEnd: number): SpendProjection | null {
  const period = samples.filter((s) => s.observedAt >= periodStart && s.observedAt < periodEnd);
  const first = period[0];
  const last = period.at(-1);
  if (!first || !last || last.observedAt <= periodStart) return null;
  let perDay = last.value / ((last.observedAt - periodStart) / DAY);
  if (last.observedAt - first.observedAt >= MIN_BURN_SPAN_MS) {
    const fit = linearFit(period.map((s) => ({ x: (s.observedAt - first.observedAt) / DAY, y: s.value })));
    if (fit) perDay = Math.max(0, fit.slope);
  }
  return { perDay, projectedAtEnd: last.value + (perDay * (periodEnd - last.observedAt)) / DAY };
}
