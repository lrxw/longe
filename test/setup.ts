import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// `longe provider deep-integrate` writes the user's own Codex hooks file; tests must never touch the real one
process.env.CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), "longe-codex-home-"));
// boards live in ~/.longe/projects/<id>/; tests get their own
process.env.LONGE_HOME = mkdtempSync(path.join(os.tmpdir(), "longe-home-"));
