import type { Me, WorkspaceSummary } from '../api.js';
import { WorkspaceShell } from '../components/WorkspaceShell.js';
import { Members } from './settings/Members.js';

export function People({ workspace, me }: { workspace: WorkspaceSummary; me: Me }) {
  return (
    <WorkspaceShell
      workspace={workspace}
      active="people"
      title="People"
      description={`Access to ${workspace.name}`}
    >
      <Members ws={workspace} me={me} />
    </WorkspaceShell>
  );
}
