'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';

const MIN_LENGTH = 12;

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();

    if (newPassword !== confirmation) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await api.changePassword(currentPassword, newPassword);
      router.replace('/');
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That current password is not right.'
          : 'Could not reach the server. Try again.',
      );
      setBusy(false);
    }
  };

  return (
    <main className="flex h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Set a new password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This account still uses the password it was created with. Choose your own to continue.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="current">Current password</Label>
          <Input
            id="current"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="next">New password</Label>
          <Input
            id="next"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_LENGTH}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            At least {MIN_LENGTH} characters. Changing it signs out every other session.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">New password again</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving' : 'Save password'}
        </Button>
      </form>
    </main>
  );
}
