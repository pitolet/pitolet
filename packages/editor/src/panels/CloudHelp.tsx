import { CloudFeedbackDialog, IconButton, Popover, Tooltip } from '@pitolet/ui';
import { CircleHelp, MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  recentCloudErrors,
  setCloudDiagnosticsEnabled,
  setCloudProblemContext,
} from '../cloudDiagnostics.js';
import { useEditor } from '../store/index.js';
import { apiUrl, isShareSession, serverBase } from '../sync/serverBase.js';

type CloudSession = {
  kind: 'user' | 'agent' | 'share';
  workspace: { id: string; slug: string; name: string };
};

export function CloudHelp() {
  const documentId = useEditor((state) => state.doc?.id ?? null);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    if (!serverBase || isShareSession) return;
    const controller = new AbortController();
    void fetch(apiUrl('/api/session'), { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<CloudSession>) : null))
      .then((value) => {
        if (value?.kind !== 'user') return;
        setCloudDiagnosticsEnabled(true);
        setSession(value);
        setCloudProblemContext({ workspaceId: value.workspace.id });
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('[pitolet] cloud help context unavailable');
        }
      });
    return () => {
      controller.abort();
      setCloudDiagnosticsEnabled(false);
    };
  }, []);

  useEffect(() => {
    setCloudProblemContext({ documentId });
    if (!session || !documentId) return;
    const key = `pitolet.event.editor-opened.${session.workspace.id}.${documentId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // Continue without deduplication when storage is blocked.
    }
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'editor_opened',
        source: 'editor',
        workspaceId: session.workspace.id,
        documentId,
      }),
    }).catch(() => {});
  }, [documentId, session]);

  if (!session) return null;
  return (
    <>
      <Popover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        align="end"
        className="ptl-cloud-help-popover"
        trigger={
          <span>
            <Tooltip content="Help">
              <IconButton label="Help">
                <CircleHelp size={15} />
              </IconButton>
            </Tooltip>
          </span>
        }
      >
        <div className="ptl-cloud-help-menu">
          <strong>Help</strong>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setFeedbackOpen(true);
            }}
          >
            <MessageSquareText size={15} />
            <span>
              <strong>Send feedback</strong>
              <small>Report a problem or ask for help</small>
            </span>
          </button>
        </div>
      </Popover>
      <CloudFeedbackDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        source="editor"
        workspaceId={session.workspace.id}
        documentId={documentId}
        release={import.meta.env.VITE_PITOLET_RELEASE ?? 'development'}
        recentErrors={recentCloudErrors()}
      />
    </>
  );
}
