import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lesson as lessonSchema, normalizeLesson, openTaskShapes, solutionFor } from '@app/catalog';
import { LessonLinkContext, type CodeGate } from '../lesson/Markdown.tsx';
import type { Params, Place, ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { LessonView } from '../lesson/LessonView.tsx';
import { LessonActionsContext, type LessonActions } from '../lesson/actions.tsx';
import { ProgressContext, type LessonProgress } from '../lesson/progress.tsx';
import type { JsonValue } from '@app/server/protocol';
import { PixelMark, Wordmark } from '../PixelMark.tsx';
import { Conversation, type AskRequest } from './Conversation.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { MePanel } from './MePanel.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';
import { Review } from './Review.tsx';
import { EXISTING_WORK_PROMPT, INTERVIEW_PROMPT, PathView, type PathActions } from './PathView.tsx';
import { AgentBadge, AgentNotice, useAgentStatus } from './AgentStatus.tsx';
import { Editor } from '../editor/Editor.tsx';
import { ErrorBoundary } from '../ErrorBoundary.tsx';
import { CheckpointContext, type CheckpointActions } from '../lesson/checkpoints.tsx';

type Margin = 'none' | 'tutor' | 'history' | 'me' | 'project';
type View = 'session' | 'lesson' | 'review' | 'path';

/**
 * The workspace: contents on the left; a page in the middle, either a lesson or a session (the
 * interview, planning: the heavy interactions get the whole page); and a margin with the quick
 * tutor chat, History and You.
 */
export function ProjectView({
  project: opened,
  profile,
  initial,
  onPlace,
  onProfile,
  onBack,
  onBrain,
}: {
  project: ProjectDTO;
  profile: ProfileDTO;
  /** Where the learner was in this project before a restart. */
  initial?: Place;
  /** Remember where the learner is, to come back to it after a restart. */
  onPlace?: (change: Params<'place.set'>) => void;
  onProfile: (p: ProfileDTO) => void;
  onBack: () => void;
  /** Open the profile's brain view (absent where the app has nowhere to show it). */
  onBrain?: () => void;
}) {
  const rpc = useRpc();
  // The learner can change the project's settings while it is open.
  const projects = useQuery('projects.list', {}, ['projects']);
  const project = projects.data?.find((p) => p.id === opened.id) ?? opened;
  const lessons = useQuery('lessons.list', { projectId: project.id }, ['lessons', 'progress']);
  const [lessonId, setLessonId] = useState<string | undefined>(initial?.lessonId);
  // A remembered lesson that no longer exists falls back to the first one.
  const known = lessonId !== undefined && lessons.data?.some((l) => l.id === lessonId) === true;
  const current = known ? lessonId : lessons.data?.[0]?.id;
  const currentTitle = lessons.data?.find((l) => l.id === current)?.title;
  const lessonDoc = useQuery('lessons.get', current ? { projectId: project.id, lessonId: current } : null, ['lessons']);
  const savedProgress = useQuery('progress.get', current ? { projectId: project.id, lessonId: current } : null);
  // Saves made since the progress loaded, so counts update without reloading the lesson.
  const [local, setLocal] = useState<{ lessonId?: string; values: Record<string, JsonValue> }>({ values: {} });
  const progress: LessonProgress = useMemo(
    () => ({
      saved: { ...savedProgress.data, ...(local.lessonId === current ? local.values : {}) },
      save: (key, value) => {
        if (!current) return;
        setLocal((l) => ({ lessonId: current, values: { ...(l.lessonId === current ? l.values : {}), [key]: value } }));
        void rpc.call('progress.set', { projectId: project.id, lessonId: current, key, value }).catch(() => undefined);
      },
    }),
    [savedProgress.data, local, current, rpc, project.id],
  );
  const checkpointList = useQuery('checkpoints.list', current ? { projectId: project.id, lessonId: current } : null, ['checkpoints', 'projects']);
  const checkpoints: CheckpointActions = useMemo(
    () => ({
      data: checkpointList.data,
      run: (taskId) => rpc.call('checkpoints.run', { projectId: project.id, lessonId: current!, taskId }),
      cancel: () => void rpc.call('checkpoints.cancel', { projectId: project.id }).catch(() => undefined),
    }),
    [checkpointList.data, rpc, project.id, current],
  );
  const parsed = useMemo(() => (lessonDoc.data ? lessonSchema.safeParse(normalizeLesson(lessonDoc.data)) : undefined), [lessonDoc.data]);
  // Code in the tutor's replies that would give away an open task of this lesson is hidden (P1).
  const shapes = useMemo(() => (parsed?.success ? openTaskShapes(parsed.data, progress.saved) : []), [parsed, progress.saved]);
  // Keyed by content, so saving other progress does not re-hide a block the learner chose to see.
  const shapesKey = JSON.stringify(shapes);
  const gate: CodeGate | undefined = useMemo(() => {
    const open = JSON.parse(shapesKey) as typeof shapes;
    return open.length ? (code: string) => solutionFor(code, open)?.title : undefined;
  }, [shapesKey]);
  const [view, setView] = useState<View | undefined>(initial?.view);
  // Until the learner chooses, a project without lessons opens on the session page.
  const shown: View = view ?? (lessons.data && lessons.data.length === 0 ? 'session' : 'lesson');
  const [margin, setMargin] = useState<Margin>(initial?.margin ?? 'none');
  // The embedded editor, next to the page, for projects with a workspace.
  const [editorOn, setEditorOn] = useState(initial?.editor === true);
  const [openFile, setOpenFile] = useState<string | undefined>(initial?.file);
  useEffect(() => {
    onPlace?.({ view: view ?? null, lessonId: lessonId ?? null, margin, editor: editorOn, file: openFile ?? null });
  }, [onPlace, view, lessonId, margin, editorOn, openFile]);
  const openInEditor = useCallback((file: string) => {
    setEditorOn(true);
    setOpenFile(file.replace(/^\.?\/+/, ''));
  }, []);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatReq, setChatReq] = useState<AskRequest>();
  const [sessionReq, setSessionReq] = useState<AskRequest>();
  const [chip, setChip] = useState<{ x: number; y: number; text: string; anchor?: string }>();
  const lessonRef = useRef<HTMLDivElement>(null);
  const agent = useAgentStatus();
  const history = useQuery('history.list', { filter: {} }, ['history']);
  const reviews = useQuery('reviews.summary', {}, ['reviews', 'lessons']);
  const curriculum = useQuery('curriculum.get', { projectId: project.id }, ['lessons', 'learner', 'history', 'progress', 'reviews']);
  const due = reviews.data?.[project.id]?.due ?? 0;
  const pending = history.data?.filter((h) => h.status === 'proposed').length ?? 0;

  // Quick questions from the lesson go to the chat in the margin.
  const ask = useCallback(
    (question: string, opts?: { selection?: string; anchor?: string }) =>
      setChatReq({ question, ...(opts?.selection ? { selection: opts.selection } : {}), ...(opts?.anchor ? { anchor: opts.anchor } : {}), nonce: Date.now() }),
    [],
  );
  const startSession = useCallback((question: string) => setSessionReq({ question, nonce: Date.now() }), []);
  const showChat = useCallback(() => setMargin('tutor'), []);
  // The tutor's links back into a lesson: open it there, and show the place for a moment.
  const [jump, setJump] = useState<{ lessonId: string; anchor: string | undefined }>();
  const goToLesson = useCallback(
    (id: string, anchor: string | undefined) => {
      if (lessons.data && !lessons.data.some((l) => l.id === id)) {
        setMargin('history'); // not a lesson yet: it waits for review there
        return;
      }
      setLessonId(id);
      setView('lesson');
      setJump({ lessonId: id, anchor });
    },
    [lessons.data],
  );
  useEffect(() => {
    const root = lessonRef.current;
    if (!jump || shown !== 'lesson' || current !== jump.lessonId || !root?.querySelector('.lesson-section')) return; // not shown yet
    const safe = jump.anchor !== undefined && /^[\w:/-]+$/.test(jump.anchor);
    const el = (safe && root.querySelector(`[data-anchor="${jump.anchor}"]`)) || root.querySelector('.lesson-section')!;
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el.classList.add('jumped');
    setTimeout(() => el.classList.remove('jumped'), 2000);
    setJump(undefined);
  }, [jump, shown, current, parsed, savedProgress.data]);
  const showSession = useCallback(() => setView('session'), []);
  const pathActions: PathActions = useMemo(
    () => ({
      openLesson: (id) => {
        setLessonId(id);
        setView('lesson');
      },
      openReview: () => setView('review'),
      startSession: (question) => {
        setView('session');
        startSession(question);
      },
    }),
    [startSession],
  );

  const actions: LessonActions = useMemo(
    () => ({
      recordAnswer: (a) => {
        if (!current) return;
        void rpc.call('answers.record', {
          projectId: project.id,
          lessonId: current,
          itemId: a.itemId,
          ...(a.reviewOf ? { reviewOf: a.reviewOf } : {}),
          kcs: [...a.kcs],
          difficulty: a.difficulty,
          evidenceType: a.evidenceType,
          outcome: a.outcome,
          transfer: a.transfer,
          ...(a.confidence ? { confidence: a.confidence } : {}),
        });
      },
      ask,
      ...(project.workspace ? { openFile: openInEditor } : {}),
    }),
    [rpc, project.id, project.workspace, current, ask, openInEditor],
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

  const sources = useQuery('sources.list', { projectId: project.id }, ['sources']);
  const existingWork = project.workspace !== undefined || (sources.data?.length ?? 0) > 0;
  const intro = (
    <section className="intro">
      <p className="meta">{lessons.data?.length === 0 ? 'New project' : 'Session'}</p>
      <h1>{project.title}</h1>
      <p className="goal">{project.goal}</p>
      {lessons.data?.length === 0 ? (
        existingWork ? (
          <>
            <p>
              You already have work here{project.workspace ? ' in your folder' : ''}
              {sources.data?.length ? ` and ${sources.data.length} imported file${sources.data.length === 1 ? '' : 's'}` : ''}. Your tutor starts from it: it
              looks at what you did, lists the skills it suggests, then checks each one with you. Nothing counts as known until you have shown it.
            </p>
            <div className="intro-actions">
              <button type="button" className="primary" onClick={() => startSession(EXISTING_WORK_PROMPT)}>
                Start from my existing work
              </button>
              <button type="button" onClick={() => startSession(INTERVIEW_PROMPT)}>
                Start from scratch
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Before the first lesson, your tutor asks a few questions to find out what you already know, so the lesson starts at the right level.
              Not knowing is fine: that is exactly what it needs to find out.
            </p>
            <button type="button" className="primary" onClick={() => startSession(INTERVIEW_PROMPT)}>
              Start the interview
            </button>
          </>
        )
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
    <LessonLinkContext.Provider value={goToLesson}>
      <div className="project">
        <header className="bar">
          <Wordmark height={18} working={sessionBusy || chatBusy} />
          <span className="crumb-sep" aria-hidden>/</span>
          <button type="button" className="text" onClick={onBack}>
            Projects
          </button>
          <span className="crumb-sep" aria-hidden>/</span>
          <span className="crumb">{project.title}</span>
          <AgentBadge status={agent.status} />
          {project.workspace && (
            <button type="button" className="tab editor-toggle" aria-pressed={editorOn} onClick={() => setEditorOn(!editorOn)}>
              Editor
            </button>
          )}
          <nav className="margin-tabs" aria-label="Margin">
            {(
              [
                ['tutor', 'Tutor'],
                ['history', 'History'],
                ['me', 'You'],
                ['project', 'Project'],
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
        <div className={`workspace ${margin === 'none' ? '' : 'with-margin'} ${editorOn && project.workspace ? 'with-editor' : ''}`}>
          <nav className="toc" aria-label="Contents">
            <button type="button" className="toc-tutor" aria-current={shown === 'session'} onClick={() => setView('session')}>
              <PixelMark working={sessionBusy} size={16} />
              {lessons.data?.length === 0 ? 'Interview' : 'Sessions'}
              {sessionBusy && <span className="status">working</span>}
            </button>
            <button type="button" className="toc-review" aria-current={shown === 'path'} onClick={() => setView('path')}>
              Path
            </button>
            <button type="button" className="toc-review" aria-current={shown === 'review'} onClick={() => setView('review')}>
              Review
              {due > 0 && (
                <span className="count" aria-label={`${due} due`}>
                  {due} due
                </span>
              )}
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
                    <span className="t">{l.title}</span>
                    {l.progress.total > 0 && l.progress.done > 0 && (
                      <span className={`p ${l.progress.done === l.progress.total ? 'all' : ''}`} aria-label={`${l.progress.done} of ${l.progress.total} done`}>
                        {l.progress.done}/{l.progress.total}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
            {lessons.data?.length === 0 && <p className="quiet">Lessons appear here once your tutor has written them.</p>}
          </nav>
          <div className="page">
            <div hidden={shown !== 'session'}>
              <AgentNotice status={agent.status} onCheck={agent.check} />
              {curriculum.data && curriculum.data.nodes.length > 0 && (
                <p className="path-card">
                  Your path: <span className="num">{curriculum.data.nodes.length}</span> skills, <span className="num">{curriculum.data.plan.length}</span> lessons planned.{' '}
                  <button type="button" className="text" onClick={() => setView('path')}>
                    See the path
                  </button>
                </p>
              )}
              <ErrorBoundary area="the session">
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
                  gate={gate}
                />
              </ErrorBoundary>
            </div>
            {shown === 'review' && (
              <ErrorBoundary area="the review">
                <Review projectId={project.id} />
              </ErrorBoundary>
            )}
            {shown === 'path' && curriculum.data && (
              <ErrorBoundary area="the path">
                <PathView projectId={project.id} curriculum={curriculum.data} actions={pathActions} />
              </ErrorBoundary>
            )}
            <div hidden={shown !== 'lesson'} ref={lessonRef} onMouseUp={onMouseUp}>
              <LessonActionsContext.Provider value={actions}>
                <ProgressContext.Provider value={progress}>
                  <CheckpointContext.Provider value={checkpoints}>
                    {/* Blocks read their saved state when they mount: wait for it, and remount per lesson. */}
                    <ErrorBoundary area="this lesson" resetKey={current}>
                      {parsed?.success && savedProgress.data && <LessonView key={current} lesson={parsed.data} />}
                    </ErrorBoundary>
                  </CheckpointContext.Provider>
                </ProgressContext.Provider>
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
          {editorOn && project.workspace && (
            <ErrorBoundary area="the editor" resetKey={openFile}>
              <Editor projectId={project.id} open={openFile} onOpen={setOpenFile} />
            </ErrorBoundary>
          )}
          <aside className="margin" hidden={margin === 'none'}>
            <div hidden={margin !== 'tutor'}>
              <AgentNotice status={agent.status} onCheck={agent.check} />
              <ErrorBoundary area="the tutor chat">
                <Conversation variant="chat" projectId={project.id} lessonId={current} request={chatReq} onActivity={showChat} onBusy={setChatBusy} gate={gate} />
              </ErrorBoundary>
            </div>
            <ErrorBoundary area="this panel" resetKey={margin}>
              {margin === 'history' && <HistoryPanel />}
              {margin === 'me' && <MePanel profile={profile} onSettings={onProfile} {...(onBrain ? { onBrain } : {})} />}
              {margin === 'project' && <ProjectSettings key={project.id} project={project} />}
            </ErrorBoundary>
          </aside>
        </div>
      </div>
    </LessonLinkContext.Provider>
  );
}
