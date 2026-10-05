import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lesson as lessonSchema } from '@app/catalog';
import type { ProfileDTO, ProjectDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { LessonView } from '../lesson/LessonView.tsx';
import { LessonActionsContext, type LessonActions } from '../lesson/actions.tsx';
import { AskPanel, type AskRequest } from './AskPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { MePanel } from './MePanel.tsx';

type Side = 'none' | 'history' | 'me';

/** The workspace: lessons, the lesson, a small Ask drawer, and side panels. */
export function ProjectView({ project, profile, onProfile, onBack }: { project: ProjectDTO; profile: ProfileDTO; onProfile: (p: ProfileDTO) => void; onBack: () => void }) {
  const rpc = useRpc();
  const lessons = useQuery('lessons.list', { projectId: project.id }, ['lessons']);
  const [lessonId, setLessonId] = useState<string>();
  const current = lessonId ?? lessons.data?.[0]?.id;
  const lessonDoc = useQuery('lessons.get', current ? { projectId: project.id, lessonId: current } : null, ['lessons']);
  const parsed = useMemo(() => (lessonDoc.data ? lessonSchema.safeParse(lessonDoc.data) : undefined), [lessonDoc.data]);
  const [side, setSide] = useState<Side>('none');
  const [askReq, setAskReq] = useState<AskRequest>();
  const [chip, setChip] = useState<{ x: number; y: number; text: string; anchor?: string }>();
  const lessonRef = useRef<HTMLDivElement>(null);
  const history = useQuery('history.list', { filter: {} }, ['history']);
  const pending = history.data?.filter((h) => h.status === 'proposed').length ?? 0;

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
      ask: (question, opts) => setAskReq({ question, ...(opts?.selection ? { selection: opts.selection } : {}), ...(opts?.anchor ? { anchor: opts.anchor } : {}), nonce: Date.now() }),
    }),
    [rpc, project.id, current],
  );

  // Select any text in the lesson → a floating "Ask about this" chip.
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
  }, [current]);

  return (
    <div className="project">
      <header className="topbar">
        <button type="button" onClick={onBack}>← Projects</button>
        <span className="project-title">{project.title}</span>
        <nav>
          <button type="button" aria-pressed={side === 'me'} onClick={() => setSide(side === 'me' ? 'none' : 'me')}>Me</button>
          <button type="button" aria-pressed={side === 'history'} onClick={() => setSide(side === 'history' ? 'none' : 'history')}>
            History{pending > 0 && <span className="badge" aria-label={`${pending} pending`}>{pending}</span>}
          </button>
        </nav>
      </header>
      <div className="workspace">
        <nav className="lesson-list" aria-label="Lessons">
          <h2>Lessons</h2>
          <ol>
            {lessons.data?.map((l) => (
              <li key={l.id}>
                <button type="button" aria-current={l.id === current} onClick={() => setLessonId(l.id)}>{l.title}</button>
              </li>
            ))}
          </ol>
          {lessons.data?.length === 0 && <p className="hint">No lessons yet.</p>}
        </nav>
        <div className="lesson-pane" ref={lessonRef} onMouseUp={onMouseUp}>
          <LessonActionsContext.Provider value={actions}>
            {parsed?.success && <LessonView lesson={parsed.data} />}
            {parsed && !parsed.success && <p className="error">This lesson could not be read: {parsed.error.message}</p>}
            {lessons.data?.length === 0 && (
              <section className="onboarding">
                <p className="eyebrow">New project</p>
                <h1>{project.title}</h1>
                <p className="goal">{project.goal}</p>
                <p>
                  Your tutor starts with a short conversation to find out what you already know, so the first lesson starts at the right level.
                  Expect a few quick questions to answer or predict. It's fine not to know.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => actions.ask('Interview me briefly to find out what I already know for this project, then draft the first lesson.')}
                >
                  Start the interview
                </button>
              </section>
            )}
          </LessonActionsContext.Provider>
          {chip && (
            <button
              type="button"
              className="ask-chip"
              style={{ left: chip.x, top: chip.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setAskReq({ question: '', selection: chip.text, ...(chip.anchor ? { anchor: chip.anchor } : {}), nonce: Date.now() });
                setChip(undefined);
              }}
            >
              Ask about this
            </button>
          )}
        </div>
        {side !== 'none' && (
          <div className="side-panel">
            {side === 'history' ? <HistoryPanel /> : <MePanel profile={profile} onSettings={onProfile} />}
          </div>
        )}
      </div>
      <AskPanel projectId={project.id} lessonId={current} request={askReq} />
    </div>
  );
}
