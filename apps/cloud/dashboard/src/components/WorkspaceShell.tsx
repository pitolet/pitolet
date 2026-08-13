import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkspaceSummary } from '../api.js';
import { navigate, workspacePath } from '../router.js';

export type WorkspacePage = 'home' | 'documents' | 'people' | 'settings';

const PAGES: Array<{ value: WorkspacePage; label: string }> = [
  { value: 'home', label: 'Home' },
  { value: 'documents', label: 'Documents' },
  { value: 'people', label: 'People' },
  { value: 'settings', label: 'Settings' },
];

export function WorkspaceShell({
  workspace,
  active,
  children,
  title,
  description,
  actions,
  editorHref,
  editorLabel = 'Open editor',
  showEditorAction = true,
}: {
  workspace: WorkspaceSummary;
  active: WorkspacePage;
  children: ReactNode;
  title?: string;
  description?: string;
  actions?: ReactNode;
  editorHref?: string;
  editorLabel?: string;
  showEditorAction?: boolean;
}) {
  return (
    <>
      <button type="button" className="ptl-dash-back" onClick={() => navigate('/')}>
        <ArrowLeft size={14} />
        Workspaces
      </button>

      <div className="ptl-workspace-head">
        <div className="ptl-workspace-head-copy">
          <h1 className="ptl-dash-title">{title ?? workspace.name}</h1>
          {description && <p className="ptl-dash-subtitle">{description}</p>}
        </div>
        {(actions || showEditorAction) && (
          <div className="ptl-workspace-head-actions">
            {actions}
            {showEditorAction && (
              <a
                className="ptl-button ptl-button--primary ptl-button--md"
                href={editorHref ?? `/w/${workspace.slug}/`}
              >
                {editorLabel}
                <ExternalLink size={13} />
              </a>
            )}
          </div>
        )}
      </div>

      <nav className="ptl-workspace-nav" aria-label={`${workspace.name} workspace`}>
        {PAGES.map((page) => (
          <button
            type="button"
            key={page.value}
            className={`ptl-workspace-nav-item${active === page.value ? ' is-active' : ''}`}
            aria-current={active === page.value ? 'page' : undefined}
            onClick={() => navigate(workspacePath(workspace.id, page.value))}
          >
            {page.label}
          </button>
        ))}
      </nav>

      <div className="ptl-workspace-content">{children}</div>
    </>
  );
}
