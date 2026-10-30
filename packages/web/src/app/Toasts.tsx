// SPDX-License-Identifier: Apache-2.0
import { AlertTriangle, Check, Info, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

export type Tone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastInput {
  tone?: Tone;
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
  // ms; 0 keeps it until dismissed.
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const Ctx = createContext<(t: ToastInput) => void>(() => {});

export const useToast = (): ((t: ToastInput) => void) => useContext(Ctx);

const ICON = { info: Info, success: Check, warning: AlertTriangle, danger: XCircle } as const;

// A polite live region: every action ends in a toast or an inline change.
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      const ms = t.duration ?? (t.action ? 7000 : 4000);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.tone ?? 'info'];
          return (
            <div key={t.id} className="toast float" data-tone={t.tone ?? 'info'}>
              <Icon aria-hidden />
              <div className="grow">
                <div className="truncate" style={{ fontWeight: 550 }}>
                  {t.title}
                </div>
                {t.detail && (
                  <div className="truncate quiet" style={{ fontSize: 'var(--t-xs)' }}>
                    {t.detail}
                  </div>
                )}
              </div>
              {t.action && (
                <button
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    t.action!.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                className="btn btn-sm btn-ghost icon-btn"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
