/**
 * Shared filesystem write helpers.
 *
 * Windows quirk: renameSync over an existing file fails with EPERM/EBUSY
 * while another process (antivirus, indexer, a concurrent reader) holds the
 * destination open. A supervision extension must never crash the host
 * process over a transient lock, so writes retry with backoff and fall
 * back to a direct (non-atomic) overwrite before giving up.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Errors that mean "destination momentarily locked" on Windows. */
const RETRYABLE = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES", "ENFILE", "EMFILE"]);

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 25;

function isRetryable(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null &&
    RETRYABLE.has((err as NodeJS.ErrnoException).code ?? "")
  );
}

function sleep(ms: number): void {
  // Atomics.wait gives a synchronous sleep without spinning the event loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort cleanup
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const data = JSON.stringify(value, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    fs.writeFileSync(tmp, data, "utf8");
    // Primary path: atomic tmp + rename. Retry through transient locks.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        if (!isRetryable(err) || attempt >= MAX_ATTEMPTS - 1) {
          if (isRetryable(err)) {
            // Lock refused to clear: fall back to a direct overwrite so the
            // state is still persisted (loaders tolerate torn writes).
            fs.writeFileSync(filePath, data, "utf8");
            tryUnlink(tmp);
            return;
          }
          throw err;
        }
        sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }
  } catch (err) {
    tryUnlink(tmp);
    throw err;
  }
}
