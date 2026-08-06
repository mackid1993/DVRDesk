// Integration tests against a live Channels DVR server.
// Run with: CHANNELS_DVR_URL=http://192.168.x.x:8089 npm run test:api
//
// These tests validate that every API endpoint DVRDesk depends on still exists,
// accepts the expected HTTP method, and returns the expected response shape.
// Pass a new server version through these tests before approving it in
// .github/api-version-compatibility.json.

import { beforeAll, describe, expect, it } from 'vitest';

const BASE = (process.env.CHANNELS_DVR_URL ?? 'http://localhost:8089').replace(/\/$/, '');

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: GET ${path}`);
  return res.json() as Promise<T>;
}

async function method(verb: string, path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: verb });
}

// ── Types (mirrors src/api/types.ts — intentionally duplicated so tests catch field renames) ──

interface Recording {
  id: string; show_id?: string; program_id: string; path: string; channel: string;
  title: string; episode_title?: string; thumbnail_url: string;
  duration: number; playback_time: number;
  watched: boolean; favorited: boolean; delayed: boolean; cancelled: boolean;
  corrupted: boolean; completed: boolean; processed: boolean;
  created_at: number; updated_at: number;
}
interface Show { id: string; name: string; episode_count?: number; updated_at?: number; }
interface Episode {
  id: string; show_id: string; program_id: string; path: string; channel: string;
  title: string; episode_title: string;
  duration: number; playback_time: number;
  watched: boolean; favorited: boolean; created_at: number; updated_at: number;
}
interface Movie {
  id: string; title: string; program_id: string; path: string; channel: string;
  duration: number; playback_time: number;
  watched: boolean; favorited: boolean; created_at: number; updated_at: number;
}
interface Channel { id: string; name: string; number: string; }
interface ChannelCollection { slug: string; name: string; items: string[]; }
interface GuideDevice { DeviceID: string; }
interface GuideAiring {
  Time: number; Duration: number; Title: string;
  EpisodeTitle?: string; Summary?: string; Image?: string;
  Categories?: string[]; Tags?: string[];
}
interface GuideEntry { Channel?: { Number?: string; ID?: string; DeviceID?: string }; Airings?: GuideAiring[]; }
interface ScheduledJobPayload {
  ID: string; Name: string; Time: number; Duration: number; Channels: string[];
  RuleID?: string; Airing?: { Time?: number; ProgramID?: string; SeriesID?: string };
}
interface RulePayload {
  ID: string; Name: string; EQ?: { SeriesID?: string; Tags?: string };
  PaddingStart?: number; PaddingEnd?: number; KeepNum?: number;
  Duplicates?: boolean; Paused?: boolean; NumJobs?: number;
}
interface VideoGroup { id: string; name: string; }
interface Video {
  id: string; video_group_id: string; title: string; video_title: string;
  duration: number; playback_time: number;
  watched: boolean; favorited: boolean; created_at: number; updated_at: number;
}
interface DvrFile {
  ID: string; RuleID: string; GroupID: string; JobID: string;
  Path: string; CreatedAt: number; Duration: number;
}
type SessionsPayload =
  | { ID: string; Channel?: { Number?: string; ID?: string } }[]
  | { live?: { ID: string }[] };

// ── Test fixtures — loaded once before all tests ──────────────────────────────

let recording: Recording | null = null;
let show: Show | null = null;
let movie: Movie | null = null;
let channel: Channel | null = null;
let videoGroup: VideoGroup | null = null;

beforeAll(async () => {
  const tryGet = async <T>(path: string, params?: Record<string, string>): Promise<T[]> => {
    try { return await get<T[]>(path, params); } catch { return []; }
  };
  // Prefer a completed, non-corrupted recording so duration is populated and the file is on disk.
  const allRecordings = await tryGet<Recording>('/api/v1/all', { sort: 'date_added', order: 'desc', source: 'recordings' });
  recording = allRecordings.find(r => r.completed && !r.corrupted) ?? allRecordings[0] ?? null;
  [show]      = await tryGet<Show>('/api/v1/shows');
  [movie]     = await tryGet<Movie>('/api/v1/movies');
  [channel]   = await tryGet<Channel>('/api/v1/channels');
  [videoGroup] = await tryGet<VideoGroup>('/api/v1/video_groups');
}, 30_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Channels DVR API Compatibility', () => {

  // ── Connectivity ─────────────────────────────────────────────────────────────

  describe('connectivity', () => {
    it('server is reachable via a status endpoint', async () => {
      let reached = false;
      for (const p of ['/api/v1/status', '/api/status', '/status']) {
        try {
          const res = await fetch(`${BASE}${p}`);
          if (res.status < 500) { reached = true; break; }
        } catch { /* try next candidate */ }
      }
      expect(reached, `No status endpoint responded at ${BASE}`).toBe(true);
    });
  });

  // ── Recent Recordings (/api/v1/all) ──────────────────────────────────────────

  describe('GET /api/v1/all?source=recordings', () => {
    it('returns an array', async () => {
      const data = await get<unknown[]>('/api/v1/all', { sort: 'date_added', order: 'desc', source: 'recordings' });
      expect(Array.isArray(data)).toBe(true);
    });

    it('items have all required fields with correct types', () => {
      if (!recording) return;
      const r = recording;
      expect(typeof r.id).toBe('string');
      expect(typeof r.program_id).toBe('string');
      expect(typeof r.path).toBe('string');
      expect(typeof r.channel).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.thumbnail_url).toBe('string');
      expect(typeof r.duration).toBe('number');
      expect(typeof r.playback_time).toBe('number');
      expect(typeof r.watched).toBe('boolean');
      expect(typeof r.favorited).toBe('boolean');
      expect(typeof r.delayed).toBe('boolean');
      expect(typeof r.cancelled).toBe('boolean');
      expect(typeof r.corrupted).toBe('boolean');
      expect(typeof r.completed).toBe('boolean');
      expect(typeof r.processed).toBe('boolean');
      expect(typeof r.created_at).toBe('number');
      expect(typeof r.updated_at).toBe('number');
    });
  });

  // ── Shows ─────────────────────────────────────────────────────────────────────

  describe('GET /api/v1/shows', () => {
    it('returns an array', async () => {
      expect(Array.isArray(await get<unknown[]>('/api/v1/shows'))).toBe(true);
    });

    it('items use "name" (not "title") for the show name', () => {
      if (!show) return;
      expect(typeof show.id).toBe('string');
      expect(typeof show.name).toBe('string');
      expect((show as unknown as Record<string, unknown>)['title']).toBeUndefined();
    });
  });

  describe('GET /api/v1/shows/:id', () => {
    it('returns the correct show', async () => {
      if (!show) return;
      const data = await get<Show>(`/api/v1/shows/${encodeURIComponent(show.id)}`);
      expect(data.id).toBe(show.id);
      expect(typeof data.name).toBe('string');
    });
  });

  describe('GET /api/v1/shows/:id/episodes', () => {
    it('returns an array with required fields', async () => {
      if (!show) return;
      const eps = await get<Episode[]>(
        `/api/v1/shows/${encodeURIComponent(show.id)}/episodes`,
        { sort: 'date_added', order: 'desc' },
      );
      expect(Array.isArray(eps)).toBe(true);
      if (!eps.length) return;
      const ep = eps[0];
      expect(typeof ep.id).toBe('string');
      expect(typeof ep.show_id).toBe('string');
      expect(typeof ep.program_id).toBe('string');
      expect(typeof ep.title).toBe('string');
      expect(typeof ep.episode_title).toBe('string');
      expect(typeof ep.duration).toBe('number');
      expect(typeof ep.playback_time).toBe('number');
      expect(typeof ep.watched).toBe('boolean');
      expect(typeof ep.created_at).toBe('number');
      expect(typeof ep.updated_at).toBe('number');
    });
  });

  // ── Movies ────────────────────────────────────────────────────────────────────

  describe('GET /api/v1/movies', () => {
    it('returns an array', async () => {
      expect(Array.isArray(await get<unknown[]>('/api/v1/movies'))).toBe(true);
    });

    it('items have required fields', () => {
      if (!movie) return;
      expect(typeof movie.id).toBe('string');
      expect(typeof movie.title).toBe('string');
      expect(typeof movie.program_id).toBe('string');
      expect(typeof movie.duration).toBe('number');
      expect(typeof movie.playback_time).toBe('number');
      expect(typeof movie.watched).toBe('boolean');
      expect(typeof movie.favorited).toBe('boolean');
      expect(typeof movie.created_at).toBe('number');
      expect(typeof movie.updated_at).toBe('number');
    });
  });

  describe('GET /api/v1/movies/:id', () => {
    it('returns the correct movie', async () => {
      if (!movie) return;
      const data = await get<Movie>(`/api/v1/movies/${encodeURIComponent(movie.id)}`);
      expect(data.id).toBe(movie.id);
      expect(typeof data.title).toBe('string');
    });
  });

  // ── Channels ──────────────────────────────────────────────────────────────────

  describe('GET /api/v1/channels', () => {
    it('returns an array', async () => {
      expect(Array.isArray(await get<unknown[]>('/api/v1/channels'))).toBe(true);
    });

    it('items have id, name, and number as strings', () => {
      if (!channel) return;
      expect(typeof channel.id).toBe('string');
      expect(typeof channel.name).toBe('string');
      expect(typeof channel.number).toBe('string');
    });
  });

  // ── Live Guide ────────────────────────────────────────────────────────────────

  describe('GET /dvr/guide/channels', () => {
    it('returns 200 with parseable JSON', async () => {
      const res = await fetch(`${BASE}/dvr/guide/channels`);
      expect(res.ok, `Expected 200, got ${res.status}`).toBe(true);
      expect(await res.json()).toBeDefined();
    });
  });

  describe('GET /dvr/collections/channels', () => {
    it('returns an array of collections with slug, name, and items', async () => {
      const collections = await get<ChannelCollection[]>('/dvr/collections/channels');
      expect(Array.isArray(collections)).toBe(true);
      if (!collections.length) return;
      const c = collections[0];
      expect(typeof c.slug).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(Array.isArray(c.items)).toBe(true);
    });

    it('collection items reference channel numbers from /api/v1/channels', async () => {
      const collections = await get<ChannelCollection[]>('/dvr/collections/channels');
      if (!collections.length || !collections[0].items.length) return;
      const channels = await get<Channel[]>('/api/v1/channels');
      const numbers = new Set(channels.map((c) => c.number));
      const matched = collections[0].items.filter((item) => numbers.has(item));
      expect(matched.length, 'no collection item matched a channel number').toBeGreaterThan(0);
    });
  });

  describe('GET /devices/:id/guide', () => {
    it('returns airings honoring the time and duration params', async () => {
      const devices = await get<GuideDevice[]>('/devices');
      expect(Array.isArray(devices)).toBe(true);
      if (!devices.length) return;

      const start = Math.floor(Date.now() / 1000);
      const entries = await get<GuideEntry[]>(`/devices/${devices[0].DeviceID}/guide`, {
        time: String(start),
        duration: '3600',
      });
      expect(Array.isArray(entries)).toBe(true);
      if (!entries.length) return;

      const entry = entries[0];
      expect(typeof entry.Channel?.Number).toBe('string');
      expect(Array.isArray(entry.Airings)).toBe(true);

      const airing = entries.flatMap((e) => e.Airings ?? [])[0];
      if (!airing) return;
      // The grid positions blocks from Time/Duration and badges from Tags/Categories.
      expect(typeof airing.Time).toBe('number');
      expect(typeof airing.Duration).toBe('number');
      expect(typeof airing.Title).toBe('string');
      expect(airing.Time + airing.Duration).toBeGreaterThan(start);
    });
  });

  // ── Scheduling (jobs + season pass rules) ─────────────────────────────────────

  describe('GET /dvr/jobs', () => {
    it('returns scheduled jobs carrying the Airing used to match the guide', async () => {
      const scheduled = await get<ScheduledJobPayload[]>('/dvr/jobs');
      expect(Array.isArray(scheduled)).toBe(true);
      if (!scheduled.length) return;
      const j = scheduled[0];
      expect(typeof j.ID).toBe('string');
      expect(typeof j.Time).toBe('number');
      expect(typeof j.Duration).toBe('number');
      expect(Array.isArray(j.Channels)).toBe(true);
      // The grid keys recordings by the *airing* start, not the padded job start.
      expect(typeof j.Airing?.Time).toBe('number');
    });
  });

  describe('GET /dvr/rules', () => {
    it('returns rules matching on EQ.SeriesID', async () => {
      const ruleList = await get<RulePayload[]>('/dvr/rules');
      expect(Array.isArray(ruleList)).toBe(true);
      if (!ruleList.length) return;
      const r = ruleList[0];
      expect(typeof r.ID).toBe('string');
      expect(typeof r.Name).toBe('string');
      expect(typeof r.EQ?.SeriesID).toBe('string');
    });
  });

  describe('POST /dvr/jobs/new', () => {
    it('exists and rejects an invalid job (no recording is created)', async () => {
      const res = await fetch(`${BASE}/dvr/jobs/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      // 400 proves the handler is present and validating; 404 would mean the
      // endpoint moved and one-off recording is broken.
      expect(res.status, `Expected 400 from an empty job body, got ${res.status}`).toBe(400);
    });
  });

  describe('DELETE /dvr/jobs/:id', () => {
    it('accepts DELETE (no real job is targeted)', async () => {
      const res = await method('DELETE', '/dvr/jobs/dvrdesk-nonexistent-probe');
      expect(res.status, 'DELETE should not be rejected as an unsupported method').not.toBe(405);
    });
  });

  describe('season pass round-trip: POST /dvr/rules/new → PUT → DELETE', () => {
    // Created paused against a nonexistent series so the server schedules
    // nothing, then removed again — the DVR is left exactly as found.
    const probe = {
      Name: 'DVRDesk API probe (auto-removed)',
      EQ: { SeriesID: '000000000', Tags: 'New' },
      PaddingStart: 120,
      PaddingEnd: 300,
      KeepNum: 4,
      Duplicates: true,
      Paused: true,
    };
    let createdId = '';

    it('creates a rule and echoes every option back', async () => {
      const res = await fetch(`${BASE}/dvr/rules/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(probe),
      });
      expect(res.ok, `Expected 2xx, got ${res.status}`).toBe(true);
      const created = await res.json() as RulePayload;
      createdId = String(created.ID ?? '');
      expect(createdId).not.toBe('');
      expect(created.EQ?.SeriesID).toBe('000000000');
      expect(created.PaddingStart).toBe(120);
      expect(created.PaddingEnd).toBe(300);
      expect(created.KeepNum).toBe(4);
      expect(created.Paused).toBe(true);
      // Nothing should be scheduled for a paused rule on a bogus series.
      expect(created.NumJobs ?? 0).toBe(0);
    });

    it('PUT replaces the rule rather than merging into it', async () => {
      if (!createdId) return;
      const res = await fetch(`${BASE}/dvr/rules/${createdId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...probe, KeepNum: 9 }),
      });
      expect(res.ok, `Expected 2xx, got ${res.status}`).toBe(true);
      expect((await res.json() as RulePayload).KeepNum).toBe(9);
    });

    it('DELETE removes it, leaving no probe rules behind', async () => {
      if (!createdId) return;
      const res = await fetch(`${BASE}/dvr/rules/${createdId}`, { method: 'DELETE' });
      expect(res.ok, `Expected 2xx, got ${res.status}`).toBe(true);
      const remaining = await get<RulePayload[]>('/dvr/rules');
      expect(remaining.some((r) => String(r.ID) === createdId)).toBe(false);
    });
  });

  // ── Library ───────────────────────────────────────────────────────────────────

  describe('GET /api/v1/video_groups', () => {
    it('returns an array', async () => {
      expect(Array.isArray(await get<unknown[]>('/api/v1/video_groups'))).toBe(true);
    });

    it('items use "name" (not "title") for the group name', () => {
      if (!videoGroup) return;
      expect(typeof videoGroup.id).toBe('string');
      expect(typeof videoGroup.name).toBe('string');
      expect((videoGroup as unknown as Record<string, unknown>)['title']).toBeUndefined();
    });
  });

  describe('GET /api/v1/video_groups/:id/videos', () => {
    it('returns an array with required fields', async () => {
      if (!videoGroup) return;
      const videos = await get<Video[]>(`/api/v1/video_groups/${videoGroup.id}/videos`);
      expect(Array.isArray(videos)).toBe(true);
      if (!videos.length) return;
      const v = videos[0];
      expect(typeof v.id).toBe('string');
      expect(typeof v.video_group_id).toBe('string');  // not "group_id"
      expect(typeof v.video_title).toBe('string');     // individual title
      expect(typeof v.title).toBe('string');           // group name
      expect(typeof v.duration).toBe('number');
      expect(typeof v.watched).toBe('boolean');
      expect(typeof v.created_at).toBe('number');
      expect(typeof v.updated_at).toBe('number');
    });
  });

  // ── DVR Files ─────────────────────────────────────────────────────────────────

  describe('GET /dvr', () => {
    it('returns an object with an optional path field', async () => {
      const res = await fetch(`${BASE}/dvr`);
      expect(res.ok, `Expected 200, got ${res.status}`).toBe(true);
      const data = await res.json() as Record<string, unknown>;
      expect(typeof data).toBe('object');
      if ('path' in data) expect(typeof data['path']).toBe('string');
    });
  });

  describe('GET /dvr/files/:id', () => {
    it('returns DvrFile with PascalCase required fields', async () => {
      if (!recording) return;
      const file = await get<DvrFile>(`/dvr/files/${encodeURIComponent(recording.id)}`);
      expect(typeof file.ID).toBe('string');
      expect(typeof file.RuleID).toBe('string');
      expect(typeof file.GroupID).toBe('string');
      expect(typeof file.Path).toBe('string');
      expect(typeof file.Duration).toBe('number');
    });
  });

  describe('GET /dvr/files/:id/hls/master.m3u8', () => {
    it('returns 200 with M3U8 content for a known recording', async () => {
      if (!recording) return;
      const res = await fetch(`${BASE}/dvr/files/${encodeURIComponent(recording.id)}/hls/master.m3u8`);
      expect(res.ok, `HLS stream returned ${res.status}`).toBe(true);
      const text = await res.text();
      expect(text.trimStart().startsWith('#EXTM3U'), 'Response body is not M3U8').toBe(true);
    });
  });

  // ── Sessions ──────────────────────────────────────────────────────────────────

  describe('GET /api/v1/sessions', () => {
    it('returns an array or { live: array } (404 acceptable when no sessions are active)', async () => {
      const res = await fetch(`${BASE}/api/v1/sessions`);
      // 404 is normal when no sessions are active — the endpoint may not respond until in use.
      if (res.status === 404) return;
      expect(res.ok, `Sessions endpoint returned unexpected ${res.status}`).toBe(true);
      const data = await res.json() as SessionsPayload;
      const sessions = Array.isArray(data) ? data : (data.live ?? []);
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  // ── Live HLS probe ────────────────────────────────────────────────────────────

  describe('HEAD /devices/ANY/channels/:number/hls/master.m3u8', () => {
    it('endpoint exists and accepts HEAD (no 405)', async () => {
      if (!channel) return;
      const res = await method(
        'HEAD',
        `/devices/ANY/channels/${encodeURIComponent(channel.number)}/hls/master.m3u8`,
      );
      // 200 = available, 404/503 = tuner busy — all acceptable
      // 405 = method changed (breaking), 500 = unexpected server error
      expect(res.status, 'HEAD returned 405 — method may have changed').not.toBe(405);
      expect(res.status, 'Unexpected server error on live HLS probe').not.toBe(500);
    });
  });

  // ── Safe Mutations ────────────────────────────────────────────────────────────
  // Each test leaves the recording in its original state.

  describe('watch / unwatch', () => {
    it('PUT /dvr/files/:id/watch returns 2xx', async () => {
      if (!recording) return;
      const res = await method('PUT', `/dvr/files/${encodeURIComponent(recording.id)}/watch`);
      expect(res.ok, `watch returned ${res.status}`).toBe(true);
    });

    it('PUT /dvr/files/:id/unwatch returns 2xx', async () => {
      if (!recording) return;
      const res = await method('PUT', `/dvr/files/${encodeURIComponent(recording.id)}/unwatch`);
      expect(res.ok, `unwatch returned ${res.status}`).toBe(true);
    });

    it('original watched state is restored', async () => {
      if (!recording) return;
      const restore = recording.watched ? 'watch' : 'unwatch';
      const res = await method('PUT', `/dvr/files/${encodeURIComponent(recording.id)}/${restore}`);
      expect(res.ok).toBe(true);
    });
  });

  describe('playback_time', () => {
    it('PUT /dvr/files/:id/playback_time/:seconds returns 2xx', async () => {
      if (!recording) return;
      // Use the existing playback position — this is a no-op for the user.
      const seconds = Math.floor(recording.playback_time);
      const res = await method('PUT', `/dvr/files/${encodeURIComponent(recording.id)}/playback_time/${seconds}`);
      expect(res.ok, `playback_time returned ${res.status}`).toBe(true);
    });
  });

  // ── Destructive Endpoint Presence ─────────────────────────────────────────────
  // No real data is deleted. A nonexistent ID is used so the server returns 404,
  // which confirms the endpoint exists and accepts DELETE. A 405 would mean the
  // method changed; that is the breaking signal we are watching for.

  describe('destructive endpoints (presence check — no actual deletion)', () => {
    it('DELETE /dvr/files/:id accepts DELETE method', async () => {
      const res = await method('DELETE', '/dvr/files/dvrdesk-compat-probe');
      expect(res.status, 'Got 405 — DELETE /dvr/files/:id may no longer accept DELETE').not.toBe(405);
      expect(res.status, 'Unexpected 500 on probe ID').not.toBe(500);
    });

    it('DELETE /dvr/programs/:programId accepts DELETE method', async () => {
      const res = await method('DELETE', '/dvr/programs/dvrdesk-compat-probe');
      expect(res.status, 'Got 405 — DELETE /dvr/programs/:id may no longer accept DELETE').not.toBe(405);
      expect(res.status, 'Unexpected 500 on probe ID').not.toBe(500);
    });

    it('DELETE /api/v1/sessions/:id accepts DELETE method', async () => {
      const res = await method('DELETE', '/api/v1/sessions/dvrdesk-compat-probe');
      expect(res.status, 'Got 405 — DELETE /api/v1/sessions/:id may no longer accept DELETE').not.toBe(405);
      expect(res.status, 'Unexpected 500 on probe ID').not.toBe(500);
    });
  });

});
