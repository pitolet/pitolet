import { ArrowLeft, BarChart3, MessageSquareText, TriangleAlert, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { adminPath, navigate } from '../router.js';

export type AdminPage = 'overview' | 'users' | 'feedback' | 'problems';

const PAGES: Array<{ value: AdminPage; label: string; icon: typeof BarChart3 }> = [
  { value: 'overview', label: 'Overview', icon: BarChart3 },
  { value: 'users', label: 'Users', icon: Users },
  { value: 'feedback', label: 'Feedback', icon: MessageSquareText },
  { value: 'problems', label: 'Problems', icon: TriangleAlert },
];

export function AdminShell({
  active,
  title,
  description,
  actions,
  children,
}: {
  active: AdminPage;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ptl-admin-layout">
      <aside className="ptl-admin-sidebar">
        <button type="button" className="ptl-admin-back" onClick={() => navigate('/')}>
          <ArrowLeft size={14} /> Workspaces
        </button>
        <div className="ptl-admin-brand">
          <strong>Owner console</strong>
          <span>Private to platform admins</span>
        </div>
        <nav aria-label="Owner console">
          {PAGES.map(({ value, label, icon: Icon }) => (
            <button
              type="button"
              key={value}
              className={`ptl-admin-nav-item${active === value ? ' is-active' : ''}`}
              aria-current={active === value ? 'page' : undefined}
              onClick={() => navigate(adminPath(value))}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="ptl-admin-main">
        <header className="ptl-admin-page-head">
          <div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {actions}
        </header>
        {children}
      </section>
    </div>
  );
}
