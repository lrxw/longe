import { questionSections } from "../store/question.js";
import { Repo } from "../store/repo.js";

export interface AnsweredQuestion {
  id: string;
  topic: string | null;
  question: string;
  answer: string;
  answered_at: string | null;
}

/** Reads answered-but-unacknowledged questions straight from files. No server needed. */
export async function collectAnswers(repoRoot: string): Promise<AnsweredQuestion[]> {
  const repo = new Repo(repoRoot);
  const out: AnsweredQuestion[] = [];
  for (const id of await repo.listQuestionIds()) {
    try {
      const q = await repo.readQuestion(id);
      if (q.fm.status !== "answered") continue;
      const s = questionSections(q);
      out.push({
        id,
        topic: q.fm.topic ?? null,
        question: s.Question,
        answer: s.Answer,
        answered_at: q.fm.answered_at ?? null,
      });
    } catch {
      // malformed files are the UI's problem, not the hook's
    }
  }
  // oldest answer first; hand-edited files without answered_at go last
  out.sort((a, b) => (a.answered_at ?? "~").localeCompare(b.answered_at ?? "~"));
  return out;
}

/** Text meant to be injected into an agent's context by a prompt hook. Empty when nothing is pending. */
export function formatAnswersForAgent(answers: AnsweredQuestion[]): string {
  if (answers.length === 0) return "";
  const lines = [
    `[longe] ${answers.length} answered question${answers.length === 1 ? "" : "s"} waiting for you. Acknowledge with acknowledge_answers (MCP) or by setting status: acknowledged in the file, then continue the affected topic.`,
  ];
  for (const a of answers) {
    lines.push(
      "",
      `- ${a.id}${a.topic ? ` (topic: ${a.topic})` : ""}`,
      `  Q: ${a.question.replace(/\s+/g, " ")}`,
      `  A: ${a.answer.replace(/\s+/g, " ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
