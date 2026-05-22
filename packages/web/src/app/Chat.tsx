import { useState } from 'react';

export interface ChatProps {
  selected: string | null;
  selectedName: string | null;
}

const buildPrompt = (selected: string | null, selectedName: string | null, body: string): string => {
  if (!selected) return body;
  const tag = selectedName ? `${selectedName} (id: ${selected})` : selected;
  return `[About ${tag}]\n\n${body}`;
};

// Phase 2 chat is compose-only — building the prompt with the selected anchor
// injected as a [About <name>] prefix. The wire-up to a real chat backend
// lands when the model-agnostic chat layer ships (Phase 4 per the plan).
export function Chat({ selected, selectedName }: ChatProps): JSX.Element {
  const [body, setBody] = useState('');
  const [copied, setCopied] = useState(false);

  const onCopy = async (): Promise<void> => {
    const full = buildPrompt(selected, selectedName, body);
    await navigator.clipboard.writeText(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 360,
        background: 'rgba(11,13,18,0.92)',
        borderTop: '1px solid #1f2937',
        padding: 12,
        zIndex: 8,
      }}
    >
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
        {selected ? (
          <>composing about <code style={{ color: '#60a5fa' }}>{selectedName ?? selected}</code></>
        ) : (
          'select a node to scope your question'
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="what touches authStore?"
          rows={2}
          style={{
            flex: 1,
            background: '#111827',
            color: '#e5e7eb',
            border: '1px solid #374151',
            borderRadius: 4,
            padding: 8,
            fontFamily: 'inherit',
            fontSize: 13,
            resize: 'vertical',
          }}
        />
        <button
          onClick={() => void onCopy()}
          disabled={!body.trim()}
          style={{
            background: copied ? '#10b981' : '#374151',
            color: '#e5e7eb',
            border: 'none',
            borderRadius: 4,
            padding: '0 16px',
            cursor: body.trim() ? 'pointer' : 'not-allowed',
            fontSize: 12,
            minWidth: 110,
          }}
        >
          {copied ? 'copied' : 'copy prompt'}
        </button>
      </div>
    </div>
  );
}
