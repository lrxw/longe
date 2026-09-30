import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// `longe connect` writes the user's own Codex hooks file; tests must never touch the real one
process.env.CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), "longe-codex-home-"));
