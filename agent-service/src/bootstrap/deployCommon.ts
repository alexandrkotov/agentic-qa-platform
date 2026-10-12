// Shared plumbing for the two deploy paths — bootstrap/deployTarget.ts
// (docker-compose targets) and bootstrap/deployProcessTarget.ts (targets
// built from source and run as plain processes). Both need the same error
// classes, the same abort-aware helpers, ONE in-process lock map (so a
// deploy and an undeploy of the same name exclude each other regardless of
// which path owns that name) and ONE cancellation registry (so the admin
// server's /deploy/cancel route doesn't need to know which path is running).

export class DeployTargetError extends Error {}

/** Thrown (not a subclass of DeployTargetError — callers need to tell "user cancelled" apart from "genuinely failed") when a deploy's AbortSignal fires. */
export class DeployCancelledError extends Error {}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DeployCancelledError('Deploy cancelled by user');
}

/** Abort-aware `setTimeout` — resolves immediately on cancellation instead of making the caller wait out the full delay before its own `checkCancelled()` can run. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolveSleep();
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// In-process lock — deploy/undeploy of the SAME target must never
// interleave (a concurrent `up` and `down` racing on the same compose
// project is exactly the kind of thing that produces confusing partial
// state). Rejects immediately rather than queuing: a second click on
// "Deploy" while one is already running should read as "already in
// progress", not silently wait its turn.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(name)) {
    throw new DeployTargetError(`a deploy/undeploy for "${name}" is already in progress`);
  }
  const promise = fn();
  locks.set(name, promise);
  try {
    return await promise;
  } finally {
    locks.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Cancellation — keyed by descriptor name so the Stop button's own
// fire-and-forget /deploy/cancel route (admin/server.ts) can reach the
// *specific* deploy an admin/server.ts route handler is awaiting, without
// either side needing to share anything beyond the name. Registered for the
// duration of deployTarget()'s own call (inside withLock, so there's at
// most one entry per name at a time by construction) — a Stop click after
// the deploy has already finished just finds nothing to cancel and no-ops.
// ---------------------------------------------------------------------------

export const activeDeploys = new Map<string, AbortController>();

/** True if a deploy for `name` was actually in flight and got signalled; false if there was nothing to cancel (already finished, or never started). */
export function cancelDeploy(name: string): boolean {
  const controller = activeDeploys.get(name);
  if (!controller) return false;
  controller.abort();
  return true;
}
