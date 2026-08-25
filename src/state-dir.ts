/**
 * F2: Bulkhead's own state directory (<repoRoot>/.bulkhead/) IS the
 * enforcement substrate — the ledger, the spend rollup, and the loop state all
 * live there. Until this module existed, any error while touching it was
 * caught by cli.ts's fail-open handler, so `chmod 000 .bulkhead` silently
 * disabled every guard AND the audit trail while `ledger verify` kept
 * reporting the frozen prefix healthy.
 *
 * A permission failure on that directory is not a transient bug: the guarded
 * process can cause it with one mundane command. It fails CLOSED — the call is
 * denied with a reason a human can act on.
 *
 * Deliberate scope (see PR notes): only permission-class failures raised by
 * operations that touch Bulkhead state are classified this way. The set is
 * enumerated below — one entry per errno, each persistent and
 * human-actionable:
 *
 *   - EACCES / EPERM — the guarded agent can cause these itself with one
 *     mundane command (`chmod 000 .bulkhead`), so they must never degrade to
 *     a silent allow.
 *   - EROFS — same persistence and blast radius as a permission failure: the
 *     substrate is gone until a human changes the mount, not a transient bug.
 *
 * ENOSPC is deliberately NOT in this set even though it produces the same
 * silent-off-switch outcome: it arrives without anyone choosing it, its blast
 * radius is machine-wide, and failing closed there would brick every agent on
 * a full disk during an incident. Tracked for a separate decision — see
 * https://github.com/laqaer/bulkhead-cli/issues/4. Every other error keeps the
 * historical fail-open behaviour, because a bug in Bulkhead must not brick the
 * host agent — containment, not a footgun.
 */

/** Error type for permission failures on Bulkhead's own state directory. */
export class StateDirUnavailableError extends Error {
  readonly path: string;
  readonly fsCode: string;

  constructor(path: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | null)?.code ?? "UNKNOWN";
    super(
      `Bulkhead state directory \`${path}\` is not writable (${code}). ` +
        `Enforcement cannot load or record evidence, so this action is denied. ` +
        `Fix: restore access to .bulkhead/ (e.g. \`chmod u+rwx .bulkhead\`, or check ` +
        `for a parent directory owned by another user). A human must do this — ` +
        `the guarded agent cannot be trusted to restore its own oversight.`,
      { cause },
    );
    this.name = "StateDirUnavailableError";
    this.path = path;
    this.fsCode = code;
  }
}

const FAIL_CLOSED_ERRNOS = new Set(["EACCES", "EPERM", "EROFS"]);

/** True when `err` is the typed state-dir failure cli.ts must deny on. */
export function isStateDirError(err: unknown): err is StateDirUnavailableError {
  return err instanceof StateDirUnavailableError;
}

/**
 * Run `op` (which writes into `dir` under .bulkhead/) and rethrow permission
 * failures as StateDirUnavailableError. Anything else propagates unchanged so
 * the existing fail-open boundary keeps today's behaviour.
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
