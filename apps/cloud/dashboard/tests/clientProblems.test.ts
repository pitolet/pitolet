import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportDashboardProblem } from '../src/clientProblems.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard problem privacy', () => {
  it('sends the error type and stack location without its message', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = new TypeError(
      'private prompt Bearer secret-token with text copied from the design',
    );
    error.stack = `${error.name}: ${error.message}\n    at WorkspaceHome (dashboard.js:42:7)`;

    reportDashboardProblem(error, { component: 'WorkspaceHome' });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      title: string;
      stack: string;
    };
    expect(body.title).toBe('TypeError');
    expect(body.stack).toBe('    at WorkspaceHome (dashboard.js:42:7)');
    expect(JSON.stringify(body)).not.toContain('private prompt');
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });
});
