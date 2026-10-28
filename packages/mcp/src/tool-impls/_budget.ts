// SPDX-License-Identifier: Apache-2.0

// Claude Code rejects an MCP tool response over 25,000 tokens. Heavy tools
// return source bodies, so they keep the serialized response — the JSON text
// that goes over the wire, escapes included — under this many characters,
// roughly 15–20k tokens of code.
export const HEAVY_RESPONSE_BUDGET = 60_000;

// Room for fields filled in after fitting (elapsed_ms).
const SLACK = 32;

const marker = (shown: number, total: number): string =>
  `… [truncated: ${shown} of ${total} lines shown]`;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

// Cut `source` to at most `cap` characters, marker line included. Prefers a
// line break; a single huge line (minified code) is cut inside it instead.
const clip = (source: string, cap: number): string => {
  if (source.length <= cap) return source;
  const total = source.split('\n').length;
  const room = Math.max(0, cap - marker(total, total).length - 1);
  let cut = source.lastIndexOf('\n', room);
  if (cut < room / 2) cut = room;
  if (cut > 0 && isHighSurrogate(source.charCodeAt(cut - 1))) cut--;
  const head = source.slice(0, cut);
  return head ? `${head}\n${marker(head.split('\n').length, total)}` : marker(0, total);
};

// Max-min fair split of `room` characters: short sources stay whole and the
// long ones share what is left equally, so one huge anchor can't starve the rest.
const fairShare = (lengths: readonly number[], room: number): number[] => {
  const caps = lengths.map(() => 0);
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  let left = Math.max(0, room);
  order.forEach((i, k) => {
    caps[i] = Math.min(lengths[i]!, Math.floor(left / (order.length - k)));
    left -= caps[i]!;
  });
  return caps;
};

/**
 * Shorten the `source` of each item until `render(items)` — which must build
 * the tool's serialized response — fits in `budget` characters. Truncated
 * sources end with a "[truncated: …]" line. Item order and count are kept.
 */
export const fitSources = <T extends { source: string }>(
  items: readonly T[],
  render: (items: readonly T[]) => string,
  budget = HEAVY_RESPONSE_BUDGET,
): { items: T[]; truncated: boolean } => {
  const target = budget - SLACK;
  if (render(items).length <= target) return { items: [...items], truncated: false };
  const lengths = items.map((it) => it.source.length);
  const withSources = (caps: readonly number[]): T[] =>
    items.map((it, i) => ({ ...it, source: clip(it.source, caps[i]!) }));
  // Everything but the bodies: ids, paths, related anchors, JSON punctuation.
  const overhead = render(items.map((it) => ({ ...it, source: '' }))).length;
  let room = target - overhead;
  for (let attempt = 0; attempt < 8 && room > 0; attempt++) {
    const caps = fairShare(lengths, room);
    const fitted = withSources(caps);
    const size = render(fitted).length;
    if (size <= target) return { items: fitted, truncated: true };
    // JSON escapes (\n, \", \\ — twice over for format=json) make the wire
    // longer than the raw characters; scale what was used by that expansion.
    const used = caps.reduce((sum, c) => sum + c, 0);
    room = Math.floor((used * (target - overhead)) / (size - overhead)) - 1;
  }
  return { items: withSources(lengths.map(() => 0)), truncated: true };
};
