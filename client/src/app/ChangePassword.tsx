import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { apiPost } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { Dialog, useToast } from '@/components/ui/overlays.tsx';
import { Button, Field, Input, Notice } from '@/components/ui/primitives.tsx';

function PasswordForm({ onDone, formId }: { onDone: () => void; formId: string }) {
  const { refresh } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    try {
      await apiPost('/auth/change-password', { current_password: current, new_password: next });
      await refresh();
      toast.success('Password changed');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id={formId} onSubmit={submit} className="flex flex-col gap-3.5">
      {error ? <Notice tone="crit">{error}</Notice> : null}
      <Field label="Current password" required>
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" hint="At least 10 characters, with letters and numbers." required>
        <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} required />
      </Field>
      <Field label="Confirm new password" required>
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} required />
      </Field>
      <button type="submit" hidden disabled={busy} />
    </form>
  );
}

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change password"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="change-password-form">
            Change password
          </Button>
        </>
      }
    >
      <PasswordForm formId="change-password-form" onDone={onClose} />
    </Dialog>
  );
}

/** Full-screen step shown when an account must choose a new password before continuing. */
export function ForcedPasswordChange() {
  const { logout, user } = useAuth();
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="sheet animate-in w-full max-w-md p-6">
        <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <KeyRound className="size-4" aria-hidden />
        </span>
        <h1 className="text-[18px] leading-6 font-semibold text-ink">Choose a new password</h1>
        <p className="mt-1 mb-5 text-[13px] leading-5 text-ink-3">
          {user?.email} was given a temporary password. Set your own to continue.
        </p>
        <PasswordForm formId="forced-password-form" onDone={() => undefined} />
        <div className="mt-5 flex items-center justify-between">
          <button type="button" className="link text-[13px]" onClick={() => void logout()}>
            Sign out
          </button>
          <Button variant="primary" type="submit" form="forced-password-form">
            Save and continue
          </Button>
        </div>
      </div>
    </div>
  );
}
