import { IconButton, Popover } from '@pitolet/ui';
import { History, Sparkles, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useEditor, type ActivityEntry } from '../store/index.js';
import './ActivityFeed.css';

/**
 * Who changed what, when — the attribution surface for human/agent
 * collaboration. Agent rows glow; clicking a row selects the touched nodes.
 */
export function ActivityButton() {
  const count = useEditor((s) => s.activity.length);
  return (
    <Popover
      className="ptl-activity-popover"
      trigger={
        <IconButton label="Activity" title="Activity">
          <History size={15} />
        </IconButton>
      }
      align="end"
    >
      <ActivityList key={count} />
    </Popover>
  );
}

function ActivityList() {
  const activity = useEditor((s) => s.activity);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, []);

  if (activity.length === 0) {
    return <div className="ptl-activity-empty">No activity yet</div>;
  }

  return (
    <div className="ptl-activity-list">
      {activity.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} now={now} />
      ))}
    </div>
  );
}

function ActivityRow({ entry, now }: { entry: ActivityEntry; now: number }) {
  const Icon = entry.kind === 'agent' ? Sparkles : entry.kind === 'peer' ? Users : User;
  const kindLabel = entry.kind === 'agent' ? 'Agent' : entry.kind === 'peer' ? 'Peer' : 'You';

  return (
    <button
      type="button"
      className={`ptl-activity-row ptl-activity-row--${entry.kind}`}
      onClick={() => {
        const store = useEditor.getState();
        const existing = entry.nodeIds.filter((id) => store.doc?.nodes[id]);
        if (existing.length > 0) store.select(existing);
      }}
      title={entry.nodeIds.length > 0 ? 'Click to select the changed nodes' : undefined}
    >
      <span className="ptl-activity-icon">
        <Icon size={12} />
      </span>
      <span className="ptl-activity-main">
        <span className="ptl-activity-label">
          {entry.actorName ? (
            <>
              <span className="ptl-activity-actor">{entry.actorName}</span>
              <span>{entry.label}</span>
            </>
          ) : (
            entry.label
          )}
        </span>
        <span className="ptl-activity-meta">
          <span>{kindLabel}</span>
          <span>{formatRelative(entry.time, now)}</span>
          {entry.nodeIds.length > 1 && <span>{entry.nodeIds.length} nodes</span>}
        </span>
      </span>
    </button>
  );
}

function formatRelative(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/** Pulsing indicator while an agent is actively editing (recent MCP patch). */
export function AgentBadge() {
  const activeUntil = useEditor((s) => s.agentActiveUntil);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const remaining = activeUntil - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    setNow(Date.now());
    const timeout = setTimeout(() => setNow(Date.now()), remaining + 10);
    return () => clearTimeout(timeout);
  }, [activeUntil]);

  if (now >= activeUntil) return null;
  return (
    <span className="ptl-agent-badge" title="An AI agent is editing this document via MCP">
      <Sparkles size={12} />
      Agent editing
    </span>
  );
}
