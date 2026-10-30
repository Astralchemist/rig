// SPDX-License-Identifier: Apache-2.0

// Text helpers for the settled-moment extractor: masking what the user quotes
// (so cue words inside it never fire), sentence splitting, anchors, and short
// summaries.

// Text the user did not say in their own voice is masked before cue matching:
// fenced code, inline code, double-quoted strings and `>` quote lines. Each
// mask is a placeholder that `restore` turns back into the original, so
// summaries still carry the identifiers.
export interface Masked {
  text: string;
  restore: (s: string) => string;
}

const PLACEHOLDER = /⟦(\d+)⟧/g;

export const mask = (raw: string): Masked => {
  const saved: string[] = [];
  const keep = (m: string): string => {
    saved.push(m);
    return `⟦${saved.length - 1}⟧`;
  };
  const text = raw
    // Host-injected blocks: reminders, IDE selections, slash-command output.
    .replace(
      /<(system-reminder|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+|bash-[a-z-]+)>[\s\S]*?<\/\1>/g,
      ' ',
    )
    .replace(/```[\s\S]*?(?:```|$)/g, keep)
    .replace(/^[ \t]*>.*$/gm, keep)
    .replace(/`[^`\n]+`/g, keep)
    .replace(/"[^"\n]{1,200}"|“[^”\n]{1,200}”/g, keep);
  const restore = (s: string): string =>
    s.replace(PLACEHOLDER, (_, i: string) => {
      const v = saved[Number(i)] ?? '';
      // A code fence or a quote line is not part of a one-line summary.
      return v.startsWith('```') || v.trimStart().startsWith('>') ? '' : v;
    });
  return { text, restore };
};

// Sentences of masked text: split after . ! ? (followed by space), on line
// breaks and on bullet starts. Periods inside paths (`a.ts`) are kept.
export const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+|;\s+|\s+[—–]\s+(?=[A-Za-z])/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((s) => s.length > 0);

const INTERROGATIVE =
  /^(?:should|shall|could|would|can|will|what|why|how|which|when|where|who|whose|is|are|was|were|does|did|do (?:you|we|i|they)|have (?:you|we)|has|isn'?t|aren'?t|doesn'?t|didn'?t|wouldn'?t|shouldn'?t|any idea|what if|how about)\b/i;

export const isQuestion = (sentence: string): boolean => {
  const s = sentence.trim();
  if (/\?\s*$/.test(s)) return true;
  return INTERROGATIVE.test(s.replace(/^(?:so|and|but|ok(?:ay)?|hmm+|um+|also),?\s+/i, ''));
};

// Collapse whitespace, drop placeholders left empty, trim punctuation at the
// ends.
export const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:—–-]+/, '')
    .replace(/[\s,;:—–-]+$/, '')
    .trim();

export const capitalize = (s: string): string => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);

// Cut at a word boundary to at most `max` characters.
export const clip = (s: string, max: number): string => {
  const t = tidy(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
};

export const wordCount = (s: string): number => (s.match(/[A-Za-z0-9_]+/g) ?? []).length;

const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|go|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|md|mdx|json|jsonc|toml|yaml|yml|sql|sh|css|scss|html|vue|svelte|lock|env|txt|ini|cfg|proto|graphql';
const FILE_RE = new RegExp(
  String.raw`(?:^|[\s\`'"(\[<,])((?:~|\.{1,2})?/?(?:[\w@.+-]+/)*[\w@+-][\w@.+-]*\.(?:${FILE_EXT}))(?=$|[\s\`'"),\]>:;!?]|\.(?:\s|$))`,
  'g',
);
const FILE_TAIL = new RegExp(String.raw`\.(?:${FILE_EXT})$`);
// A directory: `generated/` in inline code, or a bare multi-segment path
// (src/api/custom/, packages/parser). Not a URL, not "and/or".
const DIR_RE = /`((?:[\w@.-]+\/)+)`/g;
const BARE_DIR_RE = /(?:^|[\s(])((?:[\w@-][\w@.-]*\/)+[\w@-]*)(?=$|[\s),;:!?]|\.(?:\s|$))/g;
const SYMBOL_IN_CODE = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const SYMBOL_BARE =
  /\b(?:[a-z][a-z0-9]*[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z]\w*_\w+|[A-Za-z_]\w*\(\))(?=$|[^\w])/g;
const NOT_SYMBOL = new Set(['e.g', 'i.e', 'node_modules', 'iOS', 'macOS', 'npm', 'eBay', 'iPhone']);

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export const filesIn = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const p = m[1]!;
    // Version numbers and abbreviations look like files: v1.2.ts never does.
    if (/^\d+(?:\.\d+)+$/.test(p)) continue;
    out.push(p);
  }
  for (const m of text.matchAll(DIR_RE)) out.push(m[1]!);
  for (const m of text.replace(/`[^`\n]*`/g, ' ').matchAll(BARE_DIR_RE)) {
    const d = m[1]!;
    const parts = d.split('/').filter(Boolean);
    if (/^[a-z]+:$/i.test(parts[0] ?? '') || parts.every((p) => p.length <= 3)) continue;
    if (!d.endsWith('/') && parts.length < 2) continue;
    if (out.some((f) => f.startsWith(d))) continue;
    out.push(d);
  }
  return uniq(out);
};

export const symbolsIn = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1]!.trim();
    if (SYMBOL_IN_CODE.test(s) && !FILE_TAIL.test(s.replace(/\(\)$/, ''))) {
      out.push(s.replace(/\(\)$/, ''));
    }
  }
  const bare = text.replace(/`[^`\n]+`/g, ' ').replace(FILE_RE, ' ');
  for (const m of bare.matchAll(SYMBOL_BARE)) {
    const s = m[0].replace(/\(\)$/, '');
    if (s.length < 4 || NOT_SYMBOL.has(s)) continue;
    out.push(s);
  }
  return uniq(out);
};

// Files a tool call works on: the usual path fields, then paths in a shell
// command.
export const toolFiles = (input: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v) out.push(v);
  }
  const cmd = input.command;
  if (typeof cmd === 'string') out.push(...filesIn(cmd));
  return uniq(out);
};

// One line saying what a tool call did, for a summary.
export const describeTool = (name: string, input: Record<string, unknown>): string => {
  const cmd = input.command;
  if (typeof cmd === 'string' && cmd.trim()) {
    return `\`${clip(cmd.split('\n')[0]!, 90)}\``;
  }
  const file = toolFiles(input)[0];
  if (file) return `${name.toLowerCase()} ${file}`;
  return name;
};
