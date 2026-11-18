export interface CommitInfo {
  sha: string;
  subject: string;
  authorEmail: string;
  parents: string[];
  /** A `Co-Authored-By` trailer names an AI coding assistant. */
  aiAuthored: boolean;
}

/** Trailers coding assistants add to the commits they co-author. */
const AI_CO_AUTHOR = /^co-authored-by:.*\b(claude|anthropic|copilot|cursor|codex|openai|chatgpt|gemini|windsurf|codeium|devin|aider|amazon q|codewhisperer|jules)\b/i;

export const isAiAuthored = (message: string) => AI_CO_AUTHOR.test(message);

/** Reads a commit as `git show -s --format=%H%x00%P%x00%ae%x00%s%x00%B` prints it; `show` stands in for running git. */
export function readCommit(show: (rev: string) => string, rev: string): CommitInfo {
  const stdout = show(rev);
  const [sha = '', parents = '', authorEmail = '', subject = '', body = ''] = stdout.split('\0');
  return { sha, subject, authorEmail, parents: parents.split(' ').filter(Boolean), aiAuthored: isAiAuthored(body) };
}
