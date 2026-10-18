import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// `longe provider deep-integrate` writes the user's own Codex hooks file; tests must never touch the real one
process.env.CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), "longe-codex-home-"));
// ... and the user's own Claude settings, where the longe-inbox mod is enabled
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "longe-claude-home-"));
// boards live in ~/.longe/projects/<id>/; tests get their own
process.env.LONGE_HOME = mkdtempSync(path.join(os.tmpdir(), "longe-home-"));
