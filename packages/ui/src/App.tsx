import { useState } from 'react';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useStatus } from './hooks.tsx';
import { ProfilePicker } from './screens/ProfilePicker.tsx';
import { Home } from './screens/Home.tsx';
import { ProjectView } from './screens/ProjectView.tsx';

function Nav({ name, children }: { name: string | undefined; children: React.ReactNode }) {
  return (
    <header className="nav">
      <div className="nav-pill">
        <span className="logo" aria-hidden>a</span>
        <span className="nav-name">{name}</span>
        <span className="nav-rule" aria-hidden />
        {children}
      </div>
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
      {status !== 'open' && <div className="offline" role="status">{status === 'connecting' ? 'Connecting…' : 'Disconnected. Reconnecting…'}</div>}
      {!profile ? (
        <>
          <Nav name={info.data?.name}>
            <span className="nav-tagline">{info.data?.tagline}</span>
          </Nav>
          <ProfilePicker onOpen={setProfile} />
        </>
      ) : !project ? (
        <>
          <Nav name={info.data?.name}>
            <button type="button" className="nav-profile" onClick={() => setProfile(undefined)}>
              <span className="avatar small" aria-hidden>{profile.displayName.slice(0, 1).toUpperCase()}</span>
              {profile.displayName} · switch
            </button>
          </Nav>
          <Home onOpen={setProject} />
        </>
      ) : (
        <ProjectView project={project} profile={profile} onProfile={setProfile} onBack={() => setProject(undefined)} />
      )}
    </div>
  );
}
