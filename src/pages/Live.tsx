import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChannels } from '../api/recordings';
import request, { getServerUrl } from '../api/client';
import type { Channel } from '../api/types';
import type { Airing, ChannelCollection, GuideData } from '../api/guide';
import { GUIDE_WINDOW_SECONDS, fetchChannelCollections, fetchGuide } from '../api/guide';
import type {
  RecordOptions,
  ScheduleState,
  ScheduledJob,
  SeriesPassOptions,
  SeriesRule,
} from '../api/scheduling';
import {
  EMPTY_SCHEDULE,
  airingScheduleKey,
  cancelJob,
  cancelSeries,
  fetchSchedule,
  recordAiring,
  recordSeries,
  updateSeriesRule,
} from '../api/scheduling';
import GuideGrid from '../components/GuideGrid';
import ProgramDialog from '../components/ProgramDialog';
import { useStore } from '../store/useStore';
import { applyLogoFallback, buildGuideLogoMap, channelLogoUrl, logoForChannelKey } from '../lib/channelLogos';
import './Page.css';

type SortMode = 'alpha' | 'number';
type DiagnosticsSortMode = 'number' | 'name';
type FilterMode = 'all' | 'favorites' | `source:${string}` | `collection:${string}` | `stock:${string}`;

/**
 * Channels DVR exposes no built-in collections over the API — only the ones a
 * user defines — so the familiar stock groupings are derived here from channel
 * attributes. HD is the only attribute the server actually populates
 * (Categories/Genres/Tags come back empty on every channel), so that is what
 * these are built from.
 */
const STOCK_COLLECTIONS: { id: `stock:${string}`; name: string; match: (c: Channel) => boolean }[] = [
  { id: 'stock:hd', name: 'HD Channels', match: (c) => c.hd === true },
  { id: 'stock:sd', name: 'SD Channels', match: (c) => c.hd !== true },
];
type ChannelRow = {
  id: string;
  channel: Channel;
  sourceName: string;
  sourceId: string;
  sourceFilterLabel: string;
};
type DiagnosticsGroup = {
  key: string;
  number: string;
  names: string[];
  sortName: string;
  minNumberValue: number;
  bySource: Map<string, ChannelRow[]>;
};

type GuideChannel = {
  ID?: string;
  ChannelID?: string;
  Number?: string;
  Favorite?: boolean;
  Hidden?: boolean;
};

interface LiveCacheEntry {
  channels: Channel[];
  guideFavorites: string[];
  guideHidden: string[];
  guideLogoMap: Record<string, string>;
  collections: ChannelCollection[];
}

const liveCache = new Map<string, LiveCacheEntry>();

const TEXT = new Intl.Collator(undefined, { sensitivity: 'base' });
const INITIAL_VISIBLE_CHANNEL_ROWS = 120;
const VISIBLE_CHANNEL_ROWS_STEP = 80;
const LIVE_SORT_STATE_KEY = 'winchannels_live_sort_state_v1';
// Stores whole filter values ('collection:71', 'stock:hd') rather than bare
// slugs, so stock and server-defined collections can both be favorited.
const FAVORITE_COLLECTIONS_KEY = 'winchannels_favorite_collections_v2';
const GUIDE_SLOT_SECONDS = 30 * 60;

function loadFavoriteCollections(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITE_COLLECTIONS_KEY) ?? '') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => String(s)).filter(Boolean);
  } catch {
    return [];
  }
}

interface LiveViewState {
  sortMode: SortMode;
  diagnosticsSortMode: DiagnosticsSortMode;
}

function loadLiveSortState(): LiveViewState {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIVE_SORT_STATE_KEY) ?? '') as Partial<LiveViewState>;
    return {
      sortMode: parsed.sortMode === 'alpha' || parsed.sortMode === 'number' ? parsed.sortMode : 'number',
      diagnosticsSortMode: parsed.diagnosticsSortMode === 'name' || parsed.diagnosticsSortMode === 'number'
        ? parsed.diagnosticsSortMode
        : 'number',
    };
  } catch {
    return { sortMode: 'number', diagnosticsSortMode: 'number' };
  }
}

/** Round down to the enclosing half-hour so guide columns land on :00 / :30. */
function alignToSlot(unixSeconds: number): number {
  return Math.floor(unixSeconds / GUIDE_SLOT_SECONDS) * GUIDE_SLOT_SECONDS;
}

function formatGuideWindow(start: number, end: number): string {
  const startDate = new Date(start * 1000);
  const endDate = new Date(end * 1000);
  const day = startDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time(startDate)} – ${time(endDate)}`;
}

function channelNumberValue(numberText: string | undefined): number {
  const parsed = Number.parseFloat(numberText ?? '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function channelCollectionName(channel: Channel): string {
  const maybe = channel as Channel & {
    collection?: string;
    collection_name?: string;
    group?: string;
    group_name?: string;
  };
  return (
    maybe.source_name ||
    maybe.collection_name ||
    maybe.collection ||
    maybe.group_name ||
    maybe.group ||
    ''
  ).trim();
}

function channelFilterLabel(filter: FilterMode, collectionNames?: Map<string, string>): string {
  if (filter === 'all') return 'All Channels';
  if (filter === 'favorites') return 'Favorites';
  if (filter.startsWith('source:')) return filter.replace('source:', '');
  if (filter.startsWith('stock:')) {
    return STOCK_COLLECTIONS.find((s) => s.id === filter)?.name ?? filter.replace('stock:', '');
  }
  const slug = filter.replace('collection:', '');
  return collectionNames?.get(slug) ?? slug;
}

/** Collection membership is stored as channel numbers, which also match ids. */
function collectionMemberKeys(channel: Channel): string[] {
  return [channel.number, channel.id]
    .filter((v): v is string => Boolean(v && String(v).trim()))
    .map((v) => String(v).trim().toLowerCase());
}

function favoriteKeyForChannel(channel: Channel): string[] {
  const keys = [channel.id, channel.number]
    .filter((v): v is string => Boolean(v && String(v).trim()))
    .map((v) => String(v).trim().toLowerCase());
  return Array.from(new Set(keys));
}

function parseGuideFavorites(data: unknown): Set<string> {
  const out = new Set<string>();
  if (!data || typeof data !== 'object') return out;

  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const channel = value as GuideChannel;
    if (!channel.Favorite) continue;
    const keys = [channel.ID, channel.ChannelID, channel.Number]
      .filter((v): v is string => Boolean(v && String(v).trim()))
      .map((v) => String(v).trim().toLowerCase());
    for (const key of keys) out.add(key);
  }

  return out;
}

function parseGuideHidden(data: unknown): Set<string> {
  const out = new Set<string>();
  if (!data || typeof data !== 'object') return out;

  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const channel = value as GuideChannel;
    if (!channel.Hidden) continue;
    const keys = [channel.ID, channel.ChannelID, channel.Number]
      .filter((v): v is string => Boolean(v && String(v).trim()))
      .map((v) => String(v).trim().toLowerCase());
    for (const key of keys) out.add(key);
  }

  return out;
}

function isFavoriteChannel(
  channel: Channel,
  guideFavorites: Set<string>
): boolean {
  if (channel.favorited === true) return true;
  if (channel.favorited === false) return false;
  const keys = favoriteKeyForChannel(channel);
  return keys.some((k) => guideFavorites.has(k));
}

function isHiddenChannel(
  channel: Channel,
  guideHidden: Set<string>
): boolean {
  const maybe = channel as Channel & {
    hidden?: boolean;
    is_hidden?: boolean;
    disabled?: boolean;
    enabled?: boolean;
    visible?: boolean;
  };

  if (maybe.hidden === true || maybe.is_hidden === true || maybe.disabled === true) return true;
  if (maybe.enabled === false || maybe.visible === false) return true;

  const keys = favoriteKeyForChannel(channel);
  return keys.some((k) => guideHidden.has(k));
}

function normalizedChannelName(name: string | undefined): string {
  return (name || '')
    .toLowerCase()
    .replace(/\(hd\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeKey(row: ChannelRow): string {
  const number = (row.channel.number || '').trim();
  const name = (row.channel.name || '').trim().toLowerCase();
  const id = (row.channel.id || '').trim().toLowerCase();
  return `${number}|${name || id}`;
}

function rowPriority(row: ChannelRow): number {
  return (row.channel.favorited ? 4 : 0)
    + (row.channel.logo_url ? 2 : 0)
    + (row.channel.hd ? 1 : 0);
}

function dedupeRows(rows: ChannelRow[]): ChannelRow[] {
  const byKey = new Map<string, ChannelRow>();
  for (const row of rows) {
    const key = dedupeKey(row);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, row);
      continue;
    }
    const currentScore = rowPriority(current);
    const nextScore = rowPriority(row);
    if (nextScore > currentScore) {
      byKey.set(key, row);
      continue;
    }
    if (nextScore === currentScore) {
      const currentTie = `${current.sourceName}|${current.channel.source_id || ''}|${current.channel.id || ''}`;
      const nextTie = `${row.sourceName}|${row.channel.source_id || ''}|${row.channel.id || ''}`;
      if (TEXT.compare(nextTie, currentTie) < 0) byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

function toAbsoluteUrl(raw: string, serverUrl: string): string {
  try {
    return new URL(raw, serverUrl).toString();
  } catch {
    return raw;
  }
}

function candidateLiveManifestUrls(channel: Channel): string[] {
  const server = getServerUrl();
  const asAny = channel as Channel & {
    url?: string;
    stream_url?: string;
    m3u8_url?: string;
    manifest_url?: string;
    hls_url?: string;
    playback_url?: string;
  };

  const fromFields = [
    asAny.manifest_url,
    asAny.m3u8_url,
    asAny.hls_url,
    asAny.stream_url,
    asAny.playback_url,
    asAny.url,
  ]
    .map((v) => (v || '').trim())
    .filter(Boolean)
    .map((v) => toAbsoluteUrl(v, server));

  const id = encodeURIComponent(channel.id || '');
  const number = encodeURIComponent(channel.number || '');
  const sourceId = encodeURIComponent(channel.source_id || '');

  const guessed = [
    // Prefer explicit master playlist — this triggers a full multi-quality
    // transcode session on Channels DVR rather than a fixed low-quality stream.
    `${server}/devices/ANY/channels/${number}/hls/master.m3u8`,
    sourceId ? `${server}/devices/${sourceId}/channels/${number}/hls/master.m3u8` : '',
    `${server}/devices/ANY/channels/${id}/hls/master.m3u8`,
    sourceId ? `${server}/devices/${sourceId}/channels/${id}/hls/master.m3u8` : '',
    // Fallback to bare /hls path (some servers, single-quality stream).
    `${server}/devices/ANY/channels/${number}/hls`,
    sourceId ? `${server}/devices/${sourceId}/channels/${number}/hls` : '',
    `${server}/devices/ANY/channels/${id}/hls`,
    sourceId ? `${server}/devices/${sourceId}/channels/${id}/hls` : '',
  ];

  const unique: string[] = [];
  for (const url of [...fromFields, ...guessed]) {
    if (url && !unique.includes(url)) unique.push(url);
  }
  return unique;
}

async function resolveLiveManifestUrl(channel: Channel): Promise<string> {
  const candidates = candidateLiveManifestUrls(channel);
  if (candidates.length === 0) return '';

  // In browser-only dev, prefer first candidate to avoid CORS probe failures.
  if (!window.__TAURI_INTERNALS__) return candidates[0];

  // Use the Tauri HTTP plugin (same stack as HLS.js) with HEAD requests so we
  // can validate the URL without downloading a body — a GET probe would initiate
  // a transcoding session on Channels DVR before HLS.js connects, potentially
  // locking the stream into a low-quality profile.
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');

  for (const url of candidates) {
    try {
      const res = await tauriFetch(url, {
        method: 'HEAD',
        headers: {
          'User-Agent': navigator.userAgent,
          Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
        },
      });
      // Channels DVR answers HEAD on live manifests with 404 even where GET
      // returns 200, so a 404/405 means "HEAD is unusable here", not "wrong
      // URL". Probing the remaining candidates can only fail the same way and
      // ends at candidates[0] regardless, so stop paying for it.
      if (res.status === 404 || res.status === 405) return candidates[0];
      if (!res.ok) continue;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // Accept any response that looks like an HLS stream or a plausible media type.
      if (
        ct.includes('mpegurl') ||
        ct.includes('m3u8') ||
        ct.includes('octet-stream') ||
        ct.includes('video/') ||
        ct === ''
      ) return url;
    } catch {
      // Continue trying the next candidate URL.
    }
  }

  // Fallback: let player try the first candidate directly.
  return candidates[0];
}

export default function Live() {
  const initialSortState = loadLiveSortState();
  const activeServerId = useStore((s) => s.activeServerId);
  const cacheKey = activeServerId;
  const cached = liveCache.get(cacheKey);
  const [channels, setChannels] = useState<Channel[]>(cached?.channels ?? []);
  const [guideFavorites, setGuideFavorites] = useState<Set<string>>(new Set(cached?.guideFavorites ?? []));
  const [guideHidden, setGuideHidden] = useState<Set<string>>(new Set(cached?.guideHidden ?? []));
  const [guideLogoMap, setGuideLogoMap] = useState<Record<string, string>>(cached?.guideLogoMap ?? {});
  const [collections, setCollections] = useState<ChannelCollection[]>(cached?.collections ?? []);
  const [favoriteCollections, setFavoriteCollections] = useState<Set<string>>(
    () => new Set(loadFavoriteCollections())
  );
  // Applying the favorite as the opening filter must happen once collections
  // have loaded, but must not fight the user if they then pick something else.
  const appliedFavoriteRef = useRef(false);
  const [sortMode, setSortMode] = useState<SortMode>(initialSortState.sortMode);
  const [diagnosticsSortMode, setDiagnosticsSortMode] = useState<DiagnosticsSortMode>(initialSortState.diagnosticsSortMode);
  const [guideStart, setGuideStart] = useState<number>(() => alignToSlot(Date.now() / 1000));
  const [guideData, setGuideData] = useState<GuideData | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [schedule, setSchedule] = useState<ScheduleState>(EMPTY_SCHEDULE);
  const [openProgram, setOpenProgram] = useState<{ row: ChannelRow; airing: Airing } | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [playPendingRowId, setPlayPendingRowId] = useState<string | null>(null);
  const [visibleChannelCount, setVisibleChannelCount] = useState(INITIAL_VISIBLE_CHANNEL_ROWS);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const serverChangeVersion = useStore((s) => s.serverChangeVersion);
  const playItem = useStore((s) => s.playItem);
  const diagnosticsEnabled = useStore((s) => s.diagnosticsEnabled);
  const showHiddenLiveChannels = useStore((s) => s.showHiddenLiveChannels);

  useEffect(() => {
    localStorage.setItem(LIVE_SORT_STATE_KEY, JSON.stringify({ sortMode, diagnosticsSortMode }));
  }, [sortMode, diagnosticsSortMode]);

  // Keep the "on now" highlight and the red time marker honest.
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cachedRows = liveCache.get(cacheKey);
    setLoading(!cachedRows);
    setError(null);
    setSelectedChannelId(null);
    if (cachedRows) {
      setChannels(cachedRows.channels);
      setGuideFavorites(new Set(cachedRows.guideFavorites));
      setGuideHidden(new Set(cachedRows.guideHidden));
      setGuideLogoMap(cachedRows.guideLogoMap);
      setCollections(cachedRows.collections);
    }

    Promise.all([
      fetchChannels(),
      request<Record<string, unknown>>('/dvr/guide/channels').catch(() => ({})),
      fetchChannelCollections(),
    ])
      .then(([loadedChannels, loadedGuide, loadedCollections]) => {
        if (cancelled) return;
        const nextFavorites = Array.from(parseGuideFavorites(loadedGuide));
        const nextHidden = Array.from(parseGuideHidden(loadedGuide));
        const nextGuideLogoMap = buildGuideLogoMap(loadedGuide);
        liveCache.set(cacheKey, {
          channels: loadedChannels,
          guideFavorites: nextFavorites,
          guideHidden: nextHidden,
          guideLogoMap: nextGuideLogoMap,
          collections: loadedCollections,
        });
        setChannels(loadedChannels);
        setGuideFavorites(new Set(nextFavorites));
        setGuideHidden(new Set(nextHidden));
        setGuideLogoMap(nextGuideLogoMap);
        setCollections(loadedCollections);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [cacheKey, serverChangeVersion]);

  const deviceIds = useMemo(() => {
    return Array.from(new Set(channels.map((c) => (c.source_id || '').trim()).filter(Boolean)));
  }, [channels]);

  useEffect(() => {
    if (deviceIds.length === 0) return;
    let cancelled = false;
    setGuideLoading(true);
    fetchGuide(deviceIds, guideStart, GUIDE_WINDOW_SECONDS)
      .then((data) => {
        if (!cancelled) setGuideData(data);
      })
      .catch(() => {
        if (!cancelled) setGuideData(null);
      })
      .finally(() => {
        if (!cancelled) setGuideLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [deviceIds, guideStart]);

  // What is already scheduled, so the grid can flag it and the dialog can offer
  // "cancel" instead of "record". Refreshed after every scheduling action.
  const refreshSchedule = useCallback(() => {
    return fetchSchedule()
      .then(setSchedule)
      .catch(() => setSchedule(EMPTY_SCHEDULE));
  }, []);

  useEffect(() => {
    void refreshSchedule();
  }, [serverChangeVersion, cacheKey, refreshSchedule]);

  const scheduleStateFor = useCallback(
    (airing: Airing): 'job' | 'series' | null => {
      if (schedule.jobsByAiring.has(airingScheduleKey(airing.channelNumber, airing.start))) {
        return 'job';
      }
      if (airing.seriesId && schedule.ruleBySeries.has(airing.seriesId)) return 'series';
      return null;
    },
    [schedule]
  );

  /** Wrap a scheduling call with busy/error state and a schedule refresh. */
  const runScheduleAction = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setScheduleBusy(key);
      setScheduleError(null);
      try {
        await action();
        await refreshSchedule();
      } catch (e) {
        setScheduleError(e instanceof Error ? e.message : String(e));
      } finally {
        setScheduleBusy(null);
      }
    },
    [refreshSchedule]
  );

  const collectionNames = useMemo(() => {
    return new Map(collections.map((c) => [c.slug, c.name]));
  }, [collections]);

  const collectionMembers = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const collection of collections) {
      map.set(collection.slug, new Set(collection.items.map((i) => i.toLowerCase())));
    }
    return map;
  }, [collections]);

  const rows = useMemo<ChannelRow[]>(() => {
    const seen = new Map<string, number>();
    const filteredChannels = showHiddenLiveChannels
      ? channels
      : channels.filter((channel) => !isHiddenChannel(channel, guideHidden));

    return filteredChannels.map((channel) => {
      const sourceName = channelCollectionName(channel);
      const sourceId = (channel.source_id || 'unknown-source-id').trim();
      const sourceFilterLabel = `${sourceName || 'Unknown Source'} (${sourceId})`;
      const base = [
        channel.id ?? '',
        sourceId,
        channel.station_id ?? '',
        channel.number ?? '',
        channel.name ?? '',
        sourceName,
      ].join('|');
      const next = (seen.get(base) ?? 0) + 1;
      seen.set(base, next);
      return {
        id: `${base}|${next}`,
        channel,
        sourceName,
        sourceId,
        sourceFilterLabel,
      };
    });
  }, [channels, guideHidden, showHiddenLiveChannels]);

  const sourceFilters = useMemo(() => {
    const labels = rows
      .map((row) => row.sourceFilterLabel)
      .filter(Boolean);
    return Array.from(new Set(labels)).sort((a, b) => TEXT.compare(a, b));
  }, [rows]);

  const channelsBySource = useMemo(() => {
    const map = new Map<string, ChannelRow[]>();
    for (const row of rows) {
      const key = row.sourceFilterLabel || 'Unknown Source';
      const list = map.get(key);
      if (list) {
        list.push(row);
      } else {
        map.set(key, [row]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const byNumber = channelNumberValue(a.channel.number) - channelNumberValue(b.channel.number);
        if (byNumber !== 0) return byNumber;
        return TEXT.compare(a.channel.name, b.channel.name);
      });
    }
    return Array.from(map.entries()).sort((a, b) => TEXT.compare(a[0], b[0]));
  }, [rows]);

  const diagnosticsSources = useMemo(() => channelsBySource.map(([source]) => source), [channelsBySource]);

  const diagnosticsGroups = useMemo<DiagnosticsGroup[]>(() => {
    const groups = new Map<string, DiagnosticsGroup>();

    for (const row of rows) {
      const key = normalizedChannelName(row.channel.name) || `id:${row.channel.id || row.id}`;
      const rowNumber = (row.channel.number || '').trim() || '-';
      const rowNumberValue = channelNumberValue(row.channel.number);
      const existing = groups.get(key);
      if (!existing) {
        const names = row.channel.name ? [row.channel.name] : [];
        const bySource = new Map<string, ChannelRow[]>();
        bySource.set(row.sourceFilterLabel, [row]);
        groups.set(key, {
          key,
          number: rowNumber,
          names,
          sortName: (row.channel.name || '').trim(),
          minNumberValue: rowNumberValue,
          bySource,
        });
        continue;
      }

      if (row.channel.name && !existing.names.includes(row.channel.name)) {
        existing.names.push(row.channel.name);
        existing.names.sort((a, b) => TEXT.compare(a, b));
        existing.sortName = existing.names[0] || existing.sortName;
      }

      if (rowNumberValue < existing.minNumberValue) {
        existing.minNumberValue = rowNumberValue;
        existing.number = rowNumber;
      }

      const sourceItems = existing.bySource.get(row.sourceFilterLabel);
      if (sourceItems) {
        sourceItems.push(row);
      } else {
        existing.bySource.set(row.sourceFilterLabel, [row]);
      }
    }

    const out = Array.from(groups.values());
    for (const group of out) {
      for (const items of group.bySource.values()) {
        items.sort((a, b) => {
          const byName = TEXT.compare(a.channel.name || '', b.channel.name || '');
          if (byName !== 0) return byName;
          return TEXT.compare(a.channel.id || '', b.channel.id || '');
        });
      }
    }

    out.sort((a, b) => {
      if (diagnosticsSortMode === 'name') {
        const byName = TEXT.compare(a.sortName || '', b.sortName || '');
        if (byName !== 0) return byName;
      }
      const byNumber = a.minNumberValue - b.minNumberValue;
      if (byNumber !== 0) return byNumber;
      return TEXT.compare(a.sortName || '', b.sortName || '');
    });

    return out;
  }, [rows, diagnosticsSortMode]);

  const toggleFavoriteCollection = useCallback((value: string) => {
    setFavoriteCollections((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      localStorage.setItem(FAVORITE_COLLECTIONS_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);

  // Channel count per collection, shown in the menu. A collection can resolve
  // to zero when it references a source that is no longer in the lineup (e.g.
  // Plex/Pluto ids from a disabled provider), and a bare name gives no hint
  // that this is the reason the guide came back empty.
  const collectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stock of STOCK_COLLECTIONS) {
      counts.set(stock.id, dedupeRows(rows.filter((row) => stock.match(row.channel))).length);
    }
    for (const collection of collections) {
      const members = collectionMembers.get(collection.slug);
      const matched = members
        ? rows.filter((row) => collectionMemberKeys(row.channel).some((key) => members.has(key)))
        : [];
      counts.set(`collection:${collection.slug}`, dedupeRows(matched).length);
    }
    return counts;
  }, [rows, collections, collectionMembers]);

  const availableFilters = useMemo(() => {
    const base: FilterMode[] = ['all', 'favorites'];
    for (const stock of STOCK_COLLECTIONS) base.push(stock.id);
    for (const collection of collections) base.push(`collection:${collection.slug}`);
    for (const sourceFilter of sourceFilters) base.push(`source:${sourceFilter}`);
    return base;
  }, [sourceFilters, collections]);

  // Open on the favorited collection once, if it is still available.
  useEffect(() => {
    if (appliedFavoriteRef.current || collections.length === 0) return;
    appliedFavoriteRef.current = true;
    const favorite = availableFilters.find((f) => favoriteCollections.has(f));
    if (favorite) setFilterMode(favorite);
  }, [collections, favoriteCollections, availableFilters]);

  useEffect(() => {
    appliedFavoriteRef.current = false;
  }, [cacheKey, serverChangeVersion]);

  useEffect(() => {
    if (!availableFilters.includes(filterMode)) {
      setFilterMode('all');
    }
  }, [availableFilters, filterMode]);

  const visibleRows = useMemo(() => {
    let list = rows;

    if (filterMode === 'favorites') {
      list = list.filter((row) => {
        return isFavoriteChannel(row.channel, guideFavorites);
      });
    } else if (filterMode.startsWith('source:')) {
      const wanted = filterMode.replace('source:', '');
      list = list.filter((row) => row.sourceFilterLabel === wanted);
    } else if (filterMode.startsWith('collection:')) {
      const members = collectionMembers.get(filterMode.replace('collection:', ''));
      list = members
        ? list.filter((row) => collectionMemberKeys(row.channel).some((key) => members.has(key)))
        : [];
    } else if (filterMode.startsWith('stock:')) {
      const stock = STOCK_COLLECTIONS.find((s) => s.id === filterMode);
      list = stock ? list.filter((row) => stock.match(row.channel)) : [];
    }

    if (
      filterMode === 'all'
      || filterMode === 'favorites'
      || filterMode.startsWith('collection:')
      || filterMode.startsWith('stock:')
    ) {
      list = dedupeRows(list);
    }

    const sorted = [...list];
    if (sortMode === 'alpha') {
      sorted.sort((a, b) => TEXT.compare(a.channel.name, b.channel.name));
    } else {
      sorted.sort((a, b) => {
        const byNumber = channelNumberValue(a.channel.number) - channelNumberValue(b.channel.number);
        if (byNumber !== 0) return byNumber;
        return TEXT.compare(a.channel.name, b.channel.name);
      });
    }
    return sorted;
  }, [rows, filterMode, sortMode, guideFavorites, collectionMembers]);

  useEffect(() => {
    setVisibleChannelCount(INITIAL_VISIBLE_CHANNEL_ROWS);
  }, [filterMode, sortMode, visibleRows.length]);

  useEffect(() => {
    if (!selectedChannelId) return;
    const index = visibleRows.findIndex((row) => row.id === selectedChannelId);
    if (index < 0 || index < visibleChannelCount) return;
    setVisibleChannelCount(index + 1);
  }, [selectedChannelId, visibleRows, visibleChannelCount]);

  const displayedRows = useMemo(() => {
    return visibleRows.slice(0, visibleChannelCount);
  }, [visibleRows, visibleChannelCount]);

  useEffect(() => {
    if (selectedChannelId && !visibleRows.some((row) => row.id === selectedChannelId)) {
      setSelectedChannelId(visibleRows[0]?.id ?? null);
    }
    if (!selectedChannelId && visibleRows.length > 0) {
      setSelectedChannelId(visibleRows[0].id);
    }
  }, [visibleRows, selectedChannelId]);

  const resolveRowLogo = useCallback(
    (channel: Channel): string | undefined => {
      return (
        logoForChannelKey(channel.number, guideLogoMap)
        ?? logoForChannelKey(channel.id, guideLogoMap)
        ?? channelLogoUrl(channel)
        ?? undefined
      );
    },
    [guideLogoMap]
  );

  const playChannelRow = useCallback(
    async (row: ChannelRow) => {
      setSelectedChannelId(row.id);
      setPlayPendingRowId(row.id);
      const manifestUrl = await resolveLiveManifestUrl(row.channel);
      const source = row.sourceName || 'Unknown Source';
      const label = `${row.channel.number} ${row.channel.name} · ${source}`;
      playItem(row.channel.id || row.id, label, '', [], manifestUrl);
      setPlayPendingRowId(null);
    },
    [playItem]
  );

  const loadMoreRows = useCallback(() => {
    setVisibleChannelCount((current) => {
      if (current >= visibleRows.length) return current;
      return Math.min(current + VISIBLE_CHANNEL_ROWS_STEP, visibleRows.length);
    });
  }, [visibleRows.length]);

  const guideEnd = guideStart + GUIDE_WINDOW_SECONDS;
  // The collection menu covers both built-in and DVR-defined collections, so it
  // holds the whole filter value rather than a bare slug.
  const selectedCollectionSlug = filterMode.startsWith('collection:') || filterMode.startsWith('stock:')
    ? filterMode
    : '';

  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title" style={{ whiteSpace: 'nowrap', alignSelf: 'flex-start' }}>Live TV</h1>
        <div className="page__filters page__filters--wrap">
          {/* All / Favorites stay as chips; collections and sources each get
              their own dropdown so they are not jumbled into one long row.
              Only one filter is ever in effect, so choosing from either menu
              overrides the other — picking a source clears the collection. */}
          <button
            type="button"
            className={`filter-btn ${filterMode === 'all' ? 'filter-btn--active' : ''}`}
            onClick={() => setFilterMode('all')}
          >
            All Channels
          </button>
          <button
            type="button"
            className={`filter-btn ${filterMode === 'favorites' ? 'filter-btn--active' : ''}`}
            onClick={() => setFilterMode('favorites')}
          >
            Favorites
          </button>

          <span className="filter-select-group">
              <select
                className="page-sort-select"
                aria-label="Filter by channel collection"
                value={selectedCollectionSlug}
                onChange={(e) => setFilterMode((e.target.value || 'all') as FilterMode)}
              >
                <option value="">Collection: All</option>
                <optgroup label="Built-in">
                  {STOCK_COLLECTIONS.map((stock) => (
                    <option key={stock.id} value={stock.id}>
                      {favoriteCollections.has(stock.id) ? '★ ' : ''}
                      {stock.name} ({collectionCounts.get(stock.id) ?? 0})
                    </option>
                  ))}
                </optgroup>
                {collections.length > 0 && (
                  <optgroup label="From your DVR">
                    {collections.map((collection) => (
                      <option key={collection.slug} value={`collection:${collection.slug}`}>
                        {favoriteCollections.has(`collection:${collection.slug}`) ? '★ ' : ''}
                        {collection.name} ({collectionCounts.get(`collection:${collection.slug}`) ?? 0})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className={`filter-star ${selectedCollectionSlug && favoriteCollections.has(selectedCollectionSlug) ? 'filter-star--on' : ''}`}
                disabled={!selectedCollectionSlug}
                onClick={() => { if (selectedCollectionSlug) toggleFavoriteCollection(selectedCollectionSlug); }}
                aria-pressed={Boolean(selectedCollectionSlug && favoriteCollections.has(selectedCollectionSlug))}
                title={!selectedCollectionSlug
                  ? 'Choose a collection to favorite it'
                  : favoriteCollections.has(selectedCollectionSlug)
                    ? 'Unfavorite this collection — Live will no longer open on it'
                    : 'Favorite this collection — Live will open on it'}
              >
                {selectedCollectionSlug && favoriteCollections.has(selectedCollectionSlug) ? '★' : '☆'}
              </button>
          </span>

          {sourceFilters.length > 0 && (
            <select
              className="page-sort-select"
              aria-label="Filter by source"
              value={filterMode.startsWith('source:') ? filterMode : ''}
              onChange={(e) => setFilterMode((e.target.value || 'all') as FilterMode)}
            >
              <option value="">Source: All</option>
              {sourceFilters.map((source) => (
                <option key={source} value={`source:${source}`}>{source}</option>
              ))}
            </select>
          )}
          <select
            className="page-sort-select"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            aria-label="Sort live channel list"
          >
            <option value="number">Channel Number</option>
            <option value="alpha">Alphabetical</option>
          </select>
          {diagnosticsEnabled && (
            <button
              type="button"
              className="page-sort-select"
              onClick={() => setDiagnosticsOpen(true)}
              aria-label="Open live diagnostics"
            >
              Source Diagnostics
            </button>
          )}
        </div>
      </header>
      <p className="page__status live-count">
        {visibleRows.length} channel{visibleRows.length === 1 ? '' : 's'} • {channelFilterLabel(filterMode, collectionNames)}
        <span className="guide-nav">
          <button
            type="button"
            className="filter-btn"
            onClick={() => setGuideStart((s) => s - GUIDE_SLOT_SECONDS)}
            aria-label="Earlier"
          >
            ◀
          </button>
          <button
            type="button"
            className="filter-btn"
            onClick={() => setGuideStart(alignToSlot(Date.now() / 1000))}
          >
            Now
          </button>
          <button
            type="button"
            className="filter-btn"
            onClick={() => setGuideStart((s) => s + GUIDE_SLOT_SECONDS)}
            aria-label="Later"
          >
            ▶
          </button>
          <span className="guide-nav__label">{formatGuideWindow(guideStart, guideEnd)}</span>
        </span>
      </p>

      {loading && <p className="page__status">Loading channels…</p>}
      {error && <p className="page__error">⚠ {error}</p>}

      {!loading && !error && (
        <GuideGrid
          rows={displayedRows}
          guide={guideData}
          windowStart={guideStart}
          windowEnd={guideEnd}
          now={now}
          loading={guideLoading}
          selectedRowId={selectedChannelId}
          pendingRowId={playPendingRowId}
          resolveLogo={resolveRowLogo}
          scheduleStateFor={scheduleStateFor}
          onSelect={(row) => setSelectedChannelId(row.id)}
          onPlay={(row) => { void playChannelRow(row as ChannelRow); }}
          onOpenProgram={(row, airing) => {
            setScheduleError(null);
            setOpenProgram({ row: row as ChannelRow, airing });
          }}
          onLoadMore={loadMoreRows}
          hasMore={displayedRows.length < visibleRows.length}
        />
      )}

      {openProgram && (
        <ProgramDialog
          airing={openProgram.airing}
          channel={openProgram.row.channel}
          sourceName={openProgram.row.sourceName}
          job={
            schedule.jobsByAiring.get(
              airingScheduleKey(openProgram.airing.channelNumber, openProgram.airing.start)
            ) ?? null
          }
          rule={schedule.ruleBySeries.get(openProgram.airing.seriesId) ?? null}
          defaultPadding={schedule.padding}
          busy={scheduleBusy}
          error={scheduleError}
          onClose={() => setOpenProgram(null)}
          onWatch={() => {
            const row = openProgram.row;
            setOpenProgram(null);
            void playChannelRow(row);
          }}
          onRecord={(options: RecordOptions) => {
            const airing = openProgram.airing;
            const existing = schedule.jobsByAiring.get(
              airingScheduleKey(airing.channelNumber, airing.start)
            );
            void runScheduleAction('record', async () => {
              // Jobs have no update endpoint — re-book to change the times.
              if (existing) await cancelJob(existing.id);
              await recordAiring(airing, options);
            });
          }}
          onCancelRecord={(job: ScheduledJob) => {
            void runScheduleAction('cancel-job', () => cancelJob(job.id));
          }}
          onRecordSeries={(options: SeriesPassOptions) => {
            void runScheduleAction('record-series', () => recordSeries(openProgram.airing, options));
          }}
          onUpdateSeries={(rule: SeriesRule, options: SeriesPassOptions) => {
            void runScheduleAction('update-series', () => updateSeriesRule(rule, options));
          }}
          onCancelSeries={(rule: SeriesRule) => {
            void runScheduleAction('cancel-series', () => cancelSeries(rule.id));
          }}
        />
      )}

      {diagnosticsEnabled && diagnosticsOpen && (
        <div className="media-modal-backdrop" onClick={() => setDiagnosticsOpen(false)}>
          <div className="media-modal live-diag-modal" onClick={(e) => e.stopPropagation()}>
            <div className="media-modal__header">
              <h3>Live Source Diagnostics</h3>
              <div className="live-diag-header-controls">
                <select
                  className="page-sort-select"
                  value={diagnosticsSortMode}
                  onChange={(e) => setDiagnosticsSortMode(e.target.value as DiagnosticsSortMode)}
                  aria-label="Sort diagnostics table"
                >
                  <option value="number">Sort by Channel Number</option>
                  <option value="name">Sort by Channel Name</option>
                </select>
                <button className="media-modal__close" onClick={() => setDiagnosticsOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <p className="live-diag-summary">
              {rows.length} channels across {channelsBySource.length} source instance{channelsBySource.length === 1 ? '' : 's'} and {diagnosticsGroups.length} distinct channel number{diagnosticsGroups.length === 1 ? '' : 's'}.
            </p>
            <div className="live-diag-matrix-wrap">
              <table className="live-diag-matrix">
                <thead>
                  <tr>
                    <th className="live-diag-matrix__rowhead">Channel</th>
                    {channelsBySource.map(([source, sourceRows]) => (
                      <th key={source}>
                        <div className="live-diag-matrix__head-title">{source}</div>
                        <div className="live-diag-matrix__head-count">{sourceRows.length} channels</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {diagnosticsGroups.map((group) => (
                    <tr key={group.key}>
                      <td className="live-diag-rowhead">
                        <div className="live-diag-rowhead__number">{group.number}</div>
                        <div className="live-diag-rowhead__names">{group.names.join(' / ') || '-'}</div>
                      </td>
                      {diagnosticsSources.map((source) => {
                        const items = group.bySource.get(source) ?? [];
                        return (
                          <td key={`${source}-${group.key}`}>
                            {items.length > 0 ? (
                              <div className="live-diag-cell-stack">
                                {items.map((item) => (
                                  <div key={item.id} className="live-diag-cell">
                                    <div className="live-diag-cell__line">
                                      {(() => {
                                        const url = logoForChannelKey(item.channel.number, guideLogoMap)
                                          ?? logoForChannelKey(item.channel.id, guideLogoMap)
                                          ?? channelLogoUrl(item.channel);
                                        return url ? (
                                          <img
                                            className="live-diag-cell__logo"
                                            src={url}
                                            alt=""
                                            aria-hidden="true"
                                            onError={(e) => applyLogoFallback(e.currentTarget)}
                                          />
                                        ) : (
                                          <span className="live-diag-cell__icon" aria-hidden="true">📺</span>
                                        );
                                      })()}
                                      <span className="live-diag-cell__name">{item.channel.name || '-'}</span>
                                      {isFavoriteChannel(item.channel, guideFavorites) && (
                                        <span className="live-diag-cell__favorite">favorite</span>
                                      )}
                                    </div>
                                    <div className="live-diag-cell__meta">{item.channel.id || '-'}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="live-diag-cell__empty">-</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}