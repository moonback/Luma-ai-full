import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { ProfileLibrary, resolveFixture, type ResolvedFixture } from '../../core/fixtures/profiles';

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="row wrap">{children}</div>
    </div>
  );
}

export function Panel({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          <div className="grow" />
          {actions}
        </div>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, className, title }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; className?: string; title?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const invalid = text.trim() === '' || !Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max);
  return (
    <input
      className={`input mono ${invalid ? 'invalid' : ''} ${className ?? ''}`}
      value={text}
      title={title ?? (min !== undefined && max !== undefined ? `${min} – ${max}` : undefined)}
      inputMode="decimal"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => (invalid ? setText(String(value)) : n !== value && onChange(n))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(String(value));
      }}
      step={step}
    />
  );
}

export function Modal({ title, children, footer, onClose, wide }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head row between">
          {title}
          <button className="btn ghost sm icon" onClick={onClose} title="Fermer (Échap)"><X size={14} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmHost() {
  const c = useStore((s) => s.confirm);
  if (!c) return null;
  return (
    <Modal
      title={c.title}
      onClose={() => c.resolve(false)}
      footer={
        <>
          <button className="btn" onClick={() => c.resolve(false)}>Annuler</button>
          <button className={`btn ${c.danger ? 'danger solid' : 'primary'}`} autoFocus onClick={() => c.resolve(true)}>{c.confirmLabel}</button>
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{c.message}</p>
    </Modal>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export const pct = (v: number | undefined) => (v === undefined ? '–' : `${Math.round(v * 100)}%`);
export const dmx = (v: number | undefined) => (v === undefined ? '–' : String(Math.round(v * 255)));

/** Resolved fixtures for the current project (profile + mode), memoized on the project revision. */
export function useResolved(): { lib: ProfileLibrary; fixtures: ResolvedFixture[]; byId: Map<string, ResolvedFixture> } {
  const project = useStore((s) => s.project?.project);
  return useMemo(() => {
    const lib = new ProfileLibrary(project?.profiles ?? []);
    const fixtures = (project?.patch ?? []).map((f) => resolveFixture(lib, f)).filter((x): x is ResolvedFixture => !!x);
    return { lib, fixtures, byId: new Map(fixtures.map((f) => [f.fixture.id, f])) };
  }, [project]);
}

/** Runs `fn` at most every `ms` while values keep coming (fader drags). The last value is always sent. */
export function useThrottled<A extends unknown[]>(fn: (...a: A) => void, ms = 30) {
  const last = useRef(0);
  const pending = useRef<A | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (...a: A) => {
    const now = Date.now();
    if (now - last.current >= ms) {
      last.current = now;
      fn(...a);
    } else {
      pending.current = a;
      if (!timer.current)
        timer.current = setTimeout(() => {
          timer.current = null;
          last.current = Date.now();
          if (pending.current) fn(...pending.current);
        }, ms);
    }
  };
}
