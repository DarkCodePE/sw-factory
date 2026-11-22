import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record, tokenCount, usd } from './inference-usage.ts';
import { isRunnerName } from './runners/name.ts';
import type { OriginSource } from './store.ts';
import type { Role } from './profile.ts';

export const MICRO_USD_PER_USD = 1_000_000;
export const DEFAULT_MILLI_CREDITS_PER_USD = 100_000;
const MS_PER_HOUR = 3_600_000n;
const MAX_MICRO = BigInt(Number.MAX_SAFE_INTEGER);

export interface CostRate {
  version: string;
  effectiveFrom: string;
  hourlyMicroUsd: number | null;
  platformMicroUsd: number;
}

const defaultRate = {
  version: 'c2-v1', effectiveFrom: '1970-01-01T00:00:00.000Z',
  localHourlyMicroUsd: 0, platformMicroUsd: 0, runnerHourlyMicroUsd: {},
};

function readRate(value: unknown) {
  const rate = record(value);
  const effectiveFrom = rate?.effectiveFrom;
  const version = rate?.version;
  const platformMicroUsd = tokenCount(rate?.platformMicroUsd);
  const localHourlyMicroUsd = tokenCount(rate?.localHourlyMicroUsd);
  const runners = record(rate?.runnerHourlyMicroUsd);
  if (typeof version !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(version) ||
      typeof effectiveFrom !== 'string' || !Number.isFinite(Date.parse(effectiveFrom)) ||
      new Date(effectiveFrom).toISOString() !== effectiveFrom || effectiveFrom <= defaultRate.effectiveFrom ||
      platformMicroUsd === undefined || localHourlyMicroUsd === undefined || !runners) {
    throw new Error('versión de tarifa inválida');
  }
  const runnerHourlyMicroUsd: Record<string, number> = Object.create(null);
  for (const [name, value] of Object.entries(runners)) {
    const hourly = tokenCount(value);
    if (!isRunnerName(name) || hourly === undefined) throw new Error('tarifa de runner inválida');
    runnerHourlyMicroUsd[name] = hourly;
  }
  return { version, effectiveFrom, platformMicroUsd, localHourlyMicroUsd, runnerHourlyMicroUsd };
}

/** Configuración del coordinador. Cada versión es una instantánea completa, seleccionada al lanzar. */
export function costRateAt(stateDir: string | undefined, at: string, sshRunner: string | null): CostRate {
  let raw: string | undefined;
  if (stateDir) {
    try { raw = readFileSync(join(stateDir, 'cost-rates.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let chosen: ReturnType<typeof readRate> = defaultRate;
  if (raw !== undefined) {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('cost-rates.json debe contener un array de versiones');
    const versions = new Set([chosen.version]), dates = new Set([chosen.effectiveFrom]);
    for (const item of parsed) {
      const rate = readRate(item);
      if (versions.has(rate.version) || dates.has(rate.effectiveFrom)) throw new Error('versión o vigencia de tarifa duplicada');
      versions.add(rate.version);
      dates.add(rate.effectiveFrom);
      if (rate.effectiveFrom <= at && rate.effectiveFrom > chosen.effectiveFrom) chosen = rate;
    }
  }
  return {
    version: chosen.version, effectiveFrom: chosen.effectiveFrom, platformMicroUsd: chosen.platformMicroUsd,
    hourlyMicroUsd: sshRunner === null ? chosen.localHourlyMicroUsd :
      Object.hasOwn(chosen.runnerHourlyMicroUsd, sshRunner) ? chosen.runnerHourlyMicroUsd[sshRunner]! : null,
  };
}

export function usdToMicro(value: unknown): number | null {
  const amount = usd(value);
  return amount === undefined ? null : tokenCount(Math.round(amount * MICRO_USD_PER_USD)) ?? null;
}

/** Redondeo de presentación, después de sumar en micro-USD. */
export function microToCents(value: number | null): number | null {
  return value === null ? null : Number((BigInt(value) + 5_000n) / 10_000n);
}

export function computeMicroUsd(hourly: number | null, durationMs: number | undefined): number | null {
  if (hourly === null || tokenCount(durationMs) === undefined) return null;
  const rounded = (BigInt(hourly) * BigInt(durationMs!) + MS_PER_HOUR / 2n) / MS_PER_HOUR;
  return rounded <= MAX_MICRO ? Number(rounded) : null;
}

export interface CostAttemptStart {
  id: string;
  startedAt: string;
  activityId: string;
  changeId: string;
  workstreamId: string;
  adapter: string;
  runner: string | null;
  remote: boolean;
  legacyCount: number;
  rateVersion: string;
  rateEffectiveFrom: string;
  hourlyMicroUsd: number | null;
  platformMicroUsd: number;
}

export interface CostAttempt extends CostAttemptStart {
  attributed: boolean;
  worker: Role | null;
  originActorId: string | null;
  originSource: OriginSource | null;
  prUrl: string | null;
  closedAt: string | null;
  effectiveModel: string | null;
  inferenceMicroUsd: number | null;
  inferenceBasis: 'provider_reported' | 'catalog' | 'runner_declared' | null;
  inferenceVersion: string | null;
  computeDurationMs: number | null;
  computeMicroUsd: number | null;
  totalMicroUsd: number | null;
}

export function completeCost(inference: number | null, compute: number | null, platform: number | null): number | null {
  if (inference === null || compute === null || platform === null) return null;
  return tokenCount(inference + compute + platform) ?? null;
}
