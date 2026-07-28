import type { WorkspaceSummary } from '../../api.js';
import { AgentSetup } from '../../components/AgentSetup.js';

/**
 * Backward-compatible export for older imports. Agent connections now use the
 * same setup surface on the workspace home and in Settings.
 */
export function Tokens({ ws }: { ws: WorkspaceSummary }) {
  return <AgentSetup workspace={ws} />;
}
