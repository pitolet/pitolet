import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceManager } from '../src/cloud/workspaceManager.js';

interface FakeEntry {
  runtime: {
    hub: {
      close(): void;
      clientCount(): number;
    };
  };
  adapter: {
    close(): Promise<void>;
  };
  lastTouched: number;
  gen: number;
  planRef: { plan: 'free' };
}

function loadedMap(manager: WorkspaceManager): Map<string, FakeEntry> {
  return (
    manager as unknown as {
      loaded: Map<string, FakeEntry>;
    }
  ).loaded;
}

describe('WorkspaceManager shutdown', () => {
  it('closes active hubs before the final storage flush', async () => {
    const events: string[] = [];
    let clients = 1;
    const manager = new WorkspaceManager({} as Pool, '/tmp/pitolet-manager-test', {
      sweepMs: 60_000,
    });
    loadedMap(manager).set('one', {
      runtime: {
        hub: {
          clientCount: () => clients,
          close: () => {
            events.push('hub');
            clients = 0;
          },
        },
      },
      adapter: {
        close: async () => {
          events.push(`storage:${clients}`);
        },
      },
      lastTouched: Date.now(),
      gen: 0,
      planRef: { plan: 'free' },
    });

    await manager.shutdown();
    expect(events).toEqual(['hub', 'storage:0']);
  });

  it('attempts every close and reports durability failures', async () => {
    const manager = new WorkspaceManager({} as Pool, '/tmp/pitolet-manager-test', {
      sweepMs: 60_000,
      logError: vi.fn(),
    });
    const secondClose = vi.fn().mockResolvedValue(undefined);
    loadedMap(manager).set('broken', {
      runtime: { hub: { clientCount: () => 0, close: vi.fn() } },
      adapter: { close: vi.fn().mockRejectedValue(new Error('flush failed')) },
      lastTouched: Date.now(),
      gen: 0,
      planRef: { plan: 'free' },
    });
    loadedMap(manager).set('healthy', {
      runtime: { hub: { clientCount: () => 0, close: vi.fn() } },
      adapter: { close: secondClose },
      lastTouched: Date.now(),
      gen: 0,
      planRef: { plan: 'free' },
    });

    await expect(manager.shutdown()).rejects.toThrow('failed to close');
    expect(secondClose).toHaveBeenCalledOnce();
  });
});
