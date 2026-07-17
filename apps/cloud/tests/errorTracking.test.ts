import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetErrorTrackingForTests,
  captureException,
  flushErrorTracking,
  initErrorTracking,
  type ErrorTrackingClient,
} from '../src/ops/errorTracking.js';

function fakeClient(): ErrorTrackingClient & {
  init: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    close: vi.fn(async () => true),
  };
}

afterEach(() => {
  __resetErrorTrackingForTests();
  vi.restoreAllMocks();
});

describe('production error tracking', () => {
  it('does not load the client when no DSN is configured', async () => {
    const load = vi.fn(async () => fakeClient());

    await expect(initErrorTracking(undefined, load)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('initialises, captures, and flushes the bundled client', async () => {
    const client = fakeClient();

    await expect(
      initErrorTracking('  https://public@example.test/1  ', async () => client),
    ).resolves.toBe(true);

    expect(client.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://public@example.test/1',
        sendDefaultPii: false,
      }),
    );
    const failure = new Error('boom');
    captureException(failure);
    await flushErrorTracking(750);
    expect(client.captureException).toHaveBeenCalledWith(failure);
    expect(client.close).toHaveBeenCalledWith(750);
  });

  it('fails boot instead of silently disabling a configured tracker', async () => {
    await expect(
      initErrorTracking('https://public@example.test/1', async () => {
        throw new Error('client unavailable');
      }),
    ).rejects.toThrow('error tracking failed to initialise');
  });
});
