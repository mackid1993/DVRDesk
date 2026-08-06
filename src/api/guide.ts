// ── Guide (EPG) ────────────────────────────────────────────────────────────
// Channels DVR exposes airings per capture device (`/devices/<id>/guide`) and
// user-defined channel collections (`/dvr/collections/channels`). This module
// normalizes both into shapes the Live page can render directly.

import request from './client';

export interface ChannelCollection {
  slug: string;
  name: string;
  items: string[];
}

export interface Airing {
  id: string;
  start: number;
  end: number;
  duration: number;
  title: string;
  episodeTitle: string;
  summary: string;
  image: string;
  seasonNumber?: number;
  episodeNumber?: number;
  releaseYear?: number;
  contentRating: string;
  isNew: boolean;
  isLive: boolean;
  isMovie: boolean;
  isSports: boolean;
  /** Channel number this airing came from — needed to schedule a recording. */
  channelNumber: string;
  seriesId: string;
  programId: string;
  /**
   * The untouched server payload. `POST /dvr/jobs/new` wants the airing echoed
   * back verbatim, so this is kept by reference (no extra memory) rather than
   * rebuilt from the normalized fields.
   */
  raw: unknown;
}

export interface GuideData {
  /** Airings keyed by `sourceId|number` plus a bare `number` fallback. */
  byChannel: Map<string, Airing[]>;
  start: number;
  end: number;
}

/** Raw airing as returned by `/devices/<id>/guide`. */
interface RawAiring {
  Time?: number;
  Duration?: number;
  Title?: string;
  EpisodeTitle?: string;
  Summary?: string;
  Image?: string;
  Categories?: string[];
  Tags?: string[];
  SeasonNumber?: number;
  EpisodeNumber?: number;
  ReleaseYear?: number;
  ContentRating?: string;
  ProgramID?: string;
  SeriesID?: string;
  Channel?: string;
}

interface RawGuideEntry {
  Channel?: { Number?: string; ID?: string; DeviceID?: string };
  Airings?: RawAiring[];
}

export const GUIDE_WINDOW_SECONDS = 3 * 60 * 60;

/**
 * Channel lookup keys, most specific first. A number may exist on more than one
 * source (e.g. `11` on an M3U provider and `11.1` over the air), so the
 * source-qualified key wins when present.
 */
export function guideChannelKeys(
  sourceId: string | undefined,
  number: string | undefined,
  id: string | undefined
): string[] {
  const keys: string[] = [];
  const source = (sourceId || '').trim().toLowerCase();
  for (const raw of [number, id]) {
    const value = (raw || '').trim().toLowerCase();
    if (!value) continue;
    if (source) keys.push(`${source}|${value}`);
    keys.push(value);
  }
  return Array.from(new Set(keys));
}

export async function fetchChannelCollections(): Promise<ChannelCollection[]> {
  try {
    const data = await request<unknown>('/dvr/collections/channels');
    if (!Array.isArray(data)) return [];
    return data
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        slug: String(entry.slug ?? '').trim(),
        name: String(entry.name ?? '').trim(),
        items: Array.isArray(entry.items) ? entry.items.map((i) => String(i).trim()).filter(Boolean) : [],
      }))
      .filter((entry) => entry.slug && entry.name && entry.items.length > 0);
  } catch {
    // Older servers may not expose collections — the page falls back to sources.
    return [];
  }
}

function normalizeAiring(
  raw: RawAiring,
  index: number,
  channelKey: string,
  channelNumber: string
): Airing | null {
  const start = Number(raw.Time);
  const duration = Number(raw.Duration);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;

  const categories = (raw.Categories ?? []).map((c) => c.toLowerCase());
  const tags = (raw.Tags ?? []).map((t) => t.toLowerCase());

  return {
    id: `${channelKey}|${start}|${raw.ProgramID ?? index}`,
    start,
    end: start + duration,
    duration,
    title: (raw.Title ?? '').trim() || 'No Program Data',
    episodeTitle: (raw.EpisodeTitle ?? '').trim(),
    summary: (raw.Summary ?? '').trim(),
    image: (raw.Image ?? '').trim(),
    ...(Number.isFinite(Number(raw.SeasonNumber)) ? { seasonNumber: Number(raw.SeasonNumber) } : {}),
    ...(Number.isFinite(Number(raw.EpisodeNumber)) ? { episodeNumber: Number(raw.EpisodeNumber) } : {}),
    ...(Number.isFinite(Number(raw.ReleaseYear)) ? { releaseYear: Number(raw.ReleaseYear) } : {}),
    contentRating: (raw.ContentRating ?? '').trim(),
    isNew: tags.includes('new') || tags.includes('premiere') || tags.includes('series premiere'),
    isLive: tags.includes('live'),
    isMovie: categories.some((c) => c.includes('movie') || c.includes('feature film')),
    isSports: categories.some((c) => c.includes('sports')),
    channelNumber: (raw.Channel ?? channelNumber ?? '').trim(),
    seriesId: (raw.SeriesID ?? '').trim(),
    programId: (raw.ProgramID ?? '').trim(),
    raw,
  };
}

/**
 * Fetch airings covering `[start, start + durationSeconds)` for every device.
 * A device that errors is skipped so one bad source cannot blank the guide.
 */
export async function fetchGuide(
  deviceIds: string[],
  start: number,
  durationSeconds: number = GUIDE_WINDOW_SECONDS
): Promise<GuideData> {
  const byChannel = new Map<string, Airing[]>();
  const end = start + durationSeconds;
  const uniqueDevices = Array.from(new Set(deviceIds.map((d) => (d || '').trim()).filter(Boolean)));

  const responses = await Promise.all(
    uniqueDevices.map(async (deviceId) => {
      try {
        const data = await request<unknown>(`/devices/${encodeURIComponent(deviceId)}/guide`, {
          time: String(Math.floor(start)),
          duration: String(Math.floor(durationSeconds)),
        });
        return Array.isArray(data) ? (data as RawGuideEntry[]) : [];
      } catch {
        return [];
      }
    })
  );

  for (const entries of responses) {
    for (const entry of entries) {
      const channel = entry.Channel ?? {};
      const airings = (entry.Airings ?? [])
        .map((raw, index) =>
          normalizeAiring(raw, index, channel.Number ?? channel.ID ?? '', channel.Number ?? '')
        )
        .filter((a): a is Airing => a !== null)
        .sort((a, b) => a.start - b.start);
      if (airings.length === 0) continue;

      for (const key of guideChannelKeys(channel.DeviceID, channel.Number, channel.ID)) {
        const existing = byChannel.get(key);
        if (!existing) {
          byChannel.set(key, airings);
          continue;
        }
        // Bare-number keys can collect airings from several sources; keep the
        // first source's data rather than interleaving conflicting schedules.
        if (existing.length < airings.length) byChannel.set(key, airings);
      }
    }
  }

  return { byChannel, start, end };
}

export function lookupAirings(guide: GuideData | null, keys: string[]): Airing[] {
  if (!guide) return [];
  for (const key of keys) {
    const found = guide.byChannel.get(key);
    if (found && found.length > 0) return found;
  }
  return [];
}
