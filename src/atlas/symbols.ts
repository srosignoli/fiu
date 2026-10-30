import { branchCount } from '../explore/shortlist.ts';

/** A symbol declared in a source file, named as `file#symbol` accepts it. */
export interface AtlasSymbol {
  /** A method is `Class.method`. */
  name: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** A function or method, as opposed to a class, type, or other container. */
  callable: boolean;
  /** Branching per line, gently favouring longer bodies: the same measure as a file's logic score. */
  score: number;
}

/** Key functions are the densest callables of at least this many lines. */
export const KEY_FUNCTION_MIN_LINES = 5;
export const KEY_FUNCTIONS_PER_FILE = 5;

type Pattern = { regex: RegExp; callable: boolean; container?: boolean; method?: boolean };

const IDENT = '[A-Za-z_$][\\w$]*';
const MODIFIERS = '(?:(?:export|default|declare|abstract|public|private|protected|pub(?:\\([^)]*\\))?|static|async|unsafe)\\s+)*';

/** Language-neutral declaration patterns: TypeScript and JavaScript, Python, Go, Rust, and anything close enough. */
const PATTERNS: Pattern[] = [
  // Go methods: `func (s *Store) Get(` becomes Store.Get.
  { regex: new RegExp(`^(?<indent>)func\\s+\\(\\s*\\w*\\s*\\*?\\s*(?<receiver>${IDENT})(?:\\[[^\\]]*\\])?\\s*\\)\\s*(?<name>${IDENT})`), callable: true },
  { regex: new RegExp(`^(?<indent>\\s*)${MODIFIERS}(?:function\\*?|def|func|fn)\\s+(?<name>${IDENT})`), callable: true },
  { regex: new RegExp(`^(?<indent>\\s*)${MODIFIERS}(?:class|trait)\\s+(?<name>${IDENT})`), callable: false, container: true },
  { regex: new RegExp(`^(?<indent>\\s*)impl(?:<[^>]*>)?\\s+(?:${IDENT}(?:<[^>]*>)?\\s+for\\s+)?(?<name>${IDENT})`), callable: false, container: true },
  { regex: new RegExp(`^(?<indent>\\s*)${MODIFIERS}(?:interface|enum|struct|type)\\s+(?<name>${IDENT})`), callable: false },
  { regex: new RegExp(`^(?<indent>\\s*)${MODIFIERS}(?:const|let|var)\\s+(?<name>${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\(|${IDENT}\\s*=>)`), callable: true },
  // A method inside a class body; only kept when it is inside one.
  {
    regex: new RegExp(
      `^(?<indent>\\s+)(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*\\*?(?<name>${IDENT})\\s*(?:<[^>]*>)?\\s*\\((?:[^)]*\\)\\s*(?::\\s*[^{;]+)?\\{\\s*$|\\s*$)`,
    ),
    callable: true,
    method: true,
  },
];

const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'else', 'do', 'try', 'with', 'new']);

interface Declaration {
  name: string;
  line: number;
  indent: number;
  callable: boolean;
  container: boolean;
  method: boolean;
  receiver?: string;
}

/** The symbols a source file declares, outermost first by line. `declarationPattern` replaces the built-in patterns. */
export function extractSymbols(source: string, declarationPattern?: string): AtlasSymbol[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const patterns: Pattern[] = declarationPattern ? [{ regex: new RegExp(declarationPattern), callable: true }] : PATTERNS;
  const declarations: Declaration[] = [];
  lines.forEach((text, i) => {
    for (const pattern of patterns) {
      const groups = pattern.regex.exec(text)?.groups;
      if (!groups?.name || NOT_A_NAME.has(groups.name)) continue;
      declarations.push({
        name: groups.name,
        line: i + 1,
        indent: (groups.indent ?? text.match(/^\s*/)![0]).length,
        callable: pattern.callable,
        container: pattern.container ?? false,
        method: pattern.method ?? false,
        ...(groups.receiver ? { receiver: groups.receiver } : {}),
      });
      break;
    }
  });

  const ranged = declarations.map((d, i) => {
    const next = declarations.slice(i + 1).find((other) => other.indent <= d.indent && !other.method);
    const upper = next ? next.line - 1 : lines.length;
    return { ...d, endLine: endOf(lines, d.line, d.indent, upper) };
  });

  const symbols: AtlasSymbol[] = [];
  for (const d of ranged) {
    const enclosing = ranged.filter((other) => other !== d && other.line < d.line && other.endLine >= d.endLine && other.indent < d.indent);
    // Nested in a function: part of that function. A method pattern outside a class is a call, not a declaration.
    if (enclosing.some((other) => other.callable)) continue;
    const container = enclosing.filter((other) => other.container).at(-1);
    if (d.method && !container) continue;
    if (enclosing.length > 0 && !container) continue;
    const owner = d.receiver ?? container?.name;
    const body = lines.slice(d.line - 1, d.endLine).join('\n');
    const length = d.endLine - d.line + 1;
    symbols.push({
      name: owner ? `${owner}.${d.name}` : d.name,
      startLine: d.line,
      endLine: d.endLine,
      callable: d.callable,
      score: (branchCount(body) / length) * Math.log10(length + 1),
    });
  }
  return symbols;
}

/** The densest callables of at least KEY_FUNCTION_MIN_LINES lines, at most KEY_FUNCTIONS_PER_FILE. */
export function keyFunctions(symbols: AtlasSymbol[]): AtlasSymbol[] {
  return symbols
    .filter((s) => s.callable && s.endLine - s.startLine + 1 >= KEY_FUNCTION_MIN_LINES)
    .sort((a, b) => b.score - a.score || b.endLine - b.startLine - (a.endLine - a.startLine) || a.startLine - b.startLine)
    .slice(0, KEY_FUNCTIONS_PER_FILE);
}

/**
 * A line without its comment, for counting braces. String literals stay: a template literal's `${…}`
 * balances out, while stripping nested template literals would unbalance it.
 */
const codeOf = (line: string) => (/^\s*(\/\/|#|\*|\/\*)/.test(line) ? '' : line.replace(/\s(\/\/|#)\s.*$/, ''));

/**
 * Where a declaration ends: at its matching closing brace when its header opens one, otherwise where
 * the indentation returns to its own level (Python, one-liners). Never past the next declaration at
 * the same or an outer level.
 */
function endOf(lines: string[], start: number, indent: number, upper: number): number {
  const indentOf = (line: string) => line.match(/^\s*/)![0].length;
  const header = Math.min(upper, start + 10);
  for (let i = start; i <= header; i++) {
    const code = codeOf(lines[i - 1]!).trimEnd();
    if (code.endsWith(':')) break;
    // The body opens at the end of a line; braces earlier in the header (destructured parameters) balance out.
    if (code.endsWith('{')) {
      let depth = 0;
      for (let j = i; j <= upper; j++) {
        for (const char of codeOf(lines[j - 1]!)) {
          if (char === '{') depth++;
          else if (char === '}') depth--;
        }
        if (depth <= 0) return j;
      }
      return trimBlank(lines, start, upper);
    }
    if (code.endsWith(';') || (i === start && /\}[;,]?$/.test(code))) return i;
  }
  let end = start;
  for (let j = start + 1; j <= upper; j++) {
    const line = lines[j - 1]!;
    if (line.trim() === '') continue;
    if (indentOf(line) <= indent && !/^\s*[)\]}]/.test(line)) break;
    end = j;
  }
  return end;
}

function trimBlank(lines: string[], start: number, end: number): number {
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return end;
}
