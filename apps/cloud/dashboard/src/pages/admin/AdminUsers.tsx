import { Button } from '@pitolet/ui';
import { ArrowLeft, ArrowRight, RefreshCw, Search, UserRound } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, type OwnerUser } from '../../api.js';
import { AdminShell } from '../../components/AdminShell.js';
import { navigate } from '../../router.js';
import { formatDate, relativeTime } from '../../time.js';

export function AdminUsers({ userId }: { userId?: string }) {
  return userId ? <AdminUserDetail userId={userId} /> : <AdminUserList />;
}

function AdminUserList() {
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [users, setUsers] = useState<OwnerUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers((await api.adminUsers(appliedQuery)).users);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not load users.');
    }
  }, [appliedQuery]);

  useEffect(() => {
    setUsers(null);
    void load();
  }, [load]);

  function search(event: FormEvent) {
    event.preventDefault();
    setAppliedQuery(query.trim());
  }

  return (
    <AdminShell
      active="users"
      title="Users"
      description="Accounts and their recent product activity."
    >
      <form className="ptl-admin-toolbar" onSubmit={search}>
        <label className="ptl-admin-search">
          <Search size={15} />
          <span className="ptl-visually-hidden">Search users</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or email"
          />
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {error ? (
        <AdminListError label="Users" message={error} retry={load} />
      ) : users === null ? (
        <AdminRowsSkeleton />
      ) : users.length === 0 ? (
        <div className="ptl-state-card">
          <UserRound size={20} />
          <strong>No users found</strong>
          <span>Try a different name or email.</span>
        </div>
      ) : (
        <div className="ptl-admin-table-wrap">
          <table className="ptl-admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Last active</th>
                <th>Plan</th>
                <th>Workspaces</th>
                <th>Documents</th>
                <th>MCP</th>
                <th>Feedback</th>
                <th>Problems</th>
                <th>
                  <span className="ptl-visually-hidden">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td data-label="User">
                    <strong>{user.name || 'Unnamed account'}</strong>
                    <span>{user.email}</span>
                  </td>
                  <td data-label="Last active">{relativeTime(user.lastActiveAt)}</td>
                  <td data-label="Plan">{user.plans.length ? user.plans.join(', ') : 'None'}</td>
                  <td data-label="Workspaces">{user.workspaceCount}</td>
                  <td data-label="Documents">{user.documentCount}</td>
                  <td data-label="MCP">
                    {user.connectedAgentCount ? (
                      <span className="ptl-admin-good">Connected</span>
                    ) : (
                      'Not used'
                    )}
                  </td>
                  <td data-label="Feedback">{user.feedbackCount}</td>
                  <td data-label="Problems">
                    {user.openProblemCount ? (
                      <span className="ptl-admin-bad">{user.openProblemCount} open</span>
                    ) : (
                      'None'
                    )}
                  </td>
                  <td data-label="Open">
                    <button
                      type="button"
                      className="ptl-admin-row-link"
                      onClick={() => navigate(`/admin/users/${encodeURIComponent(user.id)}`)}
                      aria-label={`Open ${user.name || user.email}`}
                    >
                      <ArrowRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

function AdminUserDetail({ userId }: { userId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminUser>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.adminUser(userId));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not load the user.');
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminShell
      active="users"
      title={data?.user.name || 'User details'}
      description={data?.user.email || 'Account activity and workspace access.'}
    >
      <button type="button" className="ptl-dash-back" onClick={() => navigate('/admin/users')}>
        <ArrowLeft size={14} /> Users
      </button>
      {error ? (
        <AdminListError label="User" message={error} retry={load} />
      ) : !data ? (
        <AdminRowsSkeleton />
      ) : (
        <div className="ptl-admin-stack">
          <section className="ptl-admin-panel">
            <div className="ptl-admin-panel-head">
              <div>
                <h2>Account</h2>
                <p>Created {formatDate(data.user.createdAt)}</p>
              </div>
              <UserRound size={17} />
            </div>
            <dl className="ptl-admin-definition">
              <div>
                <dt>Name</dt>
                <dd>{data.user.name || 'Not set'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{data.user.email}</dd>
              </div>
              <div>
                <dt>User ID</dt>
                <dd>
                  <code>{data.user.id}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="ptl-admin-panel">
            <div className="ptl-admin-panel-head">
              <div>
                <h2>Workspaces</h2>
                <p>Memberships and agent use.</p>
              </div>
            </div>
            {data.workspaces.length ? (
              <div className="ptl-admin-card-list">
                {data.workspaces.map((workspace) => (
                  <article key={workspace.id} className="ptl-admin-compact-card">
                    <div>
                      <strong>{workspace.name}</strong>
                      <span>/{workspace.slug}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>Role</dt>
                        <dd>{workspace.role}</dd>
                      </div>
                      <div>
                        <dt>Plan</dt>
                        <dd>{workspace.plan}</dd>
                      </div>
                      <div>
                        <dt>Documents</dt>
                        <dd>{workspace.documentCount}</dd>
                      </div>
                      <div>
                        <dt>Last MCP use</dt>
                        <dd>
                          {workspace.lastAgentUse ? relativeTime(workspace.lastAgentUse) : 'Never'}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <div className="ptl-admin-empty">No workspace memberships.</div>
            )}
          </section>

          <section className="ptl-admin-panel">
            <div className="ptl-admin-panel-head">
              <div>
                <h2>Milestones</h2>
                <p>Only allowlisted product events are shown.</p>
              </div>
            </div>
            {data.timeline.length ? (
              <div className="ptl-admin-timeline">
                {data.timeline.map((event, index) => (
                  <div key={`${event.occurredAt}-${index}`}>
                    <i />
                    <div>
                      <strong>{eventLabel(event.name)}</strong>
                      <span>
                        {relativeTime(event.occurredAt)} · {event.source}
                        {event.properties.client ? ` · ${String(event.properties.client)}` : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ptl-admin-empty">No recorded milestones.</div>
            )}
          </section>
        </div>
      )}
    </AdminShell>
  );
}

function eventLabel(name: string): string {
  return (
    (
      {
        dashboard_opened: 'Opened dashboard',
        workspace_opened: 'Opened workspace',
        editor_opened: 'Opened editor',
        prompt_copied: 'Copied an agent prompt',
        manual_setup_opened: 'Opened manual MCP setup',
        document_imported: 'Imported a website',
      } as Record<string, string>
    )[name] ?? name
  );
}

function AdminRowsSkeleton() {
  return (
    <div className="ptl-skeleton-list" aria-label="Loading">
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
      <div className="ptl-skeleton-row" />
    </div>
  );
}

function AdminListError({
  label,
  message,
  retry,
}: {
  label: string;
  message: string;
  retry: () => void;
}) {
  return (
    <div className="ptl-state-card is-error">
      <strong>{label} could not load</strong>
      <span>{message}</span>
      <Button variant="outline" onClick={retry}>
        <RefreshCw size={14} /> Retry
      </Button>
    </div>
  );
}
