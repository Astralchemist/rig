// SPDX-License-Identifier: Apache-2.0
import { KeyRound } from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';

type State = 'checking' | 'authed' | 'unauthed' | 'offline';

export interface TokenGateProps {
  children: React.ReactNode;
}

export const BrandMark = ({ className = 'brand-mark' }: { className?: string }): JSX.Element => (
  <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="6" cy="7" r="2.4" fill="currentColor" />
    <circle cx="18" cy="6" r="1.6" fill="currentColor" opacity=".7" />
    <circle cx="16" cy="17" r="2.9" fill="currentColor" />
    <circle cx="5.5" cy="17.5" r="1.4" fill="currentColor" opacity=".55" />
    <path
      d="M6 7l10 10M18 6l-2 11M6 7l12-1M5.5 17.5L16 17"
      stroke="currentColor"
      strokeWidth="1.1"
      opacity=".45"
    />
  </svg>
);

/**
 * Probes /api/session/me to decide whether the user is authenticated. While
 * checking we render nothing; on auth fail we render the sign-in card; on
 * success we render the wrapped app.
 *
 * The token is required on loopback too; `rig start` opens the map through
 * /auth?t=… so the cookie is already set. Under `rig serve --no-auth` the
 * probe always succeeds and the gate passes straight through.
 */
export function TokenGate({ children }: TokenGateProps): JSX.Element {
  const [state, setState] = useState<State>('checking');
  const [pasteValue, setPasteValue] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = async (): Promise<void> => {
    try {
      const res = await fetch('/api/session/me', { credentials: 'include' });
      // Auth-off servers return 404 (the route only registers when authOn).
      // Treat both 200 and 404 as "we're in".
      setState(res.ok || res.status === 404 ? 'authed' : 'unauthed');
    } catch {
      setState('offline');
    }
  };

  useEffect(() => {
    void probe();
  }, []);

  if (state === 'checking') return <></>;
  if (state === 'authed') return <>{children}</>;

  const submitPaste = async (): Promise<void> => {
    const t = pasteValue.trim();
    if (!t) {
      setPasteErr('paste the token first');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/auth?t=${encodeURIComponent(t)}`, {
        credentials: 'include',
        redirect: 'manual',
      });
      // With redirect: 'manual' the 302 that sets the cookie surfaces as an
      // opaque redirect (status 0, ok false), not as a 302.
      if (res.type === 'opaqueredirect' || res.ok) {
        location.reload();
        return;
      }
      setPasteErr('invalid token');
    } catch {
      setPasteErr('the map server is not reachable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <div className="gate-card float">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BrandMark />
          <span className="eyebrow">Local map</span>
        </div>
        <h1 style={{ marginTop: 14 }}>Rig — sign in</h1>
        {state === 'offline' ? (
          <>
            <p className="lede">
              The map server isn't answering. Start it again with <code>rig start</code>, then
              retry.
            </p>
            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => void probe()}
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <p className="lede">
              This map reads and edits your project's graph, so it asks for the session token, even
              on localhost.
            </p>
            <div className="gate-step">
              <span className="n">1</span>
              <div>
                <h3>Ask your agent</h3>
                <p>
                  In Claude Code, Cursor or Codex, say <q>open the rig map</q>. It calls{' '}
                  <code>rig_session_token</code> and hands you a one-click sign-in link.
                </p>
              </div>
            </div>
            <div className="gate-step">
              <span className="n">2</span>
              <div>
                <h3>Or paste the token</h3>
                <p>
                  Run <code>cat .rig/.runtime</code> in your project. Deleting that file signs
                  everyone out.
                </p>
                <form
                  className="gate-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitPaste();
                  }}
                >
                  <div style={{ position: 'relative', flex: 1 }}>
                    <KeyRound
                      size={14}
                      aria-hidden
                      style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }}
                    />
                    <input
                      className="input mono"
                      style={{ paddingLeft: 30 }}
                      value={pasteValue}
                      onChange={(e) => {
                        setPasteValue(e.target.value);
                        setPasteErr(null);
                      }}
                      placeholder="paste token here"
                      aria-label="Session token"
                      aria-invalid={pasteErr ? true : undefined}
                      aria-describedby={pasteErr ? 'token-err' : undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    sign in
                  </button>
                </form>
                {pasteErr && (
                  <div id="token-err" className="field-error" role="alert">
                    {pasteErr}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
