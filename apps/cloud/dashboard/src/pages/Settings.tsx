import { Button, Select } from '@pitolet/ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, type BillingSummary, type WorkspaceSummary } from '../api.js';
import { AgentSetup } from '../components/AgentSetup.js';
import { WorkspaceShell } from '../components/WorkspaceShell.js';

export function Settings({ workspace }: { workspace: WorkspaceSummary }) {
  return (
    <WorkspaceShell
      workspace={workspace}
      active="settings"
      title="Settings"
      description={workspace.name}
    >
      <div className="ptl-settings-stack">
        <section className="ptl-settings-section">
          <AgentSetup
            workspace={workspace}
            title="Agent connections"
            description="Set up a coding agent or manage the tokens it uses."
          />
        </section>

        <PlanCard workspace={workspace} />
      </div>
    </WorkspaceShell>
  );
}

function PlanCard({ workspace }: { workspace: WorkspaceSummary }) {
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = workspace.role === 'owner';
  const plan = billing?.plan ?? workspace.plan;
  const planLabel = plan === 'unlimited' ? 'Unlimited' : plan === 'pro' ? 'Pro' : 'Free';

  async function reload() {
    if (!isOwner) return;
    setError(null);
    try {
      setBilling(await api.billing(workspace.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load plan details.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, isOwner]);

  return (
    <section className="ptl-settings-section">
      <div className="ptl-dash-section-head">
        <div>
          <h2 className="ptl-dash-section-title">Plan</h2>
          <p className="ptl-dash-subtitle">The current plan for this workspace.</p>
        </div>
      </div>
      <div className="ptl-plan-card">
        <div>
          <strong className="ptl-plan-name">{planLabel}</strong>
          <span className="ptl-plan-role">
            {plan === 'unlimited'
              ? 'No workspace limits'
              : workspace.role === 'owner'
                ? billing?.status
                  ? `Subscription ${billing.status}`
                  : 'Workspace owner'
                : `Only an owner can manage this plan`}
          </span>
        </div>
        {billing?.currentPeriodEnd && (
          <span className="ptl-plan-renewal">
            Current period ends {new Date(billing.currentPeriodEnd).toLocaleDateString()}
          </span>
        )}
        {error && (
          <div className="ptl-inline-error" role="alert">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={reload}>
              <RefreshCw size={13} /> Retry
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

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

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      variant="danger"
      size="sm"
      disabled={disabled}
      onClick={() => {
        if (armed) onConfirm();
        setArmed((current) => !current);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

export function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      ariaLabel="Role"
      options={[
        { value: 'owner', label: 'Owner' },
        { value: 'editor', label: 'Editor' },
        { value: 'viewer', label: 'Viewer' },
      ]}
    />
  );
}
