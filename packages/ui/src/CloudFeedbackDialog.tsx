import { Paperclip, Send, X } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button } from './primitives/Button.js';

export type CloudFeedbackCategory = 'broken' | 'confusing' | 'feature' | 'general';

export interface CloudFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: 'dashboard' | 'editor';
  workspaceId?: string | null;
  documentId?: string | null;
  release?: string;
  recentErrors?: string[];
}

type Context = {
  workspaceId: string | null;
  documentId: string | null;
  canGrantSupportAccess: boolean;
};

const categoryOptions: Array<{ value: CloudFeedbackCategory; label: string }> = [
  { value: 'broken', label: 'Something broke' },
  { value: 'confusing', label: 'I couldn’t figure something out' },
  { value: 'feature', label: 'I’m missing a feature' },
  { value: 'general', label: 'General feedback' },
];

function browserFamily(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other browser';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that screenshot.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function CloudFeedbackDialog({
  open,
  onOpenChange,
  source,
  workspaceId = null,
  documentId = null,
  release,
  recentErrors = [],
}: CloudFeedbackDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState<CloudFeedbackCategory>('general');
  const [message, setMessage] = useState('');
  const [wantsReply, setWantsReply] = useState(true);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [grantSupportAccess, setGrantSupportAccess] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspaceId', workspaceId);
    if (documentId) params.set('documentId', documentId);
    const suffix = params.size ? `?${params}` : '';
    let cancelled = false;
    void fetch(`/api/feedback/context${suffix}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Feedback is not available in this session.');
        return response.json() as Promise<Context>;
      })
      .then((value) => {
        if (!cancelled) setContext(value);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Could not load feedback.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, documentId]);

  function resetAndClose() {
    setCategory('general');
    setMessage('');
    setWantsReply(true);
    setIncludeDiagnostics(false);
    setGrantSupportAccess(false);
    setScreenshot(null);
    setStatus('idle');
    setError(null);
    setContext(null);
    onOpenChange(false);
  }

  function chooseScreenshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return setScreenshot(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Use a PNG, JPEG, or WebP screenshot.');
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('The screenshot must be 5 MB or smaller.');
      event.target.value = '';
      return;
    }
    setError(null);
    setScreenshot(file);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || status === 'submitting') return;
    setStatus('submitting');
    setError(null);
    try {
      const screenshotBody = screenshot
        ? { mime: screenshot.type, data: await fileToBase64(screenshot) }
        : null;
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category,
          message: message.trim(),
          wantsReply,
          workspaceId: context?.workspaceId ?? workspaceId,
          documentId: context?.documentId ?? documentId,
          route: window.location.pathname,
          browser: browserFamily(),
          release,
          includeDiagnostics,
          diagnostics: includeDiagnostics
            ? {
                clientErrors: recentErrors.slice(-5),
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
              }
            : undefined,
          screenshot: screenshotBody,
          grantSupportAccess: grantSupportAccess && context?.canGrantSupportAccess === true,
          source,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Could not send feedback.');
      }
      setStatus('sent');
    } catch (reason) {
      setStatus('idle');
      setError(reason instanceof Error ? reason.message : 'Could not send feedback.');
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="ptl-feedback-dialog"
      onClose={() => onOpenChange(false)}
      onCancel={(event) => {
        event.preventDefault();
        resetAndClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) resetAndClose();
      }}
    >
      <div className="ptl-feedback-panel">
        <button
          className="ptl-feedback-close"
          type="button"
          onClick={resetAndClose}
          aria-label="Close feedback"
        >
          <X size={17} />
        </button>
        {status === 'sent' ? (
          <div className="ptl-feedback-success" role="status">
            <h2>Feedback sent</h2>
            <p>Thanks. It’s in the Pitolet feedback inbox.</p>
            <Button variant="primary" onClick={resetAndClose}>
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="ptl-feedback-heading">
              <h2>Send feedback</h2>
              <p>Tell us what happened or what you need.</p>
            </div>
            <label>
              <span>Type</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as CloudFeedbackCategory)}
              >
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Message</span>
              <textarea
                autoFocus
                required
                maxLength={5000}
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="What were you trying to do?"
              />
            </label>
            <div className="ptl-feedback-options">
              <label>
                <input
                  type="checkbox"
                  checked={wantsReply}
                  onChange={(event) => setWantsReply(event.target.checked)}
                />{' '}
                I’d like a reply
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeDiagnostics}
                  onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                />{' '}
                Include technical details
              </label>
              {context?.canGrantSupportAccess && (
                <label>
                  <input
                    type="checkbox"
                    checked={grantSupportAccess}
                    onChange={(event) => setGrantSupportAccess(event.target.checked)}
                  />{' '}
                  Let Pitolet support open this document for 7 days
                </label>
              )}
            </div>
            {includeDiagnostics && (
              <div className="ptl-feedback-disclosure">
                Includes this page, browser family, app version, viewport size, workspace and
                document IDs, and up to five recent error messages. It never includes document
                contents, prompts, tokens, or text you entered.
              </div>
            )}
            <label className="ptl-feedback-file">
              <Paperclip size={15} />
              <span>{screenshot ? screenshot.name : 'Attach a screenshot'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={chooseScreenshot}
              />
            </label>
            {error && (
              <div className="ptl-feedback-error" role="alert">
                {error}
              </div>
            )}
            <div className="ptl-feedback-actions">
              <Button type="button" variant="ghost" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!message.trim() || status === 'submitting'}
              >
                <Send size={14} /> {status === 'submitting' ? 'Sending…' : 'Send feedback'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
