import { Button, Select, Tabs } from '@pitolet/ui';
import { ChevronLeft, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Me } from '../api.js';
import { navigate } from '../router.js';
import { Members } from './settings/Members.js';
import { Tokens } from './settings/Tokens.js';

/**
 * /settings/:workspaceId — Members | Agent tokens. Resolves the workspace from
 * the already-loaded /api/me payload so a deep link that isn't a member's
 * workspace shows a not-found state (the API would 404 anyway).
 */
export function Settings({ me, workspaceId }: { me: Me; workspaceId: string }) {
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  const [tab, setTab] = useState('members');

  if (!ws) {
    return (
      <>
        <BackLink />
        <div className="ptl-dash-empty">Workspace not found, or you don't have access to it.</div>
      </>
    );
  }

  return (
    <>
      <BackLink />
      <div className="ptl-dash-page-head">
        <div>
          <h1 className="ptl-dash-title">{ws.name}</h1>
          <p className="ptl-dash-subtitle">
            /{ws.slug} · <span style={{ textTransform: 'capitalize' }}>{ws.role}</span>
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/docs/${ws.id}`)}>
          <FileText size={13} /> Documents
        </Button>
      </div>

      <div className="ptl-dash-tabbar">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'members', label: 'Members' },
            { value: 'tokens', label: 'Agent tokens' },
          ]}
        />
      </div>

      {tab === 'members' ? <Members ws={ws} me={me} /> : <Tokens ws={ws} />}
    </>
  );
}

function BackLink() {
  return (
    <button type="button" className="ptl-dash-back" onClick={() => navigate('/')}>
      <ChevronLeft size={14} /> All workspaces
    </button>
  );
}

/** Shared confirm-then-act button used by member/token removal. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  // Auto-disarm after a few seconds so a stray armed button can't be clicked later.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <Button
      variant="danger"
      size="sm"
      disabled={disabled}
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/** Small labelled select used in member/token forms (full-height form styling). */
export function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      options={[
        { value: 'owner', label: 'Owner' },
        { value: 'editor', label: 'Editor' },
        { value: 'viewer', label: 'Viewer' },
      ]}
    />
  );
}
