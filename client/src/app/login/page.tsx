'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const session = await api.login(username, password);
      router.replace(session.mustChangePassword ? '/change-password' : '/');
    } catch (caught) {
      // One message for every failure: naming which half was wrong tells an
      // attacker which usernames exist.
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That username and password do not match.'
          : 'Could not reach the server. Try again.',
      );
      setBusy(false);
    }
  };

  return (
    <main className="flex h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">kubitor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to see what your cluster is doing.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
