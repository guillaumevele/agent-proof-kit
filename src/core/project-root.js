import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROTECTED_CONFIG_PATH = ".agent-proof/protected.json";

// Walks up from `start` to the nearest directory that contains
// `.agent-proof/protected.json` (written by `agent-proof init`). Returns null
// when no ancestor is initialized.
export function findAgentProofRoot(start) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, PROTECTED_CONFIG_PATH))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
