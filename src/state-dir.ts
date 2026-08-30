/**
 * F2: Bulkhead's own state directory (<repoRoot>/.bulkhead/) IS the
 * enforcement substrate — the ledger, the spend rollup, and the loop state all
 * live there. Until this module existed, any error while touching it was
 * caught by cli.ts's fail-open handler, so `chmod 000 .bulkhead` silently
 * disabled every guard AND the audit trail while `ledger verify` kept
 * reporting the frozen prefix healthy.
 *
 * A failure that makes that directory unavailable or prevents serialized state
 * updates is not a transient guard bug: the guarded process can cause it, and
 * continuing would leave enforcement or evidence unbacked. It fails CLOSED —
 * the call is denied with a reason a human can act on.
 *
 * Deliberate scope (see PR notes): only named failures raised by operations
 * that touch Bulkhead state are classified this way. The set is enumerated
 * below — one entry per condition, each leaving enforcement and evidence
 * unbacked:
 *
 *   - EACCES / EPERM — the guarded agent can cause these itself with one
 *     mundane command (`chmod 000 .bulkhead`), so they must never degrade to
 *     a silent allow.
 *   - EROFS — same persistence and blast radius as a permission failure: the
 *     substrate is gone until a human changes the mount, not a transient bug.
 *   - ENOSPC — the state filesystem has no free blocks or inodes. It can be
 *     accidental or agent-induced, and may be scoped to one filesystem rather
 *     than the whole machine. Allowing work to continue would disable every
 *     guard and the audit trail, so a human must restore capacity first.
 *   - ELOCKTIMEOUT — another hook still owns the serialization lock past the
 *     bounded wait. The protected read-modify-write did not run; allowing the
 *     tool while evidence is unrecorded or appending unlocked would undermine
 *     the state and ledger invariants.
 *
 * Every other error keeps the historical fail-open behaviour, because a bug
 * in Bulkhead must not brick the host agent — containment, not a footgun.
 */

/** Error type for fail-closed failures on Bulkhead's own state directory. */
export class StateDirUnavailableError extends Error {
  readonly path: string;
  readonly fsCode: string;

  constructor(path: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | null)?.code ?? "UNKNOWN";
    const fix =
      code === "ENOSPC"
        ? "free blocks or inodes on the filesystem containing .bulkhead/, then retry."
        : code === "EROFS"
          ? "restore a writable mount for .bulkhead/, then retry."
          : code === "ELOCKTIMEOUT"
            ? "wait for the competing Bulkhead hook to finish; if the lock is genuinely stale, a human may remove the verified stale lock file and retry."
            : "restore access to .bulkhead/ (for example, `chmod u+rwx .bulkhead`), then retry.";
    super(
      `Bulkhead state directory \`${path}\` is unavailable for safe enforcement (${code}). ` +
        `Enforcement cannot load or record trustworthy evidence, so this action is denied. ` +
        `Fix: ${fix} A human must do this — ` +
        `the guarded agent cannot be trusted to restore its own oversight.`,
      { cause },
    );
    this.name = "StateDirUnavailableError";
    this.path = path;
    this.fsCode = code;
  }
}

const FAIL_CLOSED_ERRNOS = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "ELOCKTIMEOUT",
]);

/** True when `err` is the typed state-dir failure cli.ts must deny on. */
export function isStateDirError(err: unknown): err is StateDirUnavailableError {
  return err instanceof StateDirUnavailableError;
}

/**
 * Run `op` (which reads/writes serialized state under .bulkhead/) and rethrow
 * named substrate failures as StateDirUnavailableError. Anything else
 * propagates unchanged so the existing fail-open boundary keeps today's
 * behaviour.
 */
export function guardStateDir<T>(dir: string, op: () => T): T {
  try {
    return op();
  } catch (err) {
    if (
      err instanceof Error &&
      FAIL_CLOSED_ERRNOS.has((err as NodeJS.ErrnoException).code ?? "")
    ) {
      throw new StateDirUnavailableError(dir, err);
    }
    throw err;
  }
}
