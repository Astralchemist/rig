// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type JSX } from 'react';

type State = 'checking' | 'authed' | 'unauthed';

export interface TokenGateProps {
  children: React.ReactNode;
}

/**
 * Probes /api/session/me to decide whether the user is authenticated. While
 * checking we render nothing; on auth fail we render the "open via your AI
 * agent" overlay; on success we render the wrapped app.
 *
 * The token is required on loopback too; `rig start` opens the map through
 * /auth?t=… so the cookie is already set. Under `rig serve --no-auth` the
 * probe always succeeds and the gate passes straight through.
 */
export function TokenGate({ children }: TokenGateProps): JSX.Element {
  const [state, setState] = useState<State>('checking');
  const [pasteValue, setPasteValue] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);

  useEffect(() => {
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch('/api/session/me', { credentials: 'include' });
        // Auth-off servers return 404 (the route only registers when authOn).
        // Treat both 200 and 404 as "we're in".
        setState(res.ok || res.status === 404 ? 'authed' : 'unauthed');
      } catch {
        setState('unauthed');
      }
    };
    void probe();
  }, []);

  if (state === 'checking') return <></>;
  if (state === 'authed') return <>{children}</>;

  const submitPaste = async (): Promise<void> => {
    const t = pasteValue.trim();
    if (!t) return;
    const res = await fetch(`/auth?t=${encodeURIComponent(t)}`, {
      credentials: 'include',
      redirect: 'manual',
    });
    // With redirect: 'manual' the 302 that sets the cookie surfaces as an
    // opaque redirect (status 0, ok false), not as a 302.
    if (res.type === 'opaqueredirect' || res.ok) {
      location.reload();
    } else {
      setPasteErr('invalid token');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg)',
        color: 'var(--text)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          padding: 32,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface2)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20, color: 'var(--accent)' }}>Rig — sign in</h1>
        <p style={{ color: 'var(--muted)', marginTop: 12 }}>
          The map requires a session token. Tokens live in <code>.rig/.runtime</code> and rotate
          when you delete that file.
        </p>
        <h3 style={{ fontSize: 13, color: 'var(--text)', marginTop: 24, marginBottom: 8 }}>
          Option 1 — open via your AI agent
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
          In Claude Code / Cursor / Codex, ask:{' '}
          <span style={{ color: 'var(--accent)' }}>"open the rig map"</span> — your agent will call{' '}
          <code>rig_session_token</code> and hand you a one-click login URL.
        </p>
        <h3 style={{ fontSize: 13, color: 'var(--text)', marginTop: 24, marginBottom: 8 }}>
          Option 2 — paste the token
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: '0 0 8px' }}>
          <code>cat .rig/.runtime</code> in your project directory.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={pasteValue}
            onChange={(e) => {
              setPasteValue(e.target.value);
              setPasteErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitPaste();
            }}
            placeholder="paste token here"
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'var(--bg)',
              border: `1px solid ${pasteErr ? 'var(--danger)' : 'var(--border)'}`,
              borderRadius: 4,
              color: 'var(--text)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
            }}
          />
          <button
            onClick={() => void submitPaste()}
            style={{
              padding: '6px 14px',
              background: 'var(--accent)',
              color: 'var(--accent-text)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            sign in
          </button>
        </div>
        {pasteErr && (
          <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{pasteErr}</div>
        )}
      </div>
    </div>
  );
}
