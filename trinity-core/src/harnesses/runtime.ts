import { getAdapter } from './registry.ts';
import type { HarnessAdapter } from './types.ts';

/**
 * The only place the request path resolves an adapter. Production uses the
 * registry; tests pass a runtime whose adapters are scripted, so no global
 * mutable state is involved.
 */
export interface CoreRuntime {
  getAdapter(type: string): HarnessAdapter;
}

export const defaultRuntime: CoreRuntime = {
  getAdapter: (type) => getAdapter(type),
};
