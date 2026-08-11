import { Button } from '@pitolet/ui';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Me, type WorkspaceSummary } from './api.js';
import { authClient } from './authClient.js';
import { trackProductEvent } from './analytics.js';
import { installDashboardProblemReporter } from './clientProblems.js';
import { TopBar } from './components/TopBar.js';
import { navigate, useRoute, workspaceIdFromRoute, workspacePath } from './router.js';
import { Documents } from './pages/Documents.js';
import { People } from './pages/People.js';
import { Settings } from './pages/Settings.js';
import { SignIn } from './pages/SignIn.js';
import { WorkspaceHome } from './pages/WorkspaceHome.js';
import { Workspaces } from './pages/Workspaces.js';
import { AdminFeedback } from './pages/admin/AdminFeedback.js';
import { AdminOverview } from './pages/admin/AdminOverview.js';
import { AdminProblems } from './pages/admin/AdminProblems.js';
import { AdminUsers } from './pages/admin/AdminUsers.js';

type State =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'signed-in'; me: Me };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const route = useRoute();

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const me = await api.me();
      setState({ kind: 'signed-in', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState({ kind: 'signed-out' });
      } else {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Could not reach Pitolet.',
        });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind !== 'signed-in') return;
    trackProductEvent(
      { name: 'dashboard_opened', source: 'dashboard' },
      `dashboard-opened.${state.me.user.id}`,
    );
  }, [state]);

  useEffect(() => {
    if (state.kind !== 'signed-in') return;
    return installDashboardProblemReporter(() => ({
      workspaceId: workspaceIdFromRoute(route),
      documentId: route.name === 'workspace-document' ? route.docId : null,
    }));
  }, [route, state.kind]);

  async function signOut() {
    await authClient.signOut();
    setState({ kind: 'signed-out' });
    navigate('/');
  }

  if (state.kind === 'loading') {
    return (
      <div className="ptl-dash-center" role="status">
        <span className="ptl-spinner" />
        Loading Pitolet
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="ptl-dash-center">
        <div className="ptl-connection-error">
          <WifiOff size={22} />
          <strong>Pitolet could not connect</strong>
          <p>{state.message}</p>
          <Button variant="primary" onClick={load}>
            <RefreshCw size={14} /> Try again
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'signed-out') {
    return <SignIn onAuthed={load} />;
  }

  const { me } = state;
  const workspaceId = workspaceIdFromRoute(route);
  const workspace = workspaceId
    ? me.workspaces.find((candidate) => candidate.id === workspaceId)
    : undefined;
  const adminRoute = route.name.startsWith('admin-');

  function created(next: WorkspaceSummary) {
    setState({
      kind: 'signed-in',
      me: { ...me, workspaces: [...me.workspaces, next] },
    });
    navigate(workspacePath(next.id));
  }

  return (
    <div className="ptl-dash">
      <TopBar
        user={me.user}
        isPlatformAdmin={me.isPlatformAdmin}
        workspaceId={workspaceId}
        documentId={route.name === 'workspace-document' ? route.docId : null}
        onSignOut={signOut}
      />
      <main className={`ptl-dash-main${adminRoute ? ' is-admin' : ''}`}>
        {route.name === 'home' ? (
          <Workspaces workspaces={me.workspaces} onCreated={created} />
        ) : adminRoute && !me.isPlatformAdmin ? (
          <MissingOwnerConsole />
        ) : route.name === 'admin-overview' ? (
          <AdminOverview />
        ) : route.name === 'admin-users' ? (
          <AdminUsers />
        ) : route.name === 'admin-user' ? (
          <AdminUsers userId={route.userId} />
        ) : route.name === 'admin-feedback' ? (
          <AdminFeedback />
        ) : route.name === 'admin-feedback-detail' ? (
          <AdminFeedback feedbackId={route.feedbackId} />
        ) : route.name === 'admin-problems' ? (
          <AdminProblems />
        ) : !workspace ? (
          <MissingWorkspace />
        ) : route.name === 'workspace' ? (
          <WorkspaceHome workspace={workspace} />
        ) : route.name === 'workspace-documents' ? (
          <Documents workspace={workspace} />
        ) : route.name === 'workspace-document' ? (
          <Documents workspace={workspace} documentId={route.docId} />
        ) : route.name === 'workspace-people' ? (
          <People workspace={workspace} me={me} />
        ) : (
          <Settings workspace={workspace} />
        )}
      </main>
    </div>
  );
}

function MissingOwnerConsole() {
  return (
    <div className="ptl-state-card">
      <strong>Page not found</strong>
      <span>This page is not available for your account.</span>
      <Button variant="outline" onClick={() => navigate('/')}>
        Back to workspaces
      </Button>
    </div>
  );
}

function MissingWorkspace() {
  return (
    <div className="ptl-state-card">
      <strong>Workspace not found</strong>
      <span>It may have been removed, or your access may have changed.</span>
      <Button variant="outline" onClick={() => navigate('/')}>
        Back to workspaces
      </Button>
    </div>
  );
}
