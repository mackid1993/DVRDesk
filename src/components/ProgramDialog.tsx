import { useEffect, useMemo, useState } from 'react';
import type { Airing } from '../api/guide';
import type {
  RecordOptions,
  ScheduledJob,
  SchedulePadding,
  SeriesPassOptions,
  SeriesRule,
} from '../api/scheduling';
import type { Channel } from '../api/types';
import './ProgramDialog.css';

export interface ProgramDialogProps {
  airing: Airing;
  channel: Channel;
  sourceName: string;
  job: ScheduledJob | null;
  rule: SeriesRule | null;
  defaultPadding: SchedulePadding;
  busy: string | null;
  error: string | null;
  onClose: () => void;
  onWatch: () => void;
  onRecord: (options: RecordOptions) => void;
  onCancelRecord: (job: ScheduledJob) => void;
  onRecordSeries: (options: SeriesPassOptions) => void;
  onUpdateSeries: (rule: SeriesRule, options: SeriesPassOptions) => void;
  onCancelSeries: (rule: SeriesRule) => void;
}

const MINUTE = 60;

function clockTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function dayLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function minutesOf(seconds: number): number {
  return Math.round(seconds / MINUTE);
}

/** Numeric minutes field used for every padding input. */
function PaddingField({
  label,
  value,
  onChange,
  id,
}: {
  label: string;
  value: number;
  onChange: (minutes: number) => void;
  id: string;
}) {
  return (
    <label className="progdlg__field" htmlFor={id}>
      <span className="progdlg__field-label">{label}</span>
      <span className="progdlg__field-input">
        <input
          id={id}
          type="number"
          min={0}
          max={180}
          step={1}
          value={value}
          onChange={(e) => onChange(Math.max(0, Math.min(180, Number(e.target.value) || 0)))}
        />
        <span className="progdlg__field-unit">min</span>
      </span>
    </label>
  );
}

export default function ProgramDialog({
  airing,
  channel,
  sourceName,
  job,
  rule,
  defaultPadding,
  busy,
  error,
  onClose,
  onWatch,
  onRecord,
  onCancelRecord,
  onRecordSeries,
  onUpdateSeries,
  onCancelSeries,
}: ProgramDialogProps) {
  // One-off padding seeds from the existing job when there is one, so editing a
  // scheduled recording shows what was actually booked.
  const [startPad, setStartPad] = useState(() =>
    minutesOf(job ? airing.start - job.time : defaultPadding.start)
  );
  const [endPad, setEndPad] = useState(() =>
    minutesOf(job ? job.time + job.duration - airing.end : defaultPadding.end)
  );

  const [seriesNewOnly, setSeriesNewOnly] = useState(rule?.newOnly ?? true);
  const [seriesKeep, setSeriesKeep] = useState(rule?.keepNum ?? 0);
  const [seriesStartPad, setSeriesStartPad] = useState(() =>
    minutesOf(rule ? rule.paddingStart : defaultPadding.start)
  );
  const [seriesEndPad, setSeriesEndPad] = useState(() =>
    minutesOf(rule ? rule.paddingEnd : defaultPadding.end)
  );
  const [seriesDuplicates, setSeriesDuplicates] = useState(rule?.duplicates ?? false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const recordWindow = useMemo(() => {
    const start = airing.start - startPad * MINUTE;
    const end = airing.end + endPad * MINUTE;
    return {
      start,
      end,
      minutes: Math.round((end - start) / MINUTE),
    };
  }, [airing.start, airing.end, startPad, endPad]);

  const seriesOptions: SeriesPassOptions = {
    newOnly: seriesNewOnly,
    keepNum: seriesKeep,
    paddingStart: seriesStartPad * MINUTE,
    paddingEnd: seriesEndPad * MINUTE,
    duplicates: seriesDuplicates,
    rerecord: rule?.rerecord ?? false,
    paused: rule?.paused ?? false,
    priority: rule?.priority ?? 0,
  };

  const seriesDirty =
    rule !== null
    && (rule.newOnly !== seriesNewOnly
      || rule.keepNum !== seriesKeep
      || rule.paddingStart !== seriesStartPad * MINUTE
      || rule.paddingEnd !== seriesEndPad * MINUTE
      || rule.duplicates !== seriesDuplicates);

  const canRecordSeries = airing.seriesId.length > 0;
  const episodeLine = [
    airing.seasonNumber && airing.episodeNumber
      ? `S${airing.seasonNumber} E${airing.episodeNumber}`
      : '',
    airing.episodeTitle,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="media-modal-backdrop" onClick={onClose}>
      <div
        className="media-modal progdlg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={airing.title}
      >
        <div className="media-modal__header">
          <h3>{airing.title}</h3>
          <button className="media-modal__close" onClick={onClose}>Close</button>
        </div>

        <div className="progdlg__body">
          <div className="progdlg__overview">
            {airing.image && (
              <img className="progdlg__image" src={airing.image} alt="" aria-hidden="true" />
            )}
            <div className="progdlg__meta">
              {episodeLine && <p className="progdlg__episode">{episodeLine}</p>}
              <p className="progdlg__when">
                {channel.number} {channel.name} · {sourceName || 'Unknown Source'}
                <br />
                {dayLabel(airing.start)}, {clockTime(airing.start)} – {clockTime(airing.end)}
              </p>
              <p className="progdlg__badges">
                {airing.isNew && <span className="progdlg__badge progdlg__badge--new">NEW</span>}
                {airing.isLive && <span className="progdlg__badge progdlg__badge--live">LIVE</span>}
                {airing.contentRating && <span className="progdlg__badge">{airing.contentRating}</span>}
                {airing.releaseYear ? <span className="progdlg__badge">{airing.releaseYear}</span> : null}
              </p>
              {airing.summary && <p className="progdlg__summary">{airing.summary}</p>}
            </div>
          </div>

          {error && <p className="progdlg__error">⚠ {error}</p>}

          {/* ── One-off recording ─────────────────────────────────────── */}
          <section className="progdlg__section">
            <h4 className="progdlg__section-title">
              Record this episode
              {job && <span className="progdlg__scheduled-tag">Scheduled</span>}
            </h4>

            <div className="progdlg__fields">
              <PaddingField id="pad-start" label="Start early" value={startPad} onChange={setStartPad} />
              <PaddingField id="pad-end" label="Stop late" value={endPad} onChange={setEndPad} />
            </div>

            <p className="progdlg__computed">
              Records <strong>{clockTime(recordWindow.start)} – {clockTime(recordWindow.end)}</strong>
              {' '}({recordWindow.minutes} min)
            </p>

            <div className="progdlg__actions">
              {job ? (
                <>
                  <button
                    type="button"
                    className="progdlg__btn progdlg__btn--danger"
                    disabled={busy !== null}
                    onClick={() => onCancelRecord(job)}
                  >
                    {busy === 'cancel-job' ? 'Cancelling…' : 'Cancel Recording'}
                  </button>
                  <button
                    type="button"
                    className="progdlg__btn"
                    disabled={busy !== null}
                    onClick={() => onRecord({ paddingStart: startPad * MINUTE, paddingEnd: endPad * MINUTE })}
                  >
                    {busy === 'record' ? 'Saving…' : 'Update Times'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="progdlg__btn progdlg__btn--primary"
                  disabled={busy !== null}
                  onClick={() => onRecord({ paddingStart: startPad * MINUTE, paddingEnd: endPad * MINUTE })}
                >
                  {busy === 'record' ? 'Scheduling…' : '⏺ Record'}
                </button>
              )}
            </div>
          </section>

          {/* ── Season pass ───────────────────────────────────────────── */}
          <section className="progdlg__section">
            <h4 className="progdlg__section-title">
              Season pass
              {rule && <span className="progdlg__scheduled-tag">Active · {rule.numJobs} upcoming</span>}
            </h4>

            {!canRecordSeries ? (
              <p className="progdlg__note">
                This airing has no series ID, so it can only be recorded as a one-off.
              </p>
            ) : (
              <>
                <div className="progdlg__fields">
                  <label className="progdlg__check">
                    <input
                      type="checkbox"
                      checked={seriesNewOnly}
                      onChange={(e) => setSeriesNewOnly(e.target.checked)}
                    />
                    New episodes only
                  </label>
                  <label className="progdlg__check">
                    <input
                      type="checkbox"
                      checked={seriesDuplicates}
                      onChange={(e) => setSeriesDuplicates(e.target.checked)}
                    />
                    Allow duplicates
                  </label>
                  <label className="progdlg__field" htmlFor="series-keep">
                    <span className="progdlg__field-label">Keep</span>
                    <span className="progdlg__field-input">
                      <input
                        id="series-keep"
                        type="number"
                        min={0}
                        max={99}
                        value={seriesKeep}
                        onChange={(e) => setSeriesKeep(Math.max(0, Math.min(99, Number(e.target.value) || 0)))}
                      />
                      <span className="progdlg__field-unit">{seriesKeep === 0 ? 'all' : 'newest'}</span>
                    </span>
                  </label>
                </div>

                <div className="progdlg__fields">
                  <PaddingField
                    id="series-pad-start"
                    label="Start early"
                    value={seriesStartPad}
                    onChange={setSeriesStartPad}
                  />
                  <PaddingField
                    id="series-pad-end"
                    label="Stop late"
                    value={seriesEndPad}
                    onChange={setSeriesEndPad}
                  />
                </div>

                <div className="progdlg__actions">
                  {rule ? (
                    <>
                      <button
                        type="button"
                        className="progdlg__btn progdlg__btn--danger"
                        disabled={busy !== null}
                        onClick={() => onCancelSeries(rule)}
                      >
                        {busy === 'cancel-series' ? 'Removing…' : 'Remove Pass'}
                      </button>
                      <button
                        type="button"
                        className="progdlg__btn"
                        disabled={busy !== null || !seriesDirty}
                        onClick={() => onUpdateSeries(rule, seriesOptions)}
                      >
                        {busy === 'update-series' ? 'Saving…' : 'Save Changes'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="progdlg__btn progdlg__btn--primary"
                      disabled={busy !== null}
                      onClick={() => onRecordSeries(seriesOptions)}
                    >
                      {busy === 'record-series' ? 'Creating…' : '⏺ Record Series'}
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          <div className="progdlg__actions progdlg__actions--footer">
            <button type="button" className="progdlg__btn" onClick={onWatch}>
              ▶ Watch Channel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
