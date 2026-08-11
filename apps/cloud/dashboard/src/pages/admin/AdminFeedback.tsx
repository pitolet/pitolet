import { Button } from '@pitolet/ui';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Image,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type FeedbackCategory,
  type FeedbackDetail,
  type FeedbackStatus,
  type FeedbackSummary,
} from '../../api.js';
import { AdminShell } from '../../components/AdminShell.js';
import { navigate } from '../../router.js';
import { formatDate, relativeTime } from '../../time.js';

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  broken: 'Something broke',
  confusing: 'Could not figure it out',
  feature: 'Missing feature',
  general: 'General feedback',
};

export function AdminFeedback({ feedbackId }: { feedbackId?: string }) {
  return feedbackId ? <FeedbackDetailPage feedbackId={feedbackId} /> : <FeedbackInbox />;
}

function FeedbackInbox() {
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [items, setItems] = useState<FeedbackSummary[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.adminFeedback({ status, category, query: appliedQuery });
      setItems(response.feedback);
      setUnreadCount(response.unreadCount);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not load feedback.');
    }
  }, [appliedQuery, category, status]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  function search(event: FormEvent) {
    event.preventDefault();
    setAppliedQuery(query.trim());
  }

  return (
    <AdminShell
      active="feedback"
      title="Feedback"
      description="Messages sent from the dashboard and editor."
      actions={unreadCount ? <span className="ptl-admin-count">{unreadCount} new</span> : undefined}
    >
      <form className="ptl-admin-toolbar" onSubmit={search}>
        <label className="ptl-admin-search">
          <Search size={15} />
          <span className="ptl-visually-hidden">Search feedback</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search messages, names, or email"
          />
        </label>
        <label>
          <span className="ptl-visually-hidden">Status</span>
          <select
            className="ptl-admin-select"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="reviewing">Reviewing</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label>
          <span className="ptl-visually-hidden">Category</span>
          <select
            className="ptl-admin-select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">All types</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {error ? (
        <FeedbackError message={error} retry={load} />
      ) : items === null ? (
        <FeedbackSkeleton />
      ) : items.length === 0 ? (
        <div className="ptl-state-card">
          <MessageSquareText size={20} />
          <strong>No feedback found</strong>
          <span>New messages will appear here.</span>
        </div>
      ) : (
        <div className="ptl-admin-feed-list">
          {items.map((item) => (
            <button
              type="button"
              className={`ptl-admin-feed-row is-${item.status}`}
              key={item.id}
              onClick={() => navigate(`/admin/feedback/${item.id}`)}
            >
              <span className={`ptl-admin-status-dot is-${item.status}`} />
              <span className="ptl-admin-feed-main">
                <span>
                  <strong>{CATEGORY_LABELS[item.category]}</strong>
                  <small>{item.user.name || item.user.email}</small>
                </span>
                <p>{item.message}</p>
              </span>
              <span className="ptl-admin-feed-context">
                <span>{item.workspace?.name ?? 'No workspace'}</span>
                <small>{relativeTime(item.createdAt)}</small>
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

function FeedbackDetailPage({ feedbackId }: { feedbackId: string }) {
  const [item, setItem] = useState<FeedbackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItem((await api.adminFeedbackItem(feedbackId)).feedback);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not load feedback.');
    }
  }, [feedbackId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(status: FeedbackStatus) {
    if (!item) return;
    const previous = item.status;
    setItem({ ...item, status });
    try {
      await api.updateFeedback(item.id, status);
    } catch (reason) {
      setItem({ ...item, status: previous });
      setError(reason instanceof ApiError ? reason.message : 'Could not update feedback.');
    }
  }

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!item || !reply.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.replyToFeedback(item.id, reply.trim());
      setReply('');
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not send the reply.');
    } finally {
      setSending(false);
    }
  }

  return (
    <AdminShell
      active="feedback"
      title={item ? CATEGORY_LABELS[item.category] : 'Feedback'}
      description={item ? `From ${item.user.name || item.user.email}` : 'Feedback details'}
    >
      <button type="button" className="ptl-dash-back" onClick={() => navigate('/admin/feedback')}>
        <ArrowLeft size={14} /> Feedback
      </button>
      {error && !item ? (
        <FeedbackError message={error} retry={load} />
      ) : !item ? (
        <FeedbackSkeleton />
      ) : (
        <div className="ptl-admin-detail-grid">
          <main className="ptl-admin-stack">
            <section className="ptl-admin-panel ptl-admin-feedback-message">
              <div className="ptl-admin-panel-head">
                <div>
                  <h2>{CATEGORY_LABELS[item.category]}</h2>
                  <p>
                    {formatDate(item.createdAt)} · {item.user.email}
                  </p>
                </div>
                <span className={`ptl-admin-status is-${item.status}`}>{item.status}</span>
              </div>
              <p>{item.message}</p>
            </section>

            {item.screenshot && (
              <section className="ptl-admin-panel">
                <div className="ptl-admin-panel-head">
                  <div>
                    <h2>Screenshot</h2>
                    <p>Attached by the user.</p>
                  </div>
                  <Image size={17} />
                </div>
                <a
                  className="ptl-admin-screenshot"
                  href={`data:${item.screenshot.mime};base64,${item.screenshot.data}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`data:${item.screenshot.mime};base64,${item.screenshot.data}`}
                    alt="Feedback screenshot"
                  />
                </a>
              </section>
            )}

            <section className="ptl-admin-panel">
              <div className="ptl-admin-panel-head">
                <div>
                  <h2>Replies</h2>
                  <p>
                    {item.wantsReply
                      ? 'The user asked for a reply.'
                      : 'The user did not request a reply.'}
                  </p>
                </div>
              </div>
              {item.replies.length > 0 && (
                <div className="ptl-admin-replies">
                  {item.replies.map((message) => (
                    <article key={message.id}>
                      <div>
                        <strong>{message.senderName}</strong>
                        <span>{relativeTime(message.sentAt)}</span>
                      </div>
                      <p>{message.body}</p>
                    </article>
                  ))}
                </div>
              )}
              <form className="ptl-admin-reply-form" onSubmit={sendReply}>
                <label>
                  <span>Reply by email</span>
                  <textarea
                    className="ptl-dash-textarea"
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    rows={5}
                    maxLength={5_000}
                    placeholder={`Reply to ${item.user.email}`}
                  />
                </label>
                <Button type="submit" variant="primary" disabled={!reply.trim() || sending}>
                  <Send size={14} /> {sending ? 'Sending…' : 'Send reply'}
                </Button>
              </form>
            </section>
          </main>

          <aside className="ptl-admin-stack">
            <section className="ptl-admin-panel">
              <label className="ptl-admin-field">
                <span>Status</span>
                <select
                  className="ptl-admin-select"
                  value={item.status}
                  onChange={(event) => void setStatus(event.target.value as FeedbackStatus)}
                >
                  <option value="new">New</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="resolved">Resolved</option>
                </select>
              </label>
              <dl className="ptl-admin-definition">
                <div>
                  <dt>User</dt>
                  <dd>
                    {item.user.name || 'Not set'}
                    <small>{item.user.email}</small>
                  </dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd>
                    {item.workspace?.name ?? 'None'}
                    {item.workspace && <small>/{item.workspace.slug}</small>}
                  </dd>
                </div>
                <div>
                  <dt>Document</dt>
                  <dd>{item.documentId ?? 'None'}</dd>
                </div>
                <div>
                  <dt>Page</dt>
                  <dd>{item.route ?? 'Not included'}</dd>
                </div>
                <div>
                  <dt>Browser</dt>
                  <dd>{item.browser ?? 'Not included'}</dd>
                </div>
                <div>
                  <dt>Release</dt>
                  <dd>{item.release ?? 'Not included'}</dd>
                </div>
              </dl>
              {item.supportUrl && (
                <a
                  className="ptl-button ptl-button--outline ptl-button--md ptl-admin-full-button"
                  href={item.supportUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open support link <ExternalLink size={13} />
                </a>
              )}
            </section>

            <section className="ptl-admin-panel">
              <div className="ptl-admin-panel-head">
                <div>
                  <h2>Technical details</h2>
                  <p>Sanitized details the user chose to include.</p>
                </div>
              </div>
              {Object.keys(item.diagnostics).length ? (
                <pre className="ptl-admin-code">{JSON.stringify(item.diagnostics, null, 2)}</pre>
              ) : (
                <div className="ptl-admin-empty">No technical details included.</div>
              )}
            </section>
          </aside>
        </div>
      )}
      {error && item && (
        <div className="ptl-inline-error" role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </AdminShell>
  );
}

function FeedbackSkeleton() {
  return (
    <div className="ptl-skeleton-list" aria-label="Loading feedback">
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
    </div>
  );
}
function FeedbackError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="ptl-state-card is-error">
      <strong>Feedback could not load</strong>
      <span>{message}</span>
      <Button variant="outline" onClick={retry}>
        <RefreshCw size={14} /> Retry
      </Button>
    </div>
  );
}
