import { Button } from '@pitolet/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api, type Me, type Member, type WorkspaceSummary } from '../../api.js';
import { ConfirmButton, RoleSelect } from '../Settings.js';

/**
 * Members tab. Everyone can read the list; owners get add-by-email, remove, and
 * role changes (a role change is just a re-POST of {email, role} — the server
 * upserts the membership). Self-removal and last-owner cases are guarded by the
 * API (400/403); those messages surface inline.
 */
export function Members({ ws, me }: { ws: WorkspaceSummary; me: Me }) {
  const isOwner = ws.role === 'owner';
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const { members } = await api.members(ws.id);
      setMembers(members);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load members');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id]);

  async function changeRole(member: Member, role: string) {
    setError(null);
    try {
      await api.addMember(ws.id, { email: member.email, role });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update role');
    }
  }

  async function remove(member: Member) {
    setError(null);
    try {
      await api.removeMember(ws.id, member.userId);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove member');
    }
  }

  return (
    <>
      {isOwner && <AddMemberForm ws={ws} onAdded={reload} />}

      <div className="ptl-dash-section-head">
        <h2 className="ptl-dash-section-title">Members</h2>
      </div>

      {error && <div className="ptl-dash-error" style={{ marginBottom: 12 }}>{error}</div>}

      {members === null ? (
        <div className="ptl-dash-empty">Loading members…</div>
      ) : (
        <div className="ptl-dash-list">
          {members.map((m) => {
            const isSelf = m.userId === me.user.id;
            return (
              <div className="ptl-dash-row" key={m.userId}>
                <div className="ptl-dash-row-main">
                  <span className="ptl-dash-row-name">
                    {m.name || m.email}
                    {isSelf && <span style={{ color: 'var(--ptl-text-3)' }}> (you)</span>}
                  </span>
                  <span className="ptl-dash-row-meta">{m.email}</span>
                </div>
                <div className="ptl-dash-row-actions">
                  {isOwner ? (
                    <div style={{ width: 110 }}>
                      <RoleSelect value={m.role} onChange={(role) => changeRole(m, role)} />
                    </div>
                  ) : (
                    <span className="ptl-badge ptl-badge--role">{m.role}</span>
                  )}
                  {isOwner && !isSelf && (
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Confirm remove"
                      onConfirm={() => remove(m)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function AddMemberForm({ ws, onAdded }: { ws: WorkspaceSummary; onAdded: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError('Enter an email');
      return;
    }
    setBusy(true);
    try {
      await api.addMember(ws.id, { email: email.trim(), role });
      setEmail('');
      onAdded();
    } catch (err) {
      // 404 → 'no account with that email' (invitee must already have an account in I5).
      setError(err instanceof ApiError ? err.message : 'Could not add member');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ptl-dash-form" onSubmit={submit}>
      <div className="ptl-dash-form-row">
        <div className="ptl-dash-field" style={{ margin: 0, flex: '2 1 240px' }}>
          <label className="ptl-dash-label" htmlFor="member-email">
            Add member by email
          </label>
          <input
            id="member-email"
            type="email"
            className="ptl-dash-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
          />
        </div>
        <div className="ptl-dash-field" style={{ margin: 0, flex: '1 1 120px', maxWidth: 140 }}>
          <label className="ptl-dash-label">Role</label>
          <RoleSelect value={role} onChange={setRole} />
        </div>
      </div>
      <p className="ptl-dash-subtitle" style={{ marginTop: 8 }}>
        The person must already have a Pitolet account.
      </p>
      {error && <div className="ptl-dash-error">{error}</div>}
      <div className="ptl-dash-form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          Add member
        </Button>
      </div>
    </form>
  );
}
