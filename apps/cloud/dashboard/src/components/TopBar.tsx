import { BrandMark, Button, CloudFeedbackDialog } from '@pitolet/ui';
import {
  BarChart3,
  ChevronDown,
  LogOut,
  MessageSquareText,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { navigate } from '../router.js';
import { recentDashboardErrors } from '../clientProblems.js';

export function TopBar({
  user,
  isPlatformAdmin,
  workspaceId,
  documentId,
  onSignOut,
}: {
  user: { email: string; name: string };
  isPlatformAdmin: boolean;
  workspaceId?: string | null;
  documentId?: string | null;
  onSignOut: () => void;
}) {
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      const menu = menuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    }

    function closeWithEscape(event: KeyboardEvent) {
      const menu = menuRef.current;
      if (event.key !== 'Escape' || !menu?.open) return;
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }

    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, []);

  return (
    <header className="ptl-dash-topbar">
      <button
        type="button"
        className="ptl-dash-logo"
        onClick={() => navigate('/')}
        aria-label="Pitolet workspaces"
      >
        <BrandMark size={19} />
        <span className="ptl-dash-logo-name">Pitolet</span>
      </button>

      <details className="ptl-account-menu" ref={menuRef}>
        <summary aria-label="Account menu">
          <span className="ptl-account-avatar" aria-hidden="true">
            {initial}
          </span>
          <ChevronDown size={13} />
        </summary>
        <div className="ptl-account-popover">
          <div className="ptl-account-copy">
            <strong>{user.name || 'Pitolet account'}</strong>
            <span>{user.email}</span>
          </div>
          {isPlatformAdmin && (
            <div className="ptl-account-admin-links">
              <span>Owner console</span>
              <AccountLink
                icon={BarChart3}
                label="Overview"
                path="/admin"
                close={() => {
                  if (menuRef.current) menuRef.current.open = false;
                }}
              />
              <AccountLink
                icon={Users}
                label="Users"
                path="/admin/users"
                close={() => {
                  if (menuRef.current) menuRef.current.open = false;
                }}
              />
              <AccountLink
                icon={MessageSquareText}
                label="Feedback"
                path="/admin/feedback"
                close={() => {
                  if (menuRef.current) menuRef.current.open = false;
                }}
              />
              <AccountLink
                icon={TriangleAlert}
                label="Problems"
                path="/admin/problems"
                close={() => {
                  if (menuRef.current) menuRef.current.open = false;
                }}
              />
            </div>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              if (menuRef.current) menuRef.current.open = false;
              setFeedbackOpen(true);
            }}
          >
            <MessageSquareText size={14} /> Send feedback
          </Button>
          <Button variant="ghost" onClick={onSignOut}>
            <LogOut size={14} />
            Sign out
          </Button>
        </div>
      </details>
      <CloudFeedbackDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        source="dashboard"
        workspaceId={workspaceId}
        documentId={documentId}
        release={import.meta.env.VITE_PITOLET_RELEASE ?? 'development'}
        recentErrors={recentDashboardErrors()}
      />
    </header>
  );
}

function AccountLink({
  icon: Icon,
  label,
  path,
  close,
}: {
  icon: typeof BarChart3;
  label: string;
  path: string;
  close: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={() => {
        close();
        navigate(path);
      }}
    >
      <Icon size={14} /> {label}
    </Button>
  );
}
