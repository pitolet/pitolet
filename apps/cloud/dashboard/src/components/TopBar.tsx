import { BrandMark, Button } from '@pitolet/ui';
import { ChevronDown, LogOut } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { navigate } from '../router.js';

export function TopBar({
  user,
  onSignOut,
}: {
  user: { email: string; name: string };
  onSignOut: () => void;
}) {
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
  const menuRef = useRef<HTMLDetailsElement>(null);

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
          <Button variant="ghost" onClick={onSignOut}>
            <LogOut size={14} />
            Sign out
          </Button>
        </div>
      </details>
    </header>
  );
}
