import { useState } from 'react';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useStatus } from './hooks.tsx';
import { ProfilePicker } from './screens/ProfilePicker.tsx';
import { Home } from './screens/Home.tsx';
import { ProjectView } from './screens/ProjectView.tsx';

export function App() {
  const status = useStatus();
  const info = useQuery('app.info', {});
  const [profile, setProfile] = useState<ProfileDTO>();
  const [project, setProject] = useState<ProjectDTO>();
  return (
    <div className="app">
      {status !== 'open' && <div className="offline" role="status">{status === 'connecting' ? 'Connecting…' : 'Disconnected. Reconnecting…'}</div>}
      {!profile ? (
        <>
          <header className="brand">
            <span className="name">{info.data?.name}</span>
            <span className="tagline">{info.data?.tagline}</span>
          </header>
          <ProfilePicker onOpen={setProfile} />
        </>
      ) : !project ? (
        <>
          <header className="brand">
            <span className="name">{info.data?.name}</span>
            <button type="button" className="switch-profile" onClick={() => setProfile(undefined)}>{profile.displayName} · switch</button>
          </header>
          <Home onOpen={setProject} />
        </>
      ) : (
        <ProjectView project={project} profile={profile} onProfile={setProfile} onBack={() => setProject(undefined)} />
      )}
    </div>
  );
}
