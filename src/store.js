// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the stop after the panel refused a code at login, so a
// restart never sends a refused code again (a panel may count wrong codes:
// "user code tamper"). Never the codes themselves, nor anything derived from
// them (a short code is brute-forced from any hash). The file is readable by
// the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/bosch-alarm-state.json';

/** What an unreadable state file means: stopped (date unknown). */
const UNREADABLE = () => ({ codeStop: { at: 0 } });

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /**
     * No file: no stop. A file that cannot be read, is too big or is not
     * JSON counts as a stop: a doubt never sends a refused code again.
     */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? null : UNREADABLE();
      }
      // A state file is a few dozen bytes: anything big is not ours.
      if (text.length > 4096) return UNREADABLE();
      try {
        return JSON.parse(text);
      } catch {
        return UNREADABLE();
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

/**
 * The persisted state, repaired: { codeStop: { at } | null }. The stop
 * belongs to the integration (its codes), not to an address: a new IP of the
 * panel never lifts it. Any stop found, even malformed, is kept: a doubt
 * never sends a refused code again.
 */
export function normalizeMemory(raw) {
  const stop = raw?.codeStop;
  const present = stop !== null && typeof stop === 'object' && !Array.isArray(stop);
  return {
    codeStop: present
      ? { at: Number.isFinite(stop.at) ? stop.at : 0, doubtful: stop.doubtful === true }
      : null,
  };
}
