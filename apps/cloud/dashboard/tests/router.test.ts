import { describe, expect, it } from 'vitest';
import { adminPath, parse, workspacePath } from '../src/router.js';

describe('dashboard routes', () => {
  it('parses workspace pages and document detail links', () => {
    expect(parse('/workspace/ws-1')).toEqual({ name: 'workspace', workspaceId: 'ws-1' });
    expect(parse('/workspace/ws-1/documents')).toEqual({
      name: 'workspace-documents',
      workspaceId: 'ws-1',
    });
    expect(parse('/workspace/ws-1/documents/doc%201')).toEqual({
      name: 'workspace-document',
      workspaceId: 'ws-1',
      docId: 'doc 1',
    });
    expect(parse('/workspace/ws-1/people')).toEqual({
      name: 'workspace-people',
      workspaceId: 'ws-1',
    });
    expect(parse('/workspace/ws-1/settings')).toEqual({
      name: 'workspace-settings',
      workspaceId: 'ws-1',
    });
  });

  it('keeps old document and settings links working', () => {
    expect(parse('/docs/ws-1')).toEqual({
      name: 'workspace-documents',
      workspaceId: 'ws-1',
    });
    expect(parse('/settings/ws-1')).toEqual({
      name: 'workspace-settings',
      workspaceId: 'ws-1',
    });
  });

  it('builds workspace paths safely', () => {
    expect(workspacePath('workspace / one')).toBe('/workspace/workspace%20%2F%20one');
    expect(workspacePath('ws-1', 'people')).toBe('/workspace/ws-1/people');
  });

  it('parses owner-console routes and builds their paths', () => {
    expect(parse('/admin')).toEqual({ name: 'admin-overview' });
    expect(parse('/admin/users')).toEqual({ name: 'admin-users' });
    expect(parse('/admin/users/user%201')).toEqual({ name: 'admin-user', userId: 'user 1' });
    expect(parse('/admin/feedback')).toEqual({ name: 'admin-feedback' });
    expect(parse('/admin/feedback/00000000-0000-0000-0000-000000000001')).toEqual({
      name: 'admin-feedback-detail',
      feedbackId: '00000000-0000-0000-0000-000000000001',
    });
    expect(parse('/admin/problems')).toEqual({ name: 'admin-problems' });
    expect(adminPath('overview')).toBe('/admin');
    expect(adminPath('feedback')).toBe('/admin/feedback');
  });
});
