import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type OwnerOverview, type OwnerProblem, type OwnerUser } from '../src/api.js';
import { AdminOverview } from '../src/pages/admin/AdminOverview.js';
import { AdminProblems } from '../src/pages/admin/AdminProblems.js';
import { AdminUsers } from '../src/pages/admin/AdminUsers.js';

const overview: OwnerOverview = {
  rangeDays: 30,
  summary: {
    totalAccounts: 4,
    newAccounts: 1,
    activeUsers: 2,
    activeWorkspaces: 2,
    connectedWorkspaces: 1,
    activatedWorkspaces: 1,
    imports: 1,
    returningUsers: 1,
    newFeedback: 0,
    openProblems: 0,
  },
  funnel: [],
  trends: [],
  health: {
    loadedWorkspaces: 1,
    wsClients: 1,
    rssBytes: 1_000,
    heapUsedBytes: 500,
    uptimeSeconds: 60,
    pgPoolTotal: 1,
    pgPoolIdle: 1,
    pgPoolWaiting: 0,
    databaseResponseMs: 2,
    release: 'test',
  },
};

const user: OwnerUser = {
  id: 'user-1',
  name: 'Sam',
  email: 'sam@example.com',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActiveAt: '2026-08-06T00:00:00.000Z',
  workspaceCount: 1,
  documentCount: 2,
  connectedAgentCount: 1,
  feedbackCount: 0,
  openProblemCount: 0,
  plans: ['free'],
};

const problem: OwnerProblem = {
  fingerprint: 'a'.repeat(64),
  source: 'editor',
  severity: 'error',
  title: 'TypeError',
  stack: null,
  count: 2,
  status: 'open',
  firstSeenAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-06T00:00:00.000Z',
  release: 'test',
  route: '/w/product/',
  user: null,
  workspace: null,
  documentId: null,
  context: {},
};

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe('owner console interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows an overview error and retries it inline', async () => {
    const request = vi
      .spyOn(api, 'adminOverview')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(overview);

    await act(async () => root.render(<AdminOverview />));
    await act(async () => {});
    expect(container.textContent).toContain('Could not load the owner overview.');

    await act(async () => button(container, 'Retry').click());
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Total accounts');
  });

  it('submits user search terms to the filtered endpoint', async () => {
    const request = vi.spyOn(api, 'adminUsers').mockResolvedValue({ users: [user] });
    await act(async () => root.render(<AdminUsers />));
    await act(async () => {});

    await act(async () => {
      setInput(container.querySelector<HTMLInputElement>('input')!, 'sam@example.com');
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    expect(request).toHaveBeenLastCalledWith('sam@example.com');
    expect(container.textContent).toContain('Sam');
  });

  it('reloads problems when status and source filters change', async () => {
    const request = vi.spyOn(api, 'adminProblems').mockResolvedValue({ problems: [problem] });
    await act(async () => root.render(<AdminProblems />));
    await act(async () => {});

    const selects = container.querySelectorAll<HTMLSelectElement>('select');
    await act(async () => setSelect(selects[0]!, 'resolved'));
    await act(async () => {});
    await act(async () => setSelect(selects[1]!, 'editor'));
    await act(async () => {});

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', source: 'editor' }),
    );
  });
});
