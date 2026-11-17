/** Users and roles. Passwords are never shown, except a generated temporary password — exactly once. */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { fmtNumber, fmtRelative } from '@/lib/format.ts';
import { ConfirmDialog, Dialog, Menu, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, LoadingBlock, Notice, Select, Switch } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { MarketTime } from '@/components/domain/domain.tsx';
import { Ellipsis } from 'lucide-react';
import { ROLE_KEYS, type RoleKey } from '@shared/constants.ts';
import type { CreateUserResponse, ResetPasswordResponse, RoleRow, UserRow } from '@shared/api/admin.ts';
import { CopyBox, errorText, useRefresh } from './shared.tsx';

const ROLE_FALLBACK: Record<RoleKey, string> = { admin: 'Administrator', analyst: 'Analyst', viewer: 'Viewer' };

function UserDialog({ user, roles, open, onClose, onCreated }: { user: UserRow | null; roles: RoleRow[]; open: boolean; onClose: () => void; onCreated: (result: CreateUserResponse) => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const { user: me } = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<RoleKey>('viewer');
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEmail(user?.email ?? '');
    setName(user?.name ?? '');
    setRole(user?.role ?? 'viewer');
    setActive(user?.is_active ?? true);
    setPassword('');
  }, [open, user]);

  const isSelf = !!user && user.id === me?.id;
  const roleInfo = roles.find((r) => r.key === role);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (user) {
        const body: { name?: string; role?: RoleKey; is_active?: boolean } = {};
        if (name.trim() !== user.name) body.name = name.trim();
        if (role !== user.role) body.role = role;
        if (active !== user.is_active) body.is_active = active;
        if (Object.keys(body).length) await apiPatch(`/users/${user.id}`, body);
        toast.success('User updated', user.email);
      } else {
        const result = await apiPost<CreateUserResponse>('/users', { email: email.trim(), name: name.trim(), role, password: password || null });
        onCreated(result);
      }
      await refresh(['users'], ['roles']);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={user ? 'Edit user' : 'Add user'}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="user-form" loading={busy}>
            {user ? 'Save changes' : 'Add user'}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <Field label="E-mail" required hint={user ? 'The sign-in e-mail cannot be changed.' : undefined}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!user} required maxLength={200} placeholder="name@company.com" />
        </Field>
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Role" hint={roleInfo?.description}>
          <Select value={role} onChange={(e) => setRole(e.target.value as RoleKey)} disabled={isSelf}>
            {ROLE_KEYS.map((key) => (
              <option key={key} value={key}>
                {roles.find((r) => r.key === key)?.name ?? ROLE_FALLBACK[key]}
              </option>
            ))}
          </Select>
        </Field>
        {user ? (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-3.5 py-3">
            <div>
              <div className="text-[13px] font-medium text-ink">Account active</div>
              <div className="text-[12px] text-ink-3">An inactive account cannot sign in. Its sessions end immediately.</div>
            </div>
            <Switch checked={active} onChange={setActive} label="Account active" disabled={isSelf} />
          </div>
        ) : (
          <Field label="Password (optional)" hint="Leave empty to generate a temporary password, shown once. Either way the person chooses their own at first sign-in.">
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} />
          </Field>
        )}
        {isSelf ? <Notice tone="info">You cannot change your own role or deactivate your own account. Ask another administrator.</Notice> : null}
      </form>
    </Dialog>
  );
}

export function UsersTab() {
  const toast = useToast();
  const refresh = useRefresh();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ rows: UserRow[] }>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => apiGet<{ rows: RoleRow[] }>('/roles') });
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ title: string; email: string; password: string | null; note: string } | null>(null);

  async function setActive(user: UserRow, isActive: boolean) {
    try {
      await apiPatch(`/users/${user.id}`, { is_active: isActive });
      toast.success(isActive ? 'Account reactivated' : 'Account deactivated', user.email);
      await refresh(['users'], ['roles']);
    } catch (err) {
      toast.error('The account was not changed', errorText(err));
    }
  }

  async function resetPassword() {
    if (!resetting) return;
    setBusy(true);
    try {
      const result = await apiPost<ResetPasswordResponse>(`/users/${resetting.id}/reset-password`);
      setSecret({
        title: 'Temporary password',
        email: result.user.email,
        password: result.temporary_password,
        note: 'Existing sessions were signed out. The person must choose a new password at the next sign-in.',
      });
      setResetting(null);
      await refresh(['users']);
    } catch (err) {
      toast.error('The password was not reset', errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const roleRows = roles.data?.rows ?? [];
  const columns: Array<Column<UserRow>> = [
    {
      key: 'user',
      header: 'User',
      cell: (u) => (
        <div className="min-w-[11rem]">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-ink">{u.name}</span>
            {u.id === me?.id ? <Badge tone="accent">You</Badge> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">{u.email}</div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', cell: (u) => <Badge tone={u.role === 'admin' ? 'accent' : 'neutral'}>{u.role_name}</Badge> },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={u.is_active ? 'good' : 'outline'}>{u.is_active ? 'Active' : 'Inactive'}</Badge>
          {u.must_change_password ? <Badge tone="warn">Must change password</Badge> : null}
          {u.uses_default_password ? <Badge tone="demo">Demo password</Badge> : null}
          {u.locked ? <Badge tone="crit">Locked</Badge> : null}
        </span>
      ),
    },
    { key: 'last', header: 'Last sign-in', hideBelow: 'md', nowrap: true, cell: (u) => (u.last_login_at ? <MarketTime iso={u.last_login_at} relative /> : <span className="text-ink-4">Never</span>) },
    { key: 'sessions', header: 'Sessions', align: 'right', hideBelow: 'lg', cell: (u) => fmtNumber(u.active_sessions) },
    { key: 'created', header: 'Added', hideBelow: 'xl', nowrap: true, cell: (u) => <span className="text-ink-3">{fmtRelative(u.created_at)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '52px',
      cell: (u) => (
        <Menu
          trigger={<IconButton icon={Ellipsis} label={`Actions for ${u.name}`} size="sm" />}
          items={[
            {
              label: 'Edit',
              icon: Pencil,
              onSelect: () => {
                setEditing(u);
                setDialogOpen(true);
              },
            },
            { label: 'Reset password', icon: KeyRound, onSelect: () => setResetting(u), disabled: u.id === me?.id },
            u.is_active
              ? { label: 'Deactivate', icon: UserX, danger: true, separatorBefore: true, disabled: u.id === me?.id, onSelect: () => void setActive(u, false) }
              : { label: 'Reactivate', icon: UserCheck, separatorBefore: true, onSelect: () => void setActive(u, true) },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Users"
          subtitle="Everyone who can sign in. Access is decided by the role."
          actions={
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              Add user
            </Button>
          }
        />
        {users.isError ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={users.data?.rows}
            rowKey={(u) => u.id}
            loading={users.isPending}
            refetching={users.isFetching && !users.isPending}
            empty={<EmptyState title="No users" />}
          />
        )}
      </Card>

      <Card>
        <CardHeader title="Roles" subtitle="What each role may do. Roles are fixed; a user has exactly one." />
        {roles.isPending ? (
          <LoadingBlock />
        ) : roles.isError ? (
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        ) : (
          <ul className="grid divide-y divide-line lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            {roleRows.map((r) => (
              <li key={r.key} className="min-w-0 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{r.name}</span>
                  <span className="num text-[12px] text-ink-3">
                    {fmtNumber(r.user_count)} active user{r.user_count === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="mt-0.5 text-[12.5px] leading-5 text-ink-3">{r.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.permissions.map((p) => (
                    <span key={p} className="mono rounded bg-wash px-1.5 py-0.5 !text-[11px] text-ink-2">
                      {p}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <UserDialog
        user={editing}
        roles={roleRows}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(result) =>
          setSecret({
            title: 'User added',
            email: result.user.email,
            password: result.generated_password,
            note: result.generated_password
              ? 'This temporary password is shown only now. The person must choose a new password at first sign-in.'
              : 'The account uses the password you entered. The person is asked to choose their own at first sign-in.',
          })
        }
      />
      <ConfirmDialog open={resetting !== null} onClose={() => setResetting(null)} onConfirm={() => void resetPassword()} title="Reset this password?" confirmLabel="Reset password" loading={busy}>
        <p>
          A temporary password is generated for <strong className="font-semibold text-ink">{resetting?.email}</strong> and shown once. All of their sessions are signed out,
          and they must choose a new password at the next sign-in.
        </p>
      </ConfirmDialog>
      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        title={secret?.title ?? ''}
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-2">
            Account <strong className="font-semibold text-ink">{secret?.email}</strong>
          </p>
          {secret?.password ? <CopyBox label="Temporary password — shown once" value={secret.password} /> : null}
          <Notice tone={secret?.password ? 'warn' : 'info'}>{secret?.note}</Notice>
        </div>
      </Dialog>
    </div>
  );
}
