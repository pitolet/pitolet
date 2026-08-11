import { afterEach, describe, expect, it } from 'vitest';
import {
  feedbackNotificationEmails,
  isPlatformAdmin,
  platformAdminEmails,
} from '../src/admin/access.js';
import { FeedbackInputError, parseFeedbackSubmission } from '../src/admin/feedback.js';
import {
  parseClientEvent,
  problemFingerprint,
  redactDiagnostic,
  safeClientProblemStack,
  safeClientProblemTitle,
} from '../src/admin/telemetry.js';

const originalAdminEmails = process.env.PITOLET_ADMIN_EMAILS;
const originalNotifyEmails = process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS;

afterEach(() => {
  if (originalAdminEmails === undefined) delete process.env.PITOLET_ADMIN_EMAILS;
  else process.env.PITOLET_ADMIN_EMAILS = originalAdminEmails;
  if (originalNotifyEmails === undefined) delete process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS;
  else process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS = originalNotifyEmails;
});

describe('platform admin allowlist', () => {
  it('normalizes, deduplicates, and matches verified account emails', () => {
    process.env.PITOLET_ADMIN_EMAILS = ' Owner@Pitolet.com, second@example.com,owner@pitolet.com ';
    expect(platformAdminEmails()).toEqual(['owner@pitolet.com', 'second@example.com']);
    expect(isPlatformAdmin('OWNER@PITOLET.COM')).toBe(true);
    expect(isPlatformAdmin('member@example.com')).toBe(false);
  });

  it('uses the admin allowlist when notification recipients are not configured', () => {
    process.env.PITOLET_ADMIN_EMAILS = 'owner@pitolet.com';
    delete process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS;
    expect(feedbackNotificationEmails()).toEqual(['owner@pitolet.com']);
    process.env.PITOLET_FEEDBACK_NOTIFY_EMAILS = 'alerts@pitolet.com';
    expect(feedbackNotificationEmails()).toEqual(['alerts@pitolet.com']);
  });
});

describe('feedback input privacy and file validation', () => {
  it('redacts credentials from messages and diagnostics', () => {
    const parsed = parseFeedbackSubmission({
      category: 'broken',
      message:
        'Request failed with Bearer secret-value and ptl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      includeDiagnostics: true,
      diagnostics: {
        clientErrors: ['GET /api?token=secret-value failed with pshare_abcdefghijklmnopqrstuvwx'],
      },
    });
    expect(parsed.message).not.toContain('secret-value');
    expect(parsed.message).not.toContain('ptl_aaaaaaaa');
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('secret-value');
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('pshare_abcdefghijklmnopqrstuvwx');
  });

  it('accepts supported image signatures and rejects mismatched files', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    expect(
      parseFeedbackSubmission({
        category: 'general',
        message: 'Attached',
        screenshot: { mime: 'image/png', data: png },
      }).screenshot?.mime,
    ).toBe('image/png');
    expect(() =>
      parseFeedbackSubmission({
        category: 'general',
        message: 'Wrong file',
        screenshot: { mime: 'image/png', data: Buffer.from('not a png').toString('base64') },
      }),
    ).toThrow(FeedbackInputError);

    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
    expect(() =>
      parseFeedbackSubmission({
        category: 'general',
        message: 'Too large',
        screenshot: { mime: 'image/png', data: oversized.toString('base64') },
      }),
    ).toThrow('screenshot must be 5 MB or smaller');
  });
});

describe('analytics and problem input safety', () => {
  it('accepts only named events and exact allowlisted properties', () => {
    expect(
      parseClientEvent({
        name: 'prompt_copied',
        source: 'dashboard',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        properties: { intent: 'scratch', client: 'codex', includedConnection: true },
      }),
    ).toMatchObject({ name: 'prompt_copied', source: 'dashboard' });
    expect(
      parseClientEvent({
        name: 'prompt_copied',
        source: 'dashboard',
        properties: {
          intent: 'scratch',
          client: 'codex',
          includedConnection: true,
          prompt: 'private prompt',
        },
      }),
    ).toBeNull();
    expect(parseClientEvent({ name: 'button_clicked', source: 'dashboard' })).toBeNull();
  });

  it('redacts credentials and groups changing ids and numbers consistently', () => {
    expect(redactDiagnostic('Bearer raw-token token=another-secret')).toBe(
      'Bearer [redacted] token=[redacted]',
    );
    const first = problemFingerprint(
      'server',
      'Failed request 42 for 5fca2c7a-869f-41a0-a9e2-a52f318ec2c1',
      '/api/items',
    );
    const second = problemFingerprint(
      'server',
      'Failed request 99 for 67632b56-cbb2-49b0-9be7-81e3cb23c2e4',
      '/api/items',
    );
    expect(first).toBe(second);
  });

  it('does not retain user text in automated client diagnostics', () => {
    expect(safeClientProblemTitle('TypeError: private prompt and design copy')).toBe('TypeError');
    expect(safeClientProblemTitle('private prompt and design copy')).toBe('Browser error');
    expect(
      safeClientProblemStack(
        'TypeError: private prompt\n    at CanvasRenderer (index.js:24:18)\nprivate request body',
      ),
    ).toBe('    at CanvasRenderer (index.js:24:18)');

    const parsed = parseFeedbackSubmission({
      category: 'broken',
      message: 'The page stopped working.',
      includeDiagnostics: true,
      diagnostics: { clientErrors: ['TypeError: private prompt and design copy'] },
    });
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('private prompt');
    expect(parsed.diagnostics.clientErrors).toEqual(['TypeError']);
  });
});
