import { useCallback, useEffect, useState } from 'react';
import type { Params, Place, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useRpc, useStatus } from './hooks.tsx';
import { ProfilePicker } from './screens/ProfilePicker.tsx';
import { Home } from './screens/Home.tsx';
import { ProjectView } from './screens/ProjectView.tsx';
import { MathField } from './MathField.tsx';
import { Wordmark } from './PixelMark.tsx';
import { BrainView } from './brain/BrainView.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

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
  const rpc = useRpc();
  const status = useStatus();
  const info = useQuery('app.info', {});
  const [profile, setProfileState] = useState<ProfileDTO>();
  const [project, setProjectState] = useState<ProjectDTO>();
  const [brain, setBrainState] = useState(false);
  // Where the learner was before the app closed (or crashed): restored once, at start.
  const [restoring, setRestoring] = useState(true);
  const [initial, setInitial] = useState<Place>();
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const place = await rpc.call('place.get', {});
        if (!place.profileId) return;
        const opened = await rpc.call('profiles.open', { profileId: place.profileId });
        const found = place.projectId ? (await rpc.call('projects.list', {})).find((p) => p.id === place.projectId) : undefined;
        if (!live) return;
        setProfileState(opened);
        setBrainState(place.brain === true);
        setInitial(place);
        setProjectState(found);
      } catch {
        // The profile or project is gone, or locked by another window: start from the picker.
      } finally {
        if (live) setRestoring(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [rpc]);
  const remember = useCallback((change: Params<'place.set'>) => void rpc.call('place.set', change).catch(() => undefined), [rpc]);
  const setProfile = useCallback(
    (p: ProfileDTO | undefined) => {
      setProfileState(p);
      remember({ profileId: p?.id ?? null });
    },
    [remember],
  );
  const setProject = useCallback(
    (p: ProjectDTO | undefined) => {
      setProjectState(p);
      remember({ projectId: p?.id ?? null, view: null, lessonId: null, margin: null, editor: null, file: null });
    },
    [remember],
  );
  const setBrain = useCallback(
    (on: boolean) => {
      setBrainState(on);
      remember({ brain: on || null });
    },
    [remember],
  );
  if (restoring) return <div className="app" aria-busy="true" />;
  return (
    <div className="app">
      <MathField />
      {status !== 'open' && <div className="offline" role="status">{status === 'connecting' ? 'Connecting…' : 'Disconnected. Reconnecting…'}</div>}
      {!profile ? (
        <>
          <Header name={info.data?.name} />
          <ProfilePicker onOpen={setProfile} />
        </>
      ) : brain ? (
        <>
          <Header name={info.data?.name} />
          <ErrorBoundary area="your brain map">
            <BrainView onBack={() => setBrain(false)} />
          </ErrorBoundary>
        </>
      ) : !project ? (
        <>
          <Header name={info.data?.name}>
            <button type="button" className="text" onClick={() => setBrain(true)}>
              Your brain
            </button>
            <button type="button" className="text" onClick={() => setProfile(undefined)}>
              {profile.displayName} · switch
            </button>
          </Header>
          <Home onOpen={setProject} />
        </>
      ) : (
        <ProjectView
          project={project}
          profile={profile}
          {...(initial?.projectId === project.id ? { initial } : {})}
          onPlace={remember}
          onProfile={setProfile}
          onBack={() => setProject(undefined)}
          onBrain={() => setBrain(true)}
        />
      )}
    </div>
  );
}
