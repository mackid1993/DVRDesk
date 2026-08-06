import { useEffect, useMemo, useRef } from 'react';
import type { Airing, GuideData } from '../api/guide';
import { guideChannelKeys, lookupAirings } from '../api/guide';
import type { Channel } from '../api/types';
import { applyLogoFallback } from '../lib/channelLogos';
import './GuideGrid.css';

const PX_PER_MINUTE = 6;
const SLOT_SECONDS = 30 * 60;

export interface GuideRow {
  id: string;
  channel: Channel;
  sourceName: string;
}

interface GuideGridProps {
  rows: GuideRow[];
  guide: GuideData | null;
  windowStart: number;
  windowEnd: number;
  now: number;
  loading: boolean;
  selectedRowId: string | null;
  pendingRowId: string | null;
  resolveLogo: (channel: Channel) => string | undefined;
  /** 'job' = this airing is scheduled, 'series' = covered by a season pass. */
  scheduleStateFor: (airing: Airing) => 'job' | 'series' | null;
  onSelect: (row: GuideRow) => void;
  onPlay: (row: GuideRow) => void;
  onOpenProgram: (row: GuideRow, airing: Airing) => void;
  onLoadMore: () => void;
  hasMore: boolean;
}

function offsetPx(seconds: number, windowStart: number): number {
  return ((seconds - windowStart) / 60) * PX_PER_MINUTE;
}

function formatSlot(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRange(airing: Airing): string {
  return `${formatSlot(airing.start)} – ${formatSlot(airing.end)}`;
}

function airingTooltip(airing: Airing, channel: Channel): string {
  const lines = [`${channel.number} ${channel.name} • ${formatRange(airing)}`, airing.title];
  if (airing.episodeTitle) {
    const se = airing.seasonNumber && airing.episodeNumber
      ? `S${airing.seasonNumber}E${airing.episodeNumber} · `
      : '';
    lines.push(`${se}${airing.episodeTitle}`);
  }
  if (airing.summary) lines.push('', airing.summary);
  const meta = [
    airing.isNew ? 'NEW' : '',
    airing.isLive ? 'LIVE' : '',
    airing.releaseYear ? String(airing.releaseYear) : '',
    airing.contentRating,
  ].filter(Boolean);
  if (meta.length > 0) lines.push('', meta.join(' · '));
  return lines.join('\n');
}

/** Clip an airing to the visible window; returns null when it falls outside. */
function clipToWindow(
  airing: Airing,
  windowStart: number,
  windowEnd: number
): { left: number; width: number } | null {
  const start = Math.max(airing.start, windowStart);
  const end = Math.min(airing.end, windowEnd);
  if (end <= start) return null;
  return {
    left: offsetPx(start, windowStart),
    width: Math.max(offsetPx(end, windowStart) - offsetPx(start, windowStart), 2),
  };
}

export default function GuideGrid({
  rows,
  guide,
  windowStart,
  windowEnd,
  now,
  loading,
  selectedRowId,
  pendingRowId,
  resolveLogo,
  scheduleStateFor,
  onSelect,
  onPlay,
  onOpenProgram,
  onLoadMore,
  hasMore,
}: GuideGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const trackWidth = offsetPx(windowEnd, windowStart);

  const slots = useMemo(() => {
    const out: number[] = [];
    for (let t = windowStart; t < windowEnd; t += SLOT_SECONDS) out.push(t);
    return out;
  }, [windowStart, windowEnd]);

  const nowOffset = now >= windowStart && now <= windowEnd ? offsetPx(now, windowStart) : null;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const handleScroll = () => {
      if (!hasMore) return;
      const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (remaining < 240) onLoadMore();
    };

    handleScroll();
    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, [hasMore, onLoadMore, rows.length]);

  return (
    <div className="guide" ref={scrollRef}>
      <div className="guide__inner">
        <div className="guide__timeline">
          <div className="guide__corner">
            {loading ? 'Loading guide…' : `${rows.length} channel${rows.length === 1 ? '' : 's'}`}
          </div>
          <div className="guide__slots" style={{ width: trackWidth }}>
            {slots.map((slot) => (
              <div
                key={slot}
                className="guide__slot"
                style={{ left: offsetPx(slot, windowStart), width: (SLOT_SECONDS / 60) * PX_PER_MINUTE }}
              >
                {formatSlot(slot)}
              </div>
            ))}
            {nowOffset !== null && (
              <div className="guide__now-marker" style={{ left: nowOffset }} aria-hidden="true" />
            )}
          </div>
        </div>

        <div className="guide__rows">
          {rows.map((row) => {
            const airings = lookupAirings(
              guide,
              guideChannelKeys(row.channel.source_id, row.channel.number, row.channel.id)
            );
            const logo = resolveLogo(row.channel);
            const isSelected = selectedRowId === row.id;

            return (
              <div key={row.id} className={`guide__row ${isSelected ? 'guide__row--active' : ''}`}>
                <button
                  type="button"
                  className="guide__channel"
                  title={`${row.channel.number} ${row.channel.name} · ${row.sourceName || 'Unknown Source'}`}
                  onClick={() => onPlay(row)}
                >
                  {logo ? (
                    <img
                      className="guide__channel-logo"
                      src={logo}
                      alt=""
                      aria-hidden="true"
                      onError={(e) => applyLogoFallback(e.currentTarget)}
                    />
                  ) : (
                    <span className="guide__channel-icon" aria-hidden="true">📺</span>
                  )}
                  <span className="guide__channel-text">
                    <span className="guide__channel-number">{row.channel.number}</span>
                    <span className="guide__channel-name">{row.channel.name}</span>
                  </span>
                  {pendingRowId === row.id && <span className="guide__channel-pending">•••</span>}
                </button>

                <div className="guide__track" style={{ width: trackWidth }}>
                  {nowOffset !== null && (
                    <div className="guide__now-line" style={{ left: nowOffset }} aria-hidden="true" />
                  )}
                  {airings.length === 0 && !loading && (
                    <div className="guide__empty">No guide data</div>
                  )}
                  {airings.map((airing) => {
                    const box = clipToWindow(airing, windowStart, windowEnd);
                    if (!box) return null;
                    const isOnNow = now >= airing.start && now < airing.end;
                    const scheduled = scheduleStateFor(airing);
                    const classes = [
                      'guide__program',
                      isOnNow ? 'guide__program--now' : '',
                      airing.isMovie ? 'guide__program--movie' : '',
                      airing.isSports ? 'guide__program--sports' : '',
                      scheduled ? 'guide__program--scheduled' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');

                    return (
                      <button
                        key={airing.id}
                        type="button"
                        className={classes}
                        style={{ left: box.left, width: box.width }}
                        title={airingTooltip(airing, row.channel)}
                        onClick={() => {
                          onSelect(row);
                          onOpenProgram(row, airing);
                        }}
                      >
                        <span className="guide__program-title">
                          {scheduled && (
                            <span
                              className={`guide__rec guide__rec--${scheduled}`}
                              title={scheduled === 'series' ? 'Season pass' : 'Scheduled to record'}
                              aria-label={scheduled === 'series' ? 'Season pass' : 'Scheduled to record'}
                            >
                              ⏺
                            </span>
                          )}
                          {airing.isNew && <span className="guide__badge guide__badge--new">NEW</span>}
                          {airing.isLive && <span className="guide__badge guide__badge--live">LIVE</span>}
                          {airing.title}
                        </span>
                        {box.width > 110 && (airing.episodeTitle || airing.summary) && (
                          <span className="guide__program-sub">
                            {airing.episodeTitle || airing.summary}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {rows.length === 0 && !loading && (
            <p className="guide__status">No channels for the selected filter.</p>
          )}
          {hasMore && <p className="guide__status">Scroll for more channels…</p>}
        </div>
      </div>
    </div>
  );
}
