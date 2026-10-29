// SPDX-License-Identifier: Apache-2.0
import {
  capitalize,
  clip,
  describeTool,
  filesIn,
  isQuestion,
  mask,
  sentences,
  symbolsIn,
  tidy,
  toolFiles,
  wordCount,
} from './text.ts';
import type {
  ConversationEvent,
  NormalizedConversation,
  SettledAnchors,
  SettledKind,
  SettledRecord,
} from './types.ts';

// Deterministic extractor of the moments a conversation settled something:
// an approved proposal, a rejection or correction, a constraint, a decision
// the user stated, an attempt that failed and was given up. No model: plain
// conversational patterns over the user's own words, with the assistant's
// proposal (what a "yes" answers) and tool results (what failed) as context.
//
// Precision over recall. Cue words only count in the user's own voice —
// quoted text, code and `>` quotes are masked — and never in a question.

const SUMMARY_MAX = 200;
const RATIONALE_MAX = 300;
// Past this many characters a cue is more likely incidental (a long task
// description), so its confidence drops.
const LONG_MESSAGE = 800;

// ── user-message heads ──────────────────────────────────────────────────────

const END = String.raw`(?=$|[\s,.!:;—–-])`;

const APPROVE_STRONG = new RegExp(
  String.raw`^(?:yes|yep|yeah|yup|ya|yes please|sure|absolutely|definitely|go ahead|go for it|do it|do that|do this|ship it|merge(?: it| that)?|approved?|lgtm|sgtm|please do|please proceed|proceed|let'?s do (?:it|that|this)|let'?s go(?=[\s.!]*$)|sounds good|sounds great|sounds right|looks good|looks great|that works|works for me|agreed|i agree|make it so|that'?s the one)${END}`,
  'i',
);
const APPROVE_WEAK = new RegExp(
  String.raw`^(?:ok(?:ay)?|k|alright|all right|right|correct|exactly|perfect|great|good|nice|cool|fine|fine by me|that'?s fine|that'?s good|makes sense|that makes sense)${END}`,
  'i',
);
const REJECT_HEAD = new RegExp(
  String.raw`^(?:no|nope|nah|don'?t|do not|please don'?t|stop|wait|hold on|hold off|revert(?: (?:it|that|this|those|these))?|undo(?: (?:it|that|this))?|roll ?(?:it |that )?back|scrap (?:that|it|this)|not (?:that|this|like that|quite|yet)|never ?mind|cancel(?: (?:that|it))?|that'?s (?:wrong|not right|not what i)|wrong|let'?s not|i don'?t (?:want|like) (?:that|this|it))${END}`,
  'i',
);
const REJECT_EXCLUDE =
  /^(?:no (?:problem|problems|worries|rush|need|idea|clue|biggie|pressure|sweat)|no,? (?:that'?s|it'?s|this is|you'?re) (?:fine|ok|okay|good|right|correct|perfect|great|exactly)|don'?t (?:worry|apologi[sz]e|know|think|understand|see|remember|care|mind|get|bother)|not (?:bad|sure|really|a problem)|nope,? (?:that'?s|it'?s) (?:fine|ok|good)|wait,? (?:what|why|how|is|are|does|did|really|so)\b|never ?mind,? (?:i|it|that) (?:found|works|figured|got))/i;
const THANKS_ONLY =
  /^(?:[\s,.!]*(?:thanks?|thank you|thx|ty|cheers|much appreciated|appreciate it|great|nice|good|cool|awesome|perfect|job|work|great job|nice work|well done|that'?s it|for now|so much)[\s,.!]*)*$/i;
// After a weak head, a continuation that makes it an approval.
const APPROVE_CONTINUATION =
  /^(?:go ahead|do it|proceed|let'?s do|please|ship it|merge|that'?s what i want|that works|sounds good|yes)\b/i;

// ── sentence rules ──────────────────────────────────────────────────────────

const LEAD_FILLER =
  /^(?:please|and|also|but|oh|btw|fyi|just|so|then|ok(?:ay)?|important|reminder|note|remember|one more thing|one thing)\b[\s,:—–-]*/i;
const REMEMBER_THAT = /^(?:remember|note|keep in mind)\s+(?:that\s+|to\s+)?/i;

const stripFiller = (s: string): string => {
  let t = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(LEAD_FILLER, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
};

const stripRejectHead = (s: string): string =>
  s
    .replace(/^(?:no|nope|nah|actually|wait|hmm+|hold on|not (?:that|quite))\b[\s,.!:;—–-]*/i, '')
    .trim();

const REPORTED = /\b(?:says|said|reads|wrote|writes|claims|quoted|according to)\b/i;

// Verbs a user opens an instruction with.
const IMPERATIVE =
  'use|do|try|go with|switch to|call|put|keep|make|return|throw|store|write|prefer|pass|emit|log|move|add|remove|rename|import|export|read|load|cache|run|wrap|split|inline|validate|parse|handle|raise|send|fetch|query|compute|set|show|render|check';

const CORRECTION_PATTERNS: Array<{ re: RegExp; cue: string }> = [
  {
    re: /\b(?:use|try|go with|switch to|call|keep|put|make it|do|pick|prefer|move it to|move|return|import|write|store)\b.{2,120}?\binstead\b/i,
    cue: 'use-x-instead',
  },
  {
    re: /\binstead of\b.{2,80}?,?\s*(?:use|do|try|go with|we should|let'?s|please|call|switch to|i want|put|keep)\b/i,
    cue: 'instead-of-x-y',
  },
  {
    re: new RegExp(
      String.raw`\brather than\b.{2,80}?,?\s*(?:${IMPERATIVE}|we should|let'?s|please|i want)\b|^(?:${IMPERATIVE}|we should|let'?s|please)\b.{2,100}?\brather than\b`,
      'i',
    ),
    cue: 'rather-than',
  },
  {
    re: /^(?:don'?t|do not|never)\s+(?:use|call|do|add|go with|pick|put)\s+.{1,80}?[,;—–-]+\s*(?:use|call|do|add|go with|try|pick|put)\s+\S/i,
    cue: 'not-x-use-y',
  },
];

// After a rejection head: "no, put it in utils/date.ts" / "no, it should be X".
const DIRECTIVE_AFTER_NO =
  /^(?:use|put|make|call|move|rename|change|keep|switch|try|go with|let'?s|we should|you should|it should|that should|this should|it needs to|it has to|do it|add|write|return|import|set|place|split|merge|only)\b/i;

const DECISION_STRONG =
  /\b(?:we(?:'ve| have)? (?:decided|agreed|settled on|chose|picked|went with|opted for|standardi[sz]ed on)|i(?:'ve| have)? decided|we(?:'re| are) (?:keeping|going with|sticking with|staying with|standardi[sz]ing on|moving to|switching to)|(?:the|our|my) decision (?:is|was)|(?:we|i)(?:'ll| will) (?:go with|stick with|keep)|decided (?:to|on|that))\b/i;
const DECISION_SOFT =
  /^(?:then\s+)?let'?s (?:go with|stick with|keep|use|standardi[sz]e on|switch to|move to|adopt)\b/i;
const DECISION_SOFT_EXCLUDE =
  /^(?:then\s+)?let'?s (?:keep (?:going|it up|looking|digging|at it|trying|this in mind)|use (?:this|that|it) (?:to|for) (?:see|check|test|debug)|go with (?:the (?:first|second|third|fourth|last|latter|former)|option|approach|plan|#|[a-d1-4]\b|(?:that|this|it)\b))/i;
const RULED_OUT =
  /\b(?:was|were|got|has been|have been|is) (?:rejected|ruled out|abandoned|vetoed)\b|\bdecided against\b|\b(?:we|i) (?:ruled out|rejected|dropped|abandoned|ditched|scrapped)\b|\bwe(?:'re| are) not (?:going to|gonna) (?:use|do|go with|adopt|keep)\b/i;

const CONSTRAINT_LEAD_STRONG =
  /^(?:never|always|don'?t|do not|must not|mustn'?t|under no circumstances|stop \w+ing)\b/i;
const CONSTRAINT_LEAD_SOFT =
  /^(?:only\b|avoid\b|make sure\b|ensure\b|leave\b.{1,60}\b(?:alone|as is|as-is|untouched|unchanged)\b|keep\b.{1,60}\b(?:as is|as-is|unchanged|stable|intact|backwards?[- ]compatible|compatible|the same|private|local|in sync|under|below|within|offline|deterministic|green)\b|no more\b|nothing (?:should|may|must)\b)/i;
const CONSTRAINT_MID =
  /\b(?:must(?: not| never| always)?|mustn'?t|should (?:never|always)|shall not|(?:may|can) only|(?:is|are) not allowed|(?:is|are) off[- ]limits|hands off|under no circumstances|at all times|no matter what|from now on|going forward|(?:don'?t|do not|never) (?:touch|modify|change|edit|delete|remove|commit|push|rename|use|call|import|bump|upgrade|downgrade|expose|log|store|send|add|merge|force|skip|disable|mock|hardcode|hard-code|depend))\b/i;
const CONSTRAINT_EXCLUDE =
  /\b(?:don'?t|do not) (?:worry|know|think|understand|see|remember|care|mind|get|bother|need to worry|have)\b|\bnever ?mind\b|\bmust (?:be|have) (?:been |the |a |an |because|due|something|some |it |that |why|what|wrong|broken|cached|stale|missing|related)|\bmust'?ve\b|\bmust be (?:it|that|this)\b|\balways (?:been|was|were|had|happens|seems|fails|breaks|crashes|returns?|works)\b|\bonly (?:if you|when you want|just|now|then|fails|happens|works|on ci|in ci|occasionally|sometimes|thing|problem|issue|difference)\b|\bnever (?:seen|heard|had|been|knew|thought|worked|happened|used|got)\b|^only (?:the|a|one|two|\d+|this|that) \w+ (?:fails?|failed|pass(?:es)?|passed|is|are|was|were|has|have|breaks?)\b/i;
const GENERIC_DONT =
  /^(?:please\s+)?(?:don'?t|do not|never|stop)(?:\s+(?:do|touch|change|use|run|that|it|this|those|these|anything|yet|now|again|please))*\s*[.!]*$/i;
const FROM_NOW_ON = /\b(?:from now on|going forward|at all times|no matter what)\b/i;

// ── assistant proposals ─────────────────────────────────────────────────────

const PROPOSAL =
  /\b(?:should I|shall I|do you want me to|want me to|would you like me to|would you like (?:me )?to|should we|shall we|(?:I(?:'d| would)|I) (?:suggest|recommend|propose)|my (?:recommendation|suggestion|proposal)|I can (?:either|go ahead|also|now|start|switch|add|implement|update|change|refactor|fix|remove|move|rename|merge|push|revert|delete|replace)|we could|one option|is it ok(?:ay)? (?:if|to)|ok(?:ay)? (?:if I|to proceed|to go ahead)|ready to (?:merge|commit|push|ship|deploy|release)|let me know if (?:you(?:'d)? (?:like|want)|that works|I should)|does (?:that|this) (?:sound|work|look)|sound good|(?:here'?s|the) (?:plan|proposal|approach)\b|proceed with|go ahead (?:and|with))/i;
const PROPOSAL_LEAD =
  /^(?:so,?\s+)?(?:should I|shall I|do you want me to|want me to|would you like me to|would you like (?:me )?to|should we|shall we|(?:I(?:'d| would)|I) (?:suggest|recommend|propose)(?: that)?(?: we)?(?: you)?|my (?:recommendation|suggestion|proposal)(?: is)?(?: to)?:?|I can|we could|one option (?:is|would be)(?: to)?|is it ok(?:ay)? (?:if I|to)|ok(?:ay)? (?:if I|to)|let me know if (?:you(?:'d)? (?:like|want) me to|I should)|ready to|proceed with|go ahead and)\s*/i;
const GENERIC_PROPOSAL =
  /^(?:(?:go ahead|proceed|continue|do (?:that|it|this|so)|implement (?:this|that|it)|make (?:that|the|these|those) changes?|apply (?:this|that|it|the fix|these changes)|start|get started|move forward|go on|that|this|it)\b.{0,20}|.*\b(?:does (?:that|this) (?:sound|work|look)|sound good|the plan|this plan|the approach|the proposal)\b.*)$/i;
const stripProposalLead = (s: string): string =>
  tidy(s.replace(PROPOSAL_LEAD, '').replace(/\?+\s*$/, ''));

const OPTION_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:option|approach|plan)?\s*\(?([A-Da-d1-4])\s*[).:\]—–-]\s*(?:\*\*)?\s*(.+)$/i;
const OPTION_PICK =
  /^(?:(?:let'?s\s+)?(?:go with|pick|choose|take|use|i(?:'d)? (?:prefer|pick|choose|go with|vote for|like))\s+)?(?:(?:option|approach|plan|#)\s*([a-d1-4])\b|the (first|second|third|fourth|last|latter|former)\b(?: one| option| approach| plan)?)/i;
const OPTION_BARE =
  /^(?:(?:let'?s\s+)?(?:go with|pick|choose|i(?:'d)? (?:prefer|pick|choose|go with))\s+)?([a-d1-4])[\s.!)]*(?:please|thanks)?[\s.!]*$/i;

// ── tool failures ───────────────────────────────────────────────────────────

const FAILURE_OUTPUT =
  /\b[1-9]\d* (?:fail|failed|failing|failures|errors?)\b|\bFAIL(?:ED)?\b|Traceback \(most recent call last\)|\berror TS\d+|\bpanicked at\b|\bexit (?:code|status):? [1-9]|\bCommand failed\b|npm ERR!|\b(?:SyntaxError|TypeError|ReferenceError|AssertionError|ModuleNotFoundError|ImportError|CompileError)\b|^error(?:\[E\d+\])?:/m;
const ABANDON =
  /\b(?:(?:that|this|the|my) (?:approach|attempt|fix|change|idea|strategy|workaround|patch|route|path) (?:doesn'?t|didn'?t|won'?t|does not|did not|will not|isn'?t going to) (?:work|help|fly)|didn'?t (?:work|help|fix (?:it|this|that|the))|doesn'?t (?:work|help) (?:either|here|for)|won'?t work|dead end|revert(?:ing)? (?:that|this|the|my)|roll(?:ing)? (?:that |this |it )?back|back(?:ing)? (?:that |this |it )?out|undo(?:ing)? (?:that|this|the|my)|(?:a|take a|try a) different approach|another approach|try (?:something else|a different|another)|abandon(?:ing)?|giving up on|not viable|isn'?t viable|not going to work)\b/i;
const REVERT_CMD = /\bgit\s+(?:revert|restore|checkout\s+(?:--\s|HEAD\b|\.\s*$)|reset\s+--hard)/;
const ERROR_LINE =
  /error|fail|exception|panicked|cannot|can't|not found|undefined|refused|denied|timed? ?out/i;
const INTENT =
  /\b(?:let me|let's|i'?ll|i will|i'm going to|trying|try|attempt|switch(?:ing)? to|use)\b/i;
const RECOVERY = /\binstead\b|\bdifferent approach\b|\banother approach\b|\bswitch(?:ing)? to\b/i;

// ── helpers ─────────────────────────────────────────────────────────────────

interface AssistantText {
  index: number;
  text: string;
}

interface Action {
  index: number;
  name: string;
  input: Record<string, unknown>;
  id?: string;
  result?: { index: number; output: string; isError: boolean };
}

interface Proposal {
  index: number;
  summary: string;
  // Text the anchors come from (the proposal sentence, the chosen option).
  source: string;
}

const emptyAnchors = (): SettledAnchors => ({ files: [], symbols: [] });

const mergeAnchors = (...texts: string[]): SettledAnchors => {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const t of texts) {
    for (const f of filesIn(t)) files.add(f);
    for (const s of symbolsIn(t)) symbols.add(s);
  }
  return { files: [...files].slice(0, 12), symbols: [...symbols].slice(0, 12) };
};

const addFiles = (a: SettledAnchors, files: readonly string[]): SettledAnchors => ({
  files: [...new Set([...a.files, ...files])].slice(0, 12),
  symbols: a.symbols,
});

const summaryOf = (s: string): string => capitalize(clip(s, SUMMARY_MAX));
const rationaleOf = (s: string): string => clip(s, RATIONALE_MAX);

// The proposal a reply answers: the last proposal sentence in the assistant's
// text since the previous user message. A generic one ("Want me to go
// ahead?") stands for the plan before it, so the summary takes that.
const findProposal = (texts: readonly AssistantText[]): Proposal | null => {
  for (let t = texts.length - 1; t >= 0; t--) {
    const at = texts[t]!;
    const m = mask(at.text);
    const lines = m.text.split('\n');
    const sents = sentences(m.text);
    for (let i = sents.length - 1; i >= 0 && i >= sents.length - 12; i--) {
      const s = sents[i]!;
      if (!PROPOSAL.test(s)) continue;
      const stripped = stripProposalLead(m.restore(s));
      if (wordCount(stripped) >= 3 && !GENERIC_PROPOSAL.test(stripped)) {
        return { index: at.index, summary: stripped, source: m.restore(s) };
      }
      // Generic: the plan's list items (after it, else right before it),
      // else the closest substantive sentence before it.
      const lineAt = lines.findIndex((l) => l.includes(s.slice(0, 30)));
      const isItem = (l: string): boolean => /^\s*(?:[-*\u2022]|\d+[.)])\s+/.test(l);
      const itemText = (l: string): string =>
        tidy(m.restore(l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '')));
      if (lineAt >= 0) {
        let after = lines.slice(lineAt + 1).filter(isItem);
        if (!after.length) {
          // The contiguous block of items just above (blank lines allowed).
          const block: string[] = [];
          for (let j = lineAt - 1; j >= 0; j--) {
            const l = lines[j]!;
            if (isItem(l)) block.unshift(l);
            else if (l.trim() && block.length) break;
            else if (l.trim()) break;
          }
          after = block;
        }
        if (after.length) {
          const items = after.map(itemText);
          return { index: at.index, summary: items.join('; '), source: items.join('\n') };
        }
      }
      for (let j = i - 1; j >= 0; j--) {
        const prev = sents[j]!;
        if (isQuestion(prev) || wordCount(prev) < 4) continue;
        const r = tidy(m.restore(prev));
        return { index: at.index, summary: stripProposalLead(r), source: r };
      }
    }
  }
  return null;
};

const ORDINAL: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, former: 0 };

// The option the user picked ("option B", "the second one") among the
// assistant's enumerated options.
const findOption = (texts: readonly AssistantText[], pick: string): Proposal | null => {
  for (let t = texts.length - 1; t >= 0; t--) {
    const at = texts[t]!;
    const m = mask(at.text);
    const options: string[] = [];
    const keys: string[] = [];
    for (const line of m.text.split('\n')) {
      const o = OPTION_LINE.exec(line);
      if (o) {
        keys.push(o[1]!.toLowerCase());
        options.push(tidy(m.restore(o[2]!)).replace(/\*\*/g, ''));
      }
    }
    if (options.length < 2) continue;
    const p = pick.toLowerCase();
    let idx = keys.indexOf(p);
    if (idx < 0 && p in ORDINAL) idx = ORDINAL[p]!;
    if (idx < 0 && (p === 'last' || p === 'latter')) idx = options.length - 1;
    const chosen = options[idx];
    if (chosen) return { index: at.index, summary: chosen, source: chosen };
  }
  return null;
};

const isFailure = (a: Action): boolean => {
  if (!a.result) return false;
  if (typeof a.input.command !== 'string') return false;
  if (a.result.isError) return true;
  const out = a.result.output;
  const probe = out.length > 6000 ? `${out.slice(0, 3000)}\n${out.slice(-3000)}` : out;
  return FAILURE_OUTPUT.test(probe);
};

const errorLineOf = (output: string): string => {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = lines.find((l) => ERROR_LINE.test(l)) ?? lines[0] ?? 'failed';
  return clip(hit, 120);
};

// What the assistant set out to do before a tool call: its last sentence of
// intent, else the call itself.
const attemptOf = (texts: readonly AssistantText[], a: Action): string => {
  const before = texts.filter((t) => t.index < a.index).at(-1);
  if (before) {
    const m = mask(before.text);
    const s = sentences(m.text)
      .reverse()
      .find((x) => INTENT.test(x) && !isQuestion(x) && wordCount(x) >= 3);
    if (s) {
      return tidy(
        m
          .restore(s)
          .replace(
            /^(?:now,?\s+|ok(?:ay)?,?\s+|first,?\s+)?(?:let me|i'?ll|i will|i'm going to)\s+/i,
            '',
          ),
      );
    }
  }
  return describeTool(a.name, a.input);
};

const isNoise = (raw: string): boolean =>
  /^\s*(?:<command-|<local-command-|<bash-|<user-prompt-submit-hook|\[Request interrupted|Caveat: The messages below|This session is being continued from a previous conversation)/.test(
    raw,
  );

// ── per-message classification ──────────────────────────────────────────────

interface Draft {
  kind: SettledKind;
  summary: string;
  rationale: string;
  anchors: SettledAnchors;
  confidence: number;
  from: number;
  to: number;
  cue: string;
  trigger: number;
  // Add the files the assistant then edited, before the next user message.
  followUp?: boolean;
}

interface SentenceHit {
  kind: SettledKind;
  cue: string;
  summary: string;
  confidence: number;
  // Index of the sentence in the message.
  at: number;
}

const constraintOf = (raw: string): { cue: string; confidence: number } | null => {
  const s = stripFiller(raw.replace(REMEMBER_THAT, ''));
  if (wordCount(s) < 3) return null;
  if (CONSTRAINT_EXCLUDE.test(s) || GENERIC_DONT.test(s)) return null;
  const bonus = FROM_NOW_ON.test(s) ? 0.05 : 0;
  if (CONSTRAINT_LEAD_STRONG.test(s)) return { cue: 'imperative', confidence: 0.8 + bonus };
  if (CONSTRAINT_LEAD_SOFT.test(s)) return { cue: 'imperative-soft', confidence: 0.7 + bonus };
  if (CONSTRAINT_MID.test(s)) return { cue: 'modal', confidence: 0.7 + bonus };
  return null;
};

const sentenceHits = (
  sents: readonly string[],
  restore: (s: string) => string,
  rejectHead: boolean,
  approveHead: string | null,
): SentenceHit[] => {
  const hits: SentenceHit[] = [];
  sents.forEach((s, at) => {
    if (isQuestion(s) || REPORTED.test(s)) return;
    let body = s;
    if (at === 0 && rejectHead) body = stripRejectHead(s);
    else if (at === 0 && approveHead && s.toLowerCase().startsWith(approveHead)) {
      body = s.slice(approveHead.length).replace(/^[\s,.!:;\u2014\u2013-]+/, '');
    }
    if (!body) return;
    const restored = (x: string): string => tidy(restore(x));
    if (RULED_OUT.test(body)) {
      hits.push({
        kind: 'rejected',
        cue: 'ruled-out',
        summary: restored(stripFiller(body)),
        confidence: 0.75,
        at,
      });
      return;
    }
    if (DECISION_STRONG.test(body)) {
      hits.push({
        kind: 'decision',
        cue: 'stated-decision',
        summary: restored(stripFiller(body)),
        confidence: 0.8,
        at,
      });
      return;
    }
    for (const c of CORRECTION_PATTERNS) {
      if (c.re.test(body)) {
        hits.push({
          kind: 'correction',
          cue: c.cue,
          summary: restored(stripFiller(body)),
          confidence: rejectHead ? 0.8 : 0.7,
          at,
        });
        return;
      }
    }
    if (
      rejectHead &&
      at <= 1 &&
      DIRECTIVE_AFTER_NO.test(stripFiller(body)) &&
      wordCount(body) >= 3
    ) {
      if (
        !constraintOf(body) ||
        /^(?:use|put|move|rename|switch|it should|that should|this should)\b/i.test(body)
      ) {
        hits.push({
          kind: 'correction',
          cue: 'no-then-directive',
          summary: restored(stripFiller(body)),
          confidence: 0.75,
          at,
        });
        return;
      }
    }
    const soft = stripFiller(body);
    if (DECISION_SOFT.test(soft) && !DECISION_SOFT_EXCLUDE.test(soft) && wordCount(soft) >= 4) {
      hits.push({
        kind: 'decision',
        cue: 'lets-go-with',
        summary: restored(soft),
        confidence: 0.7,
        at,
      });
      return;
    }
    const k = constraintOf(body);
    if (k) {
      hits.push({
        kind: 'constraint',
        cue: k.cue,
        summary: restored(stripFiller(body.replace(REMEMBER_THAT, ''))),
        confidence: k.confidence,
        at,
      });
    }
  });
  return hits;
};

interface Run {
  texts: AssistantText[];
  actions: Action[];
}

const lastActionDesc = (run: Run): Action | null =>
  [...run.actions]
    .reverse()
    .find((a) => !/^(?:read|grep|glob|ls|search|webfetch|websearch|todo)/i.test(a.name)) ?? null;

const classifyUser = (index: number, raw: string, run: Run): Draft[] => {
  if (isNoise(raw)) return [];
  const m = mask(raw);
  const text = m.text.trim();
  if (!text) return [];
  const sents = sentences(text);
  if (!sents.length) return [];
  const lower = text.toLowerCase().replace(/^[\s"'*_]+/, '');
  const penalty = raw.length > LONG_MESSAGE ? 0.1 : 0;
  const userWords = rationaleOf(m.restore(text));
  const userAnchors = mergeAnchors(raw);

  const rejectHead =
    REJECT_HEAD.test(lower) && !REJECT_EXCLUDE.test(lower) && !sents.every(isQuestion);
  const strong = APPROVE_STRONG.exec(lower);
  const weak = strong ? null : APPROVE_WEAK.exec(lower);
  const hits = sentenceHits(
    sents.map((x, i) => (i === 0 ? x.replace(/^[\s"'*_]+/, '') : x)),
    m.restore,
    rejectHead,
    rejectHead ? null : ((strong ?? weak)?.[0].toLowerCase() ?? null),
  );
  const drafts: Draft[] = [];

  const proposal = findProposal(run.texts);
  const corrections = hits.filter((h) => h.kind === 'correction');

  const fromHit = (h: SentenceHit, extra: Partial<Draft> = {}): Draft => ({
    kind: h.kind,
    summary: summaryOf(h.summary),
    rationale: userWords,
    anchors: userAnchors,
    confidence: h.confidence - penalty,
    from: index,
    to: index,
    cue: h.cue,
    trigger: index,
    followUp: h.kind === 'correction' || h.kind === 'decision',
    ...extra,
  });

  // A correction answering a proposal says what it replaced.
  for (const h of corrections) {
    const d = fromHit(h);
    if (proposal && !/\binstead of\b|\brather than\b|\bnot\b/i.test(h.summary)) {
      d.summary = summaryOf(`${h.summary} (not: ${clip(proposal.summary, 70)})`);
    }
    if (proposal) {
      d.from = proposal.index;
      d.anchors = mergeAnchors(raw, proposal.source);
    }
    drafts.push(d);
  }
  for (const h of hits) if (h.kind !== 'correction') drafts.push(fromHit(h));

  // Option picks: "option B", "the second one", a bare "B".
  const pick = OPTION_PICK.exec(lower) ?? OPTION_BARE.exec(lower);
  if (!corrections.length && pick) {
    const opt = findOption(run.texts, (pick[1] ?? pick[2] ?? '').toLowerCase());
    if (opt) {
      drafts.push({
        kind: 'agreed',
        summary: summaryOf(opt.summary),
        rationale: userWords,
        anchors: mergeAnchors(raw, opt.source),
        confidence: 0.8 - penalty,
        from: opt.index,
        to: index,
        cue: 'option-pick',
        trigger: index,
        followUp: true,
      });
      return drafts;
    }
  }

  if ((strong || weak) && !rejectHead && !corrections.length && proposal) {
    const head = (strong ?? weak)![0];
    const rest = lower.slice(head.length).replace(/^[\s,.!:;—–-]+/, '');
    const restIsThanks = THANKS_ONLY.test(rest);
    const approves = strong
      ? !(restIsThanks && /^(?:sure|ok)/.test(head)) || rest === ''
      : rest === '' ||
        APPROVE_CONTINUATION.test(rest) ||
        (!restIsThanks && wordCount(rest) <= 6 && !isQuestion(rest));
    if (approves && !(weak && restIsThanks && rest !== '')) {
      drafts.push({
        kind: 'agreed',
        summary: summaryOf(proposal.summary),
        rationale: userWords,
        anchors: mergeAnchors(raw, proposal.source),
        confidence: (strong ? 0.8 : 0.7) - penalty,
        from: proposal.index,
        to: index,
        cue: strong ? 'approve' : 'approve-weak',
        trigger: index,
        followUp: true,
      });
    }
  }

  if (rejectHead && !corrections.length) {
    // A constraint in the first sentence already says what not to do.
    const firstConstraint = hits.some((h) => h.kind === 'constraint' && h.at === 0);
    if (!firstConstraint) {
      const action = lastActionDesc(run);
      if (proposal) {
        drafts.push({
          kind: 'rejected',
          summary: summaryOf(`Rejected: ${proposal.summary}`),
          rationale: userWords,
          anchors: mergeAnchors(raw, proposal.source),
          confidence: 0.75 - penalty,
          from: proposal.index,
          to: index,
          cue: 'reject',
          trigger: index,
        });
      } else if (action) {
        drafts.push({
          kind: 'rejected',
          summary: summaryOf(`Rejected: ${attemptOf(run.texts, action)}`),
          rationale: userWords,
          anchors: addFiles(userAnchors, toolFiles(action.input)),
          confidence: 0.65 - penalty,
          from: action.index,
          to: index,
          cue: 'reject-action',
          trigger: index,
        });
      }
    }
  }
  return drafts;
};

// ── the walk ────────────────────────────────────────────────────────────────

export const extractSettled = (conv: NormalizedConversation): SettledRecord[] => {
  const offset = conv.offset ?? 0;
  const emitFrom = conv.emit_from ?? offset;
  const events = conv.events;
  const drafts: Draft[] = [];
  let run: Run = { texts: [], actions: [] };
  let pendingFailure: Action | null = null;
  const userIdx: number[] = [];

  const deadEnd = (
    failed: Action,
    at: number,
    said: string,
    cue: string,
    confidence: number,
  ): void => {
    const m = mask(said);
    const sents = sentences(m.text).map((s) => tidy(m.restore(s)));
    const giveUp = sents.find((s) => ABANDON.test(s)) ?? '';
    const recovery = sents.find((s) => RECOVERY.test(s));
    const attempt = attemptOf(run.texts, failed).replace(/[.!]+$/, '');
    const error = errorLineOf(failed.result?.output ?? '');
    const rec = recovery
      ? `; instead: ${clip(recovery.replace(/^(?:so,?\s+)?(?:let me|i'?ll|i will)\s+/i, '').replace(/[.!]+$/, ''), 90)}`
      : '';
    drafts.push({
      kind: 'dead-end',
      summary: summaryOf(`${clip(attempt, 90)} — failed: ${error}${rec}`),
      rationale: rationaleOf([error, giveUp].filter(Boolean).join(' — ')),
      anchors: addFiles(mergeAnchors(attempt, said), toolFiles(failed.input)),
      confidence: confidence + (recovery ? 0.05 : 0),
      from: failed.index,
      to: at,
      cue,
      trigger: at,
    });
  };

  events.forEach((e: ConversationEvent, i) => {
    const index = offset + i;
    switch (e.type) {
      case 'assistant': {
        run.texts.push({ index, text: e.text });
        if (pendingFailure) {
          const m = mask(e.text);
          if (sentences(m.text).some((s) => ABANDON.test(s))) {
            deadEnd(pendingFailure, index, e.text, 'failed-then-abandoned', 0.7);
            pendingFailure = null;
          }
        }
        return;
      }
      case 'tool_call': {
        const a: Action = { index, name: e.name, input: e.input, ...(e.id ? { id: e.id } : {}) };
        run.actions.push(a);
        const cmd = e.input.command;
        if (pendingFailure && typeof cmd === 'string' && REVERT_CMD.test(cmd)) {
          const said = run.texts
            .filter((t) => t.index > pendingFailure!.index)
            .map((t) => t.text)
            .join('\n');
          deadEnd(pendingFailure, index, said, 'failed-then-reverted', 0.75);
          pendingFailure = null;
        }
        return;
      }
      case 'tool_result': {
        const a =
          (e.id ? run.actions.find((x) => x.id === e.id) : undefined) ??
          [...run.actions].reverse().find((x) => !x.result);
        if (!a) return;
        a.result = { index, output: e.output, isError: e.is_error === true };
        if (isFailure(a)) pendingFailure = a;
        else if (
          pendingFailure &&
          a.name === pendingFailure.name &&
          a.input.command === pendingFailure.input.command
        ) {
          // The same command now passes: that was iteration, not a dead end.
          pendingFailure = null;
        }
        return;
      }
      case 'permission': {
        const a =
          (e.id ? run.actions.find((x) => x.id === e.id) : undefined) ?? run.actions.at(-1) ?? null;
        const what = a ? describeTool(a.name, a.input) : e.tool;
        const files = a ? toolFiles(a.input) : [];
        const proposal = findProposal(run.texts);
        if (e.decision === 'approved') {
          if (proposal) {
            drafts.push({
              kind: 'agreed',
              summary: summaryOf(proposal.summary),
              rationale: rationaleOf(`approved ${e.tool}: ${what}`),
              anchors: addFiles(mergeAnchors(proposal.source), files),
              confidence: 0.6,
              from: proposal.index,
              to: index,
              cue: 'permission-approved',
              trigger: index,
            });
          }
          return;
        }
        const reason = e.reason?.trim() ?? '';
        const fromReason = reason ? classifyUser(index, reason, run) : [];
        if (fromReason.some((d) => d.kind === 'correction' || d.kind === 'constraint')) {
          drafts.push(...fromReason.filter((d) => d.kind !== 'rejected'));
          return;
        }
        drafts.push({
          kind: 'rejected',
          summary: summaryOf(`Declined: ${a ? attemptOf(run.texts, a) : what}`),
          rationale: rationaleOf(reason || `declined ${e.tool}: ${what}`),
          anchors: addFiles(reason ? mergeAnchors(reason) : emptyAnchors(), files),
          confidence: reason ? 0.7 : 0.6,
          from: a?.index ?? index,
          to: index,
          cue: 'permission-denied',
          trigger: index,
        });
        return;
      }
      case 'user': {
        drafts.push(...classifyUser(index, e.text, run));
        if (!isNoise(e.text)) {
          userIdx.push(index);
          run = { texts: [], actions: [] };
          pendingFailure = null;
        }
        return;
      }
    }
  });

  // Follow-up anchors: files the assistant edited after an approval or a
  // correction, up to the next user message.
  const edits = new Map<number, string[]>();
  events.forEach((e, i) => {
    if (
      e.type === 'tool_call' &&
      /^(?:edit|write|multiedit|notebookedit|str_replace|create)/i.test(e.name)
    ) {
      edits.set(offset + i, toolFiles(e.input));
    }
  });
  for (const d of drafts) {
    if (!d.followUp) continue;
    const next = userIdx.find((u) => u > d.trigger) ?? Number.MAX_SAFE_INTEGER;
    let to = d.to;
    for (const [at, files] of edits) {
      if (at > d.trigger && at < next && files.length) {
        d.anchors = addFiles(d.anchors, files);
        to = Math.max(to, at);
      }
    }
    d.to = to;
  }

  // One record per (kind, summary); the more confident wins.
  const out = new Map<string, SettledRecord>();
  for (const d of drafts) {
    if (d.trigger < emitFrom) continue;
    const anchored = d.anchors.files.length + d.anchors.symbols.length > 0;
    const confidence =
      Math.round(Math.min(0.95, Math.max(0, d.confidence + (anchored ? 0.05 : 0))) * 100) / 100;
    const rec: SettledRecord = {
      kind: d.kind,
      summary: d.summary,
      rationale: d.rationale,
      anchors: d.anchors,
      confidence,
      span: { from: Math.min(d.from, d.trigger), to: Math.max(d.to, d.trigger) },
      cue: d.cue,
    };
    const key = `${rec.kind}\u0000${rec.summary.toLowerCase()}`;
    const prev = out.get(key);
    if (!prev || prev.confidence < rec.confidence) out.set(key, rec);
  }
  return [...out.values()].sort((a, b) => a.span.to - b.span.to || a.span.from - b.span.from);
};
