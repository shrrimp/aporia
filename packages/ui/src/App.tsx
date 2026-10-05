import { useState } from 'react';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useStatus } from './hooks.tsx';
import { ProfilePicker } from './screens/ProfilePicker.tsx';
import { Home } from './screens/Home.tsx';
import { ProjectView } from './screens/ProjectView.tsx';
import { MathField } from './MathField.tsx';
import { Wordmark } from './PixelMark.tsx';

function Header({ name, children }: { name: string | undefined; children?: React.ReactNode }) {
  return (
    <header className="bar">
      <Wordmark height={27} />
      <span className="sr-only">{name}</span>
      <span className="bar-fill" />
      {children}
    </header>
  );
}

export function App() {
  const status = useStatus();
  const info = useQuery('app.info', {});
  const [profile, setProfile] = useState<ProfileDTO>();
  const [project, setProject] = useState<ProjectDTO>();
  return (
    <div className="app">
      <MathField />
      {status !== 'open' && <div className="offline" role="status">{status === 'connecting' ? 'Connecting…' : 'Disconnected. Reconnecting…'}</div>}
      {!profile ? (
        <>
          <Header name={info.data?.name} />
          <ProfilePicker onOpen={setProfile} />
        </>
      ) : !project ? (
        <>
          <Header name={info.data?.name}>
            <button type="button" className="text" onClick={() => setProfile(undefined)}>
              {profile.displayName} · switch
            </button>
          </Header>
          <Home onOpen={setProject} />
        </>
      ) : (
        <ProjectView project={project} profile={profile} onProfile={setProfile} onBack={() => setProject(undefined)} />
      )}
    </div>
  );
}
