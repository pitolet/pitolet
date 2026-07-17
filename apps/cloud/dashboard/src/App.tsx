import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Me } from './api.js';
import { authClient } from './authClient.js';
import { TopBar } from './components/TopBar.js';
import { navigate, useRoute } from './router.js';
import { Documents } from './pages/Documents.js';
import { Settings } from './pages/Settings.js';
import { SignIn } from './pages/SignIn.js';
import { Workspaces } from './pages/Workspaces.js';

type State = { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'signed-in'; me: Me };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const route = useRoute();

  const load = useCallback(async () => {
    try {
      const me = await api.me();
      setState({ kind: 'signed-in', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState({ kind: 'signed-out' });
      } else {
        // Network/other errors: treat as signed-out so the user sees sign-in
        // rather than a dead loading screen.
        setState({ kind: 'signed-out' });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    await authClient.signOut();
    setState({ kind: 'signed-out' });
    navigate('/');
  }

  if (state.kind === 'loading') {
    return <div className="ptl-dash-center">Loading…</div>;
  }

  if (state.kind === 'signed-out') {
    return <SignIn onAuthed={load} />;
  }

  const { me } = state;

  return (
    <div className="ptl-dash">
      <TopBar email={me.user.email} onSignOut={signOut} />
      <main className="ptl-dash-main">
        {route.name === 'settings' ? (
          <Settings me={me} workspaceId={route.workspaceId} />
        ) : route.name === 'docs' ? (
          <Documents me={me} workspaceId={route.workspaceId} />
        ) : (
          <Workspaces
            workspaces={me.workspaces}
            onCreated={(ws) =>
              // Reflect the new workspace immediately without a round-trip.
              setState({
                kind: 'signed-in',
                me: { ...me, workspaces: [...me.workspaces, ws] },
              })
            }
          />
        )}
      </main>
    </div>
  );
}
