// ── DVR scheduling ─────────────────────────────────────────────────────────
// One-off recordings are "jobs" (`/dvr/jobs`); season passes are "rules"
// (`/dvr/rules`), matched on SeriesID. Both are created with a `/new` POST and
// removed with a DELETE on the id.
//
// Channels DVR does NOT pad manually-created jobs, so padding is applied
// client-side to match how rule-created jobs behave.
//
// `PUT /dvr/rules/<id>` replaces the whole rule rather than merging, so edits
// must send every field back — see `updateSeriesRule`.

import request, { requestWithMethod } from './client';
import type { Airing } from './guide';

export interface ScheduledJob {
  id: string;
  name: string;
  /** Job start, which already includes any start padding. */
  time: number;
  duration: number;
  channels: string[];
  ruleId: string;
  /** Airing start as broadcast — the value that matches a guide airing. */
  airingTime: number;
  programId: string;
  seriesId: string;
}

export interface SeriesRule {
  id: string;
  name: string;
  seriesId: string;
  newOnly: boolean;
  keepNum: number;
  paddingStart: number;
  paddingEnd: number;
  duplicates: boolean;
  rerecord: boolean;
  paused: boolean;
  priority: number;
  numJobs: number;
}

export interface SchedulePadding {
  start: number;
  end: number;
}

export interface RecordOptions {
  paddingStart: number;
  paddingEnd: number;
}

export type SeriesPassOptions = Omit<SeriesRule, 'id' | 'seriesId' | 'name' | 'numJobs'>;

/** Jobs and rules keyed for O(1) lookup while rendering the grid. */
export interface ScheduleState {
  jobsByAiring: Map<string, ScheduledJob>;
  ruleBySeries: Map<string, SeriesRule>;
  padding: SchedulePadding;
}

export const EMPTY_SCHEDULE: ScheduleState = {
  jobsByAiring: new Map(),
  ruleBySeries: new Map(),
  padding: { start: 0, end: 0 },
};

/**
 * Key a scheduled recording to the airing it covers. Job start is padded, so
 * the airing's own start (`job.Airing.Time`) is what lines up with the guide.
 */
export function airingScheduleKey(channelNumber: string, airingStart: number): string {
  return `${(channelNumber || '').trim().toLowerCase()}|${airingStart}`;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRule(raw: Record<string, unknown>): SeriesRule {
  const eq = (raw.EQ ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.ID ?? ''),
    name: String(raw.Name ?? ''),
    seriesId: String(eq.SeriesID ?? ''),
    newOnly: String(eq.Tags ?? '').toLowerCase() === 'new',
    keepNum: toNumber(raw.KeepNum),
    paddingStart: toNumber(raw.PaddingStart),
    paddingEnd: toNumber(raw.PaddingEnd),
    duplicates: Boolean(raw.Duplicates),
    rerecord: Boolean(raw.Rerecord),
    paused: Boolean(raw.Paused),
    priority: toNumber(raw.Priority),
    numJobs: toNumber(raw.NumJobs),
  };
}

/** The wire shape for a rule. Every field is sent so PUT does not clear any. */
function ruleToPayload(name: string, seriesId: string, options: SeriesPassOptions) {
  return {
    Name: name,
    EQ: options.newOnly ? { SeriesID: seriesId, Tags: 'New' } : { SeriesID: seriesId },
    KeepNum: options.keepNum,
    PaddingStart: options.paddingStart,
    PaddingEnd: options.paddingEnd,
    Duplicates: options.duplicates,
    Rerecord: options.rerecord,
    Paused: options.paused,
    Priority: options.priority,
  };
}

export async function fetchJobs(): Promise<ScheduledJob[]> {
  try {
    const data = await request<unknown>('/dvr/jobs');
    if (!Array.isArray(data)) return [];
    return data
      .filter((j): j is Record<string, unknown> => Boolean(j) && typeof j === 'object')
      .map((j) => {
        const airing = (j.Airing ?? {}) as Record<string, unknown>;
        return {
          id: String(j.ID ?? ''),
          name: String(j.Name ?? ''),
          time: toNumber(j.Time),
          duration: toNumber(j.Duration),
          channels: Array.isArray(j.Channels) ? j.Channels.map((c) => String(c)) : [],
          ruleId: String(j.RuleID ?? ''),
          airingTime: toNumber(airing.Time, toNumber(j.Time)),
          programId: String(airing.ProgramID ?? ''),
          seriesId: String(airing.SeriesID ?? ''),
        };
      })
      .filter((j) => j.id);
  } catch {
    return [];
  }
}

export async function fetchRules(): Promise<SeriesRule[]> {
  try {
    const data = await request<unknown>('/dvr/rules');
    if (!Array.isArray(data)) return [];
    return data
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map(normalizeRule)
      .filter((r) => r.id && r.seriesId);
  } catch {
    return [];
  }
}

/** Server-configured recording padding, in seconds — the default for new jobs. */
export async function fetchPadding(): Promise<SchedulePadding> {
  try {
    const status = await request<Record<string, unknown>>('/dvr');
    const padding = (status.padding ?? {}) as Record<string, unknown>;
    return { start: toNumber(padding.start), end: toNumber(padding.end) };
  } catch {
    return { start: 0, end: 0 };
  }
}

export async function fetchSchedule(): Promise<ScheduleState> {
  const [jobs, rules, padding] = await Promise.all([fetchJobs(), fetchRules(), fetchPadding()]);

  const jobsByAiring = new Map<string, ScheduledJob>();
  for (const job of jobs) {
    for (const channel of job.channels) {
      jobsByAiring.set(airingScheduleKey(channel, job.airingTime), job);
    }
  }

  const ruleBySeries = new Map<string, SeriesRule>();
  for (const rule of rules) ruleBySeries.set(rule.seriesId, rule);

  return { jobsByAiring, ruleBySeries, padding };
}

/** Schedule a single airing with explicit padding. */
export async function recordAiring(airing: Airing, options: RecordOptions): Promise<ScheduledJob> {
  const created = await requestWithMethod<Record<string, unknown>>('/dvr/jobs/new', 'POST', {
    Name: airing.title,
    Time: airing.start - options.paddingStart,
    Duration: airing.duration + options.paddingStart + options.paddingEnd,
    Channels: [airing.channelNumber],
    Airing: airing.raw,
  });

  return {
    id: String(created.ID ?? ''),
    name: String(created.Name ?? airing.title),
    time: toNumber(created.Time, airing.start),
    duration: toNumber(created.Duration, airing.duration),
    channels: Array.isArray(created.Channels)
      ? created.Channels.map((c) => String(c))
      : [airing.channelNumber],
    ruleId: String(created.RuleID ?? ''),
    airingTime: airing.start,
    programId: airing.programId,
    seriesId: airing.seriesId,
  };
}

export async function cancelJob(jobId: string): Promise<void> {
  await requestWithMethod(`/dvr/jobs/${encodeURIComponent(jobId)}`, 'DELETE');
}

/** Create a season pass for the airing's series. */
export async function recordSeries(airing: Airing, options: SeriesPassOptions): Promise<SeriesRule> {
  const created = await requestWithMethod<Record<string, unknown>>(
    '/dvr/rules/new',
    'POST',
    ruleToPayload(airing.title, airing.seriesId, options)
  );
  return normalizeRule(created);
}

/** Replace an existing pass. PUT is a full replace, so send every field. */
export async function updateSeriesRule(
  rule: SeriesRule,
  options: SeriesPassOptions
): Promise<SeriesRule> {
  const updated = await requestWithMethod<Record<string, unknown>>(
    `/dvr/rules/${encodeURIComponent(rule.id)}`,
    'PUT',
    ruleToPayload(rule.name, rule.seriesId, options)
  );
  return normalizeRule(updated);
}

export async function cancelSeries(ruleId: string): Promise<void> {
  await requestWithMethod(`/dvr/rules/${encodeURIComponent(ruleId)}`, 'DELETE');
}
