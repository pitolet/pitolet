import { describe, expect, it } from 'vitest';
import {
  assetLimitMessage,
  docCreateDenial,
  memberLimitDenial,
  PLAN_LIMITS,
  planOf,
  shareLinkLimitDenial,
  tokenLimitDenial,
  workspaceCreateDenial,
} from '../src/cloud/plans.js';

describe('unlimited internal entitlement', () => {
  it('has no workspace or nested resource limits', () => {
    const huge = Number.MAX_SAFE_INTEGER;

    expect(planOf('unlimited')).toBe('unlimited');
    expect(
      workspaceCreateDenial(
        Array.from({ length: 1000 }, () => 'unlimited'),
        true,
      ),
    ).toBeNull();
    expect(docCreateDenial('unlimited', huge)).toBeNull();
    expect(memberLimitDenial('unlimited', huge)).toBeNull();
    expect(tokenLimitDenial('unlimited', huge)).toBeNull();
    expect(shareLinkLimitDenial('unlimited', huge)).toBeNull();
    expect(PLAN_LIMITS.unlimited.assetBytesPerWorkspace).toBe(Number.POSITIVE_INFINITY);
    expect(PLAN_LIMITS.unlimited.historyDays).toBe(Number.POSITIVE_INFINITY);
    expect(assetLimitMessage('unlimited')).toContain('unlimited');
  });
});
