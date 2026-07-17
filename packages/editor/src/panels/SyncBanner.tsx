import { AlertTriangle, WifiOff, X } from 'lucide-react';
import { useEditor } from '../store/index.js';
import './SyncBanner.css';

/** Persistent, actionable sync feedback. Never hide lost-work risks in a dot. */
export function SyncBanner() {
  const hasDocument = useEditor((s) => s.doc !== null);
  const connected = useEditor((s) => s.connected);
  const issue = useEditor((s) => s.syncIssue);
  const setIssue = useEditor((s) => s.setSyncIssue);
  const offline = hasDocument && !connected;

  if (!offline && !issue) return null;
  // A reconciliation failure is more useful than the generic offline state:
  // some failures intentionally pause the connection to prevent duplicate or
  // lost edits and will not heal through an automatic reconnect.
  const message = issue ?? 'Connection lost. Editing is paused while Pitolet reconnects.';
  const hasIssue = Boolean(issue);
  const Icon = hasIssue ? AlertTriangle : WifiOff;

  return (
    <div
      className={`ptl-sync-banner ${hasIssue ? 'ptl-sync-banner--error' : 'ptl-sync-banner--offline'}`}
      role="alert"
      aria-live="assertive"
    >
      <Icon size={14} />
      <span>{message}</span>
      {!offline && hasIssue && (
        <button type="button" aria-label="Dismiss sync message" onClick={() => setIssue(null)}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}
