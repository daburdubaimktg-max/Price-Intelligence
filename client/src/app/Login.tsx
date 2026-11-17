import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, LockKeyhole } from 'lucide-react';
import { apiGet } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { Button, Field, Input, Notice } from '@/components/ui/primitives.tsx';

interface AuthInfo {
  app: string;
  version: string;
  demo_login: { accounts: Array<{ email: string; role: string }>; password: string } | null;
}

/** Decorative ledger: hairline rules with a price line running across them. */
function LedgerArt() {
  return (
    <svg viewBox="0 0 520 360" className="h-auto w-full max-w-lg" aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <line key={i} x1="0" x2="520" y1={28 + i * 38} y2={28 + i * 38} stroke="#ffffff" strokeOpacity={i === 8 ? 0.28 : 0.1} strokeWidth="1" />
      ))}
      {Array.from({ length: 6 }, (_, i) => (
        <line key={i} x1={40 + i * 88} x2={40 + i * 88} y1="28" y2="332" stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1" />
      ))}
      <path d="M0 250 L60 244 L100 244 L100 208 L170 208 L170 232 L240 232 L240 176 L300 176 L300 196 L370 196 L370 132 L440 132 L440 108 L520 108" fill="none" stroke="#eb6834" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M0 278 L70 278 L70 262 L150 262 L150 270 L220 270 L220 240 L310 240 L310 222 L390 222 L390 204 L470 204 L470 186 L520 186" fill="none" stroke="#7fb2f0" strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx="520" cy="108" r="5" fill="#eb6834" stroke="#14244a" strokeWidth="2" />
      <circle cx="520" cy="186" r="5" fill="#7fb2f0" stroke="#14244a" strokeWidth="2" />
    </svg>
  );
}

export function Login() {
  const { login } = useAuth();
  const info = useQuery({ queryKey: ['auth', 'info'], queryFn: () => apiGet<AuthInfo>('/auth/info'), staleTime: 60_000 });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  const demo = info.data?.demo_login ?? null;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-navy px-12 py-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-white/10">
            <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
              <path d="M6 22l6-6.5 4.2 3.6L26 9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="26" cy="9" r="2.9" fill="#eb6834" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Price Intelligence OS</span>
        </div>
        <div className="animate-in">
          <LedgerArt />
          <h1 className="mt-8 max-w-md text-[30px] leading-[1.15] font-semibold tracking-[-0.02em]">
            Every price, <span className="font-serif font-medium italic">on the record.</span>
          </h1>
          <p className="mt-3 max-w-md text-[14px] leading-6 text-white/70">
            An always-on ledger of your own and your competitors' shelf prices across retailers and markets. Observations are appended, never overwritten.
          </p>
        </div>
        <p className="text-[12px] text-white/45">Competitive pricing intelligence for FMCG teams</p>
      </section>

      <section className="flex items-center justify-center px-5 py-10">
        <div className="animate-in w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-navy">
              <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
                <path d="M6 22l6-6.5 4.2 3.6L26 9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="26" cy="9" r="2.9" fill="#eb6834" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold text-ink">Price Intelligence OS</span>
          </div>
          <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ink">Sign in</h2>
          <p className="mt-1 mb-6 text-[13px] text-ink-3">Use your work e-mail and password.</p>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error ? (
              <Notice tone="crit" icon={LockKeyhole}>
                {error}
              </Notice>
            ) : null}
            <Field label="E-mail">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
              Sign in
            </Button>
          </form>

          {demo ? (
            <Notice tone="demo" icon={FlaskConical} className="mt-6" title="Demo workspace">
              <p className="mb-2">
                These demo accounts use the password <code className="mono rounded bg-white/70 px-1 py-0.5 whitespace-nowrap text-ink">{demo.password}</code>. Change them before using real data.
              </p>
              <ul className="flex flex-col gap-1.5">
                {demo.accounts.map((a) => (
                  <li key={a.email} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-ink">{a.role}</span> · {a.email}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEmail(a.email);
                        setPassword(demo.password);
                      }}
                    >
                      Use
                    </Button>
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </div>
      </section>
    </div>
  );
}
