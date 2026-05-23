const BEGIN = '<!-- rig:begin -->';
const END = '<!-- rig:end -->';

const stripBlock = (existing: string): { before: string; body: string | null; after: string } => {
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END, beginIdx + BEGIN.length);
  if (beginIdx < 0 || endIdx <= beginIdx) {
    return { before: existing, body: null, after: '' };
  }
  return {
    before: existing.slice(0, beginIdx).replace(/\n*$/, ''),
    body: existing.slice(beginIdx + BEGIN.length, endIdx).replace(/^\n+|\n+$/g, ''),
    after: existing.slice(endIdx + END.length).replace(/^\n*/, ''),
  };
};

// Idempotent: re-running with the same body produces a byte-identical file.
// Find an existing rig-managed block and replace it; if absent, append at end.
export function upsertSection(existing: string, body: string): string {
  const block = `${BEGIN}\n${body.replace(/^\n+|\n+$/g, '')}\n${END}\n`;
  const parts = stripBlock(existing);
  if (parts.body !== null) {
    const sep = parts.before ? '\n\n' : '';
    return parts.before + sep + block + (parts.after ? '\n' + parts.after : '');
  }
  const sep = !existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + block;
}

// Hardened variant: returns hadUserEdits=true when the existing block's body
// (between markers, whitespace-normalized) doesn't match what we're about to
// write. Callers should save a backup before clobbering.
export function upsertSectionSafe(
  existing: string,
  body: string,
): { content: string; hadUserEdits: boolean; previousBody: string | null } {
  const parts = stripBlock(existing);
  const normalized = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const hadUserEdits =
    parts.body !== null && normalized(parts.body) !== normalized(body);
  const content = upsertSection(existing, body);
  return { content, hadUserEdits, previousBody: parts.body };
}

export function removeSection(existing: string): string {
  const parts = stripBlock(existing);
  if (parts.body === null) return existing;
  if (!parts.before && !parts.after) return '';
  if (!parts.before) return parts.after + (parts.after.endsWith('\n') ? '' : '\n');
  if (!parts.after) return parts.before + '\n';
  return parts.before + '\n\n' + parts.after;
}
