import { useState } from 'react';
import type { ProfileDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';

export function ProfilePicker({ onOpen }: { onOpen: (p: ProfileDTO) => void }) {
  const rpc = useRpc();
  const profiles = useQuery('profiles.list', {}, ['profiles']);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const open = async (id: string) => {
    try {
      onOpen(await rpc.call('profiles.open', { profileId: id }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="screen center">
      <h1>Who is learning?</h1>
      <ul className="profiles">
        {profiles.data?.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => void open(p.id)}>
              <span className="avatar" aria-hidden>{p.displayName.slice(0, 1).toUpperCase()}</span>
              {p.displayName}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="new-profile"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const p = await rpc.call('profiles.create', { displayName: name });
            setName('');
            await open(p.id);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>
          New profile
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={60} />
        </label>
        <button type="submit" disabled={name.trim() === ''}>Create</button>
      </form>
      <p className="hint">
        Each profile is a separate folder on this computer. People who share an OS account can read each other's files unless profiles are encrypted.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
