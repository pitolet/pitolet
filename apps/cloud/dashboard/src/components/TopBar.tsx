import { BrandMark, Button } from '@pitolet/ui';
import { navigate } from '../router.js';

/** Dashboard top bar: brand → home, user email, sign out. */
export function TopBar({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <header className="ptl-dash-topbar">
      <button
        type="button"
        className="ptl-dash-logo"
        style={{ background: 'none', border: 'none', padding: 0 }}
        onClick={() => navigate('/')}
        aria-label="Pitolet home"
      >
        <BrandMark size={19} />
        <span className="ptl-dash-logo-name">Pitolet</span>
      </button>
      <div className="ptl-dash-topbar-spacer" />
      <div className="ptl-dash-user">
        <span>{email}</span>
        <Button variant="ghost" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
