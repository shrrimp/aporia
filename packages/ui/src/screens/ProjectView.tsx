import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lesson as lessonSchema, normalizeLesson } from '@app/catalog';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { LessonView } from '../lesson/LessonView.tsx';
import { LessonActionsContext, type LessonActions } from '../lesson/actions.tsx';
import { PixelMark, Wordmark } from '../PixelMark.tsx';
import { Conversation, type AskRequest } from './Conversation.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { MePanel } from './MePanel.tsx';

type Margin = 'none' | 'tutor' | 'history' | 'me';
type View = 'session' | 'lesson';

const INTERVIEW = 'Interview me briefly to find out what I already know for this project, then draft the first lesson.';

/**
 * The workspace: contents on the left; a page in the middle, either a lesson or a session (the
 * interview, planning: the heavy interactions get the whole page); and a margin with the quick
 * tutor chat, History and You.
 */
export function ProjectView({ project, profile, onProfile, onBack }: { project: ProjectDTO; profile: ProfileDTO; onProfile: (p: ProfileDTO) => void; onBack: () => void }) {
  const rpc = useRpc();
  const lessons = useQuery('lessons.list', { projectId: project.id }, ['lessons']);
  const [lessonId, setLessonId] = useState<string>();
  const current = lessonId ?? lessons.data?.[0]?.id;
  const currentTitle = lessons.data?.find((l) => l.id === current)?.title;
  const lessonDoc = useQuery('lessons.get', current ? { projectId: project.id, lessonId: current } : null, ['lessons']);
  const parsed = useMemo(() => (lessonDoc.data ? lessonSchema.safeParse(normalizeLesson(lessonDoc.data)) : undefined), [lessonDoc.data]);
  const [view, setView] = useState<View>();
  // Until the learner chooses, a project without lessons opens on the session page.
  const shown: View = view ?? (lessons.data && lessons.data.length === 0 ? 'session' : 'lesson');
  const [margin, setMargin] = useState<Margin>('none');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatReq, setChatReq] = useState<AskRequest>();
  const [sessionReq, setSessionReq] = useState<AskRequest>();
  const [chip, setChip] = useState<{ x: number; y: number; text: string; anchor?: string }>();
  const lessonRef = useRef<HTMLDivElement>(null);
  const history = useQuery('history.list', { filter: {} }, ['history']);
  const pending = history.data?.filter((h) => h.status === 'proposed').length ?? 0;

  // Quick questions from the lesson go to the chat in the margin.
  const ask = useCallback(
    (question: string, opts?: { selection?: string; anchor?: string }) =>
      setChatReq({ question, ...(opts?.selection ? { selection: opts.selection } : {}), ...(opts?.anchor ? { anchor: opts.anchor } : {}), nonce: Date.now() }),
    [],
  );
  const startSession = useCallback((question: string) => setSessionReq({ question, nonce: Date.now() }), []);
  const showChat = useCallback(() => setMargin('tutor'), []);
  const showSession = useCallback(() => setView('session'), []);

  const actions: LessonActions = useMemo(
    () => ({
      recordAnswer: (a) => {
        if (!current) return;
        void rpc.call('answers.record', {
          projectId: project.id,
          lessonId: current,
          itemId: a.itemId,
          kcs: [...a.kcs],
          difficulty: a.difficulty,
          evidenceType: a.evidenceType,
          outcome: a.outcome,
          transfer: a.transfer,
          ...(a.confidence ? { confidence: a.confidence } : {}),
        });
      },
      ask,
    }),
    [rpc, project.id, current, ask],
  );

  // Select any text in the lesson → an "Ask about this" chip.
  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || text === '' || !lessonRef.current?.contains(sel.anchorNode)) {
      setChip(undefined);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const anchorEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest('[data-anchor]');
    const anchor = anchorEl?.getAttribute('data-anchor') ?? undefined;
    setChip({ x: rect.left + rect.width / 2, y: rect.top, text: text.slice(0, 4000), ...(anchor ? { anchor } : {}) });
  }, []);
  useEffect(() => {
    setChip(undefined);
  }, [current, shown]);

  const intro = (
    <section className="intro">
      <p className="meta">{lessons.data?.length === 0 ? 'New project' : 'Session'}</p>
      <h1>{project.title}</h1>
      <p className="goal">{project.goal}</p>
      {lessons.data?.length === 0 ? (
        <>
          <p>
            Before the first lesson, your tutor asks a few questions to find out what you already know, so the lesson starts at the right level.
            Not knowing is fine: that is exactly what it needs to find out.
          </p>
          <button type="button" className="primary" onClick={() => startSession(INTERVIEW)}>
            Start the interview
          </button>
        </>
      ) : (
        <>
          <p>Work through bigger things with your tutor here: what to learn next, a new lesson, or a part that is not clicking.</p>
          <button type="button" onClick={() => startSession('Based on my progress so far, what should I learn next? Propose the next lesson and draft it.')}>
            Plan the next lesson
          </button>
        </>
      )}
    </section>
  );

  return (
    <div className="project">
      <header className="bar">
        <Wordmark height={18} working={sessionBusy || chatBusy} />
        <span className="crumb-sep" aria-hidden>/</span>
        <button type="button" className="text" onClick={onBack}>
          Projects
        </button>
        <span className="crumb-sep" aria-hidden>/</span>
        <span className="crumb">{project.title}</span>
        <nav className="margin-tabs" aria-label="Margin">
          {(
            [
              ['tutor', 'Tutor'],
              ['history', 'History'],
              ['me', 'You'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" className="tab" aria-pressed={margin === key} onClick={() => setMargin(margin === key ? 'none' : key)}>
              {key === 'tutor' && <PixelMark working={chatBusy} size={12} />}
              {label}
              {key === 'history' && pending > 0 && <span className="count" aria-label={`${pending} pending`}> {pending}</span>}
            </button>
          ))}
        </nav>
      </header>
      <div className={`workspace ${margin === 'none' ? '' : 'with-margin'}`}>
        <nav className="toc" aria-label="Contents">
          <button type="button" className="toc-tutor" aria-current={shown === 'session'} onClick={() => setView('session')}>
            <PixelMark working={sessionBusy} size={16} />
            {lessons.data?.length === 0 ? 'Interview' : 'Sessions'}
            {sessionBusy && <span className="status">working</span>}
          </button>
          <h2>Lessons</h2>
          <ol>
            {lessons.data?.map((l, i) => (
              <li key={l.id}>
                <button
                  type="button"
                  aria-current={shown === 'lesson' && l.id === current}
                  onClick={() => {
                    setLessonId(l.id);
                    setView('lesson');
                  }}
                >
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  {l.title}
                </button>
              </li>
            ))}
          </ol>
          {lessons.data?.length === 0 && <p className="quiet">Lessons appear here once your tutor has written them.</p>}
        </nav>
        <div className="page">
          <div hidden={shown !== 'session'}>
            <Conversation
              projectId={project.id}
              lessonId={current}
              request={sessionReq}
              intro={intro}
              backTo={current ? currentTitle : undefined}
              onBack={() => setView('lesson')}
              onActivity={showSession}
              onBusy={setSessionBusy}
              proposals={margin !== 'tutor'}
            />
          </div>
          <div hidden={shown !== 'lesson'} ref={lessonRef} onMouseUp={onMouseUp}>
            <LessonActionsContext.Provider value={actions}>
              {parsed?.success && <LessonView lesson={parsed.data} />}
              {parsed && !parsed.success && <p className="error">This lesson could not be read: {parsed.error.message}</p>}
            </LessonActionsContext.Provider>
          </div>
          {chip && (
            <button
              type="button"
              className="ask-chip"
              style={{ left: chip.x, top: chip.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                ask('', { selection: chip.text, ...(chip.anchor ? { anchor: chip.anchor } : {}) });
                setChip(undefined);
              }}
            >
              Ask about this
            </button>
          )}
        </div>
        <aside className="margin" hidden={margin === 'none'}>
          <div hidden={margin !== 'tutor'}>
            <Conversation variant="chat" projectId={project.id} lessonId={current} request={chatReq} onActivity={showChat} onBusy={setChatBusy} />
          </div>
          {margin === 'history' && <HistoryPanel />}
          {margin === 'me' && <MePanel profile={profile} onSettings={onProfile} />}
        </aside>
      </div>
    </div>
  );
}
