import { Button } from '@pitolet/ui';
import { RotateCcw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type Snapshot,
  type SnapshotKind,
  type WorkspaceSummary,
} from '../../api.js';
import { relativeTime } from '../../time.js';

/**
 * Version history for one document. Any member browses the snapshot list;
 * editor|owner can save a named version and restore any snapshot. A restore
 * first snapshots the current live state as a 'pre-restore' entry — so nothing
 * is ever lost — then replaces the doc; that new pre-restore snapshot appearing
 * at the top of the list is the visible proof.
 */
export function History({ ws, docId }: { ws: WorkspaceSummary; docId: string }) {
  const canEdit = ws.role === 'owner' || ws.role === 'editor';
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function reload() {
    try {
      const { snapshots } = await api.snapshots(ws.id, docId);
      setSnapshots(snapshots);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load history');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id, docId]);

  async function restore(snap: Snapshot) {
    setError(null);
    setNote(null);
    try {
      const { rev } = await api.restoreSnapshot(ws.id, docId, snap.id);
      setNote(
        `Restored to rev ${snap.rev}. The document is now at rev ${rev}. ` +
          'The previous state was saved first, as the "Before restore" entry.',
      );
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not restore version');
    }
  }

  return (
    <>
      {canEdit ? (
        <SaveVersionForm
          onSave={async (label) => {
            setError(null);
            setNote(null);
            try {
              await api.createSnapshot(ws.id, docId, { label });
              await reload();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Could not save version');
              throw err;
            }
          }}
        />
      ) : (
        <div className="ptl-dash-notice">
          Your role is read-only. You can browse version history, but not save or restore versions.
        </div>
      )}

      {note && <div className="ptl-dash-notice">{note}</div>}
      {error && (
        <div className="ptl-dash-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {snapshots === null ? (
        <div className="ptl-dash-empty">Loading history…</div>
      ) : snapshots.length === 0 ? (
        <div className="ptl-dash-empty">No saved versions yet.</div>
      ) : (
        <div className="ptl-dash-list">
          {snapshots.map((s) => (
            <div className="ptl-dash-row" key={s.id}>
              <div className="ptl-dash-row-main">
                <span className="ptl-dash-row-name">
                  <KindBadge kind={s.kind} />
                  {s.label ? (
                    <span style={{ marginLeft: 8 }}>{s.label}</span>
                  ) : (
                    <span style={{ marginLeft: 8, color: 'var(--ptl-text-3)' }}>
                      {defaultLabel(s.kind)}
                    </span>
                  )}
                </span>
                <span className="ptl-dash-row-meta">
                  rev {s.rev} · {relativeTime(s.createdAt)}
                </span>
              </div>
              {canEdit && (
                <div className="ptl-dash-row-actions">
                  <RestoreButton snap={s} onConfirm={() => restore(s)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const KIND_LABEL: Record<SnapshotKind, string> = {
  auto: 'Auto',
  named: 'Named',
  'pre-restore': 'Pre-restore',
};

function KindBadge({ kind }: { kind: SnapshotKind }) {
  return <span className={`ptl-badge ptl-badge--snap-${kind}`}>{KIND_LABEL[kind]}</span>;
}

function defaultLabel(kind: SnapshotKind): string {
  if (kind === 'auto') return 'Automatic snapshot';
  if (kind === 'pre-restore') return 'Before restore';
  return 'Version';
}

function SaveVersionForm({ onSave }: { onSave: (label: string) => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    try {
      await onSave(label.trim());
      setLabel('');
    } catch {
      // Error surfaced by the parent; keep the label so it can be retried.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ptl-dash-form" onSubmit={submit}>
      <div className="ptl-dash-form-row">
        <div className="ptl-dash-field" style={{ margin: 0, flex: '2 1 240px' }}>
          <label className="ptl-dash-label" htmlFor="snap-label">
            Save a version
          </label>
          <input
            id="snap-label"
            className="ptl-dash-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Before the redesign"
          />
        </div>
        <div className="ptl-dash-form-actions" style={{ margin: 0, alignItems: 'flex-end' }}>
          <Button type="submit" variant="primary" disabled={busy || !label.trim()}>
            Save version
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Two-step restore: the first click arms an inline confirm that spells out the
 * safety guarantee (current state is snapshotted first). Auto-disarms so a
 * stray armed button can't fire later.
 */
function RestoreButton({ snap, onConfirm }: { snap: Snapshot; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <Button variant="outline" size="sm" onClick={() => setArmed(true)}>
        <RotateCcw size={13} /> Restore
      </Button>
    );
  }

  return (
    <div className="ptl-dash-restore-confirm">
      <span className="ptl-dash-row-meta">
        Restore to rev {snap.rev}? The current state is saved as a snapshot first.
      </span>
      <div className="ptl-dash-row-actions">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            onConfirm();
            setArmed(false);
          }}
        >
          Confirm restore
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
