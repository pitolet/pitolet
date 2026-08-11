import { Button } from '@pitolet/ui';
import {
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type OwnerProblem } from '../../api.js';
import { AdminShell } from '../../components/AdminShell.js';
import { formatDate, relativeTime } from '../../time.js';

export function AdminProblems() {
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [problems, setProblems] = useState<OwnerProblem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProblems((await api.adminProblems({ status, source, query: appliedQuery })).problems);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not load problems.');
    }
  }, [appliedQuery, source, status]);

  useEffect(() => {
    setProblems(null);
    void load();
  }, [load]);

  async function update(problem: OwnerProblem, next: OwnerProblem['status']) {
    setProblems(
      (current) =>
        current?.map((item) =>
          item.fingerprint === problem.fingerprint ? { ...item, status: next } : item,
        ) ?? null,
    );
    try {
      await api.updateProblem(problem.fingerprint, next);
      if (status && status !== next)
        setProblems(
          (current) => current?.filter((item) => item.fingerprint !== problem.fingerprint) ?? null,
        );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not update the problem.');
      await load();
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setAppliedQuery(query.trim());
  }
  const openCount = problems?.filter((problem) => problem.status === 'open').length ?? 0;

  return (
    <AdminShell
      active="problems"
      title="Problems"
      description="Errors grouped by where they happened."
      actions={
        openCount ? <span className="ptl-admin-count is-danger">{openCount} open</span> : undefined
      }
    >
      <form className="ptl-admin-toolbar" onSubmit={search}>
        <label className="ptl-admin-search">
          <Search size={15} />
          <span className="ptl-visually-hidden">Search problems</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search message, user, or workspace"
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
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>
        <label>
          <span className="ptl-visually-hidden">Source</span>
          <select
            className="ptl-admin-select"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">All sources</option>
            <option value="dashboard">Dashboard</option>
            <option value="editor">Editor</option>
            <option value="server">Server</option>
            <option value="runtime">Runtime</option>
            <option value="storage">Storage</option>
          </select>
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {error && (
        <div className="ptl-inline-error" role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw size={13} /> Retry
          </Button>
        </div>
      )}
      {problems === null ? (
        <ProblemSkeleton />
      ) : problems.length === 0 ? (
        <div className="ptl-state-card">
          <CheckCircle2 size={20} />
          <strong>No matching problems</strong>
          <span>Grouped failures will appear here when they occur.</span>
        </div>
      ) : (
        <div className="ptl-admin-problem-list">
          {problems.map((problem) => (
            <details className={`ptl-admin-problem is-${problem.status}`} key={problem.fingerprint}>
              <summary>
                <span className={`ptl-admin-severity is-${problem.severity}`}>
                  <TriangleAlert size={15} />
                </span>
                <span className="ptl-admin-problem-title">
                  <strong>{problem.title}</strong>
                  <small>
                    {problem.source} · last seen {relativeTime(problem.lastSeenAt)}
                  </small>
                </span>
                <span className="ptl-admin-problem-count">{problem.count.toLocaleString()}×</span>
                <span className={`ptl-admin-status is-${problem.status}`}>{problem.status}</span>
                <ChevronDown size={15} />
              </summary>
              <div className="ptl-admin-problem-body">
                <dl className="ptl-admin-definition is-grid">
                  <div>
                    <dt>First seen</dt>
                    <dd>{formatDate(problem.firstSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd>{formatDate(problem.lastSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Release</dt>
                    <dd>{problem.release ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>{problem.route ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>User</dt>
                    <dd>{problem.user?.email ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>{problem.workspace?.name ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Document</dt>
                    <dd>{problem.documentId ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Fingerprint</dt>
                    <dd>
                      <code>{problem.fingerprint.slice(0, 16)}…</code>
                    </dd>
                  </div>
                </dl>
                {problem.stack && <pre className="ptl-admin-code">{problem.stack}</pre>}
                {Object.keys(problem.context).length > 0 && (
                  <pre className="ptl-admin-code">{JSON.stringify(problem.context, null, 2)}</pre>
                )}
                <div className="ptl-admin-problem-actions">
                  {problem.status !== 'resolved' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void update(problem, 'resolved')}
                    >
                      <CheckCircle2 size={13} /> Resolve
                    </Button>
                  )}
                  {problem.status !== 'ignored' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void update(problem, 'ignored')}
                    >
                      <CircleSlash2 size={13} /> Ignore
                    </Button>
                  )}
                  {problem.status !== 'open' && (
                    <Button variant="ghost" size="sm" onClick={() => void update(problem, 'open')}>
                      Reopen
                    </Button>
                  )}
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

function ProblemSkeleton() {
  return (
    <div className="ptl-skeleton-list" aria-label="Loading problems">
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
    </div>
  );
}
