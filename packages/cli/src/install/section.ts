const BEGIN = '<!-- rig:begin -->';
const END = '<!-- rig:end -->';

// Idempotent: re-running with the same body produces a byte-identical file.
// Find an existing rig-managed block and replace it; if absent, append at end.
export function upsertSection(existing: string, body: string): string {
  const block = `${BEGIN}\n${body.replace(/^\n+|\n+$/g, '')}\n${END}\n`;
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END, beginIdx + BEGIN.length);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).replace(/\n*$/, '');
    const after = existing.slice(endIdx + END.length).replace(/^\n*/, '');
    const sep = before ? '\n\n' : '';
    return before + sep + block + (after ? '\n' + after : '');
  }
  const sep = !existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + block;
}

export function removeSection(existing: string): string {
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END, beginIdx + BEGIN.length);
  if (beginIdx < 0 || endIdx < 0) return existing;
  const before = existing.slice(0, beginIdx).replace(/\n*$/, '');
  const after = existing.slice(endIdx + END.length).replace(/^\n*/, '');
  if (!before && !after) return '';
  if (!before) return after + (after.endsWith('\n') ? '' : '\n');
  if (!after) return before + '\n';
  return before + '\n\n' + after;
}
