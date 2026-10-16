/**
 * Adapter over APIs that Task 5's security round moves into replay/ops:
 *   - key pins: `pinAgentKey(store, agentId, key)` / `getPinnedKey(store, agentId)` (table agent_key_pins);
 *   - `deferFutureOps(ops, nowMs) -> {ready, deferred}`.
 * Until that merge lands, pins live in the replica's log-state.json (never touched by rebuilds, never replaced)
 * and no op is deferred. After the merge, swap the bodies below for the replay functions; callers stay as is.
 */
import type { ReplicaFiles } from './replicaStore.js';

export type PinResult = 'pinned' | 'match' | 'mismatch';

export interface PinStore {
  get(agentId: string): Promise<string | undefined>;
  /** First key wins forever: 'pinned' (new), 'match' (same key) or 'mismatch' (refuse the segment). */
  pin(agentId: string, key: string): Promise<PinResult>;
}

export function pinStoreFor(files: ReplicaFiles): PinStore {
  return {
    async get(agentId) {
      return (await files.readLogState()).pins[agentId];
    },
    async pin(agentId, key) {
      const state = await files.readLogState();
      const existing = state.pins[agentId];
      if (existing !== undefined) return existing === key ? 'match' : 'mismatch';
      await files.writeLogState({ ...state, pins: { ...state.pins, [agentId]: key } });
      return 'pinned';
    },
  };
}

/** Ops far ahead of the local clock wait for later rounds. Pass-through until replay exports deferFutureOps. */
export function deferFutureOps<T>(ops: T[], _nowMs: number): { ready: T[]; deferred: T[] } {
  return { ready: ops, deferred: [] };
}
