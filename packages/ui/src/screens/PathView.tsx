import { useMemo, useState } from 'react';
import type { CurriculumDTO, FindingDTO, HistoryItemDTO, MilestoneDTO, NextStepDTO, PathNodeDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { Markdown } from '../lesson/Markdown.tsx';
import { ShowChange } from './Proposals.tsx';

const COL = 208;
const ROW = 60;
const NODE_W = 176;
const NODE_H = 42;
const PAD = 12;

const STATE_LABEL: Record<PathNodeDTO['state'], string> = {
  mastered: 'mastered',
  'in-progress': 'in progress',
  available: 'ready to learn',
  locked: 'locked',
};

export const CLAIM_FROM: Record<NonNullable<PathNodeDTO['claim']>['from'], string> = {
  workspace: 'from your code',
  sources: 'from your files',
  learner: 'from what you said',
};

const MASTERY_LABEL: Record<PathNodeDTO['mastery'], string> = {
  unseen: 'not seen yet',
  introduced: 'introduced',
  practising: 'practising',
  provisional: 'got it (to confirm later)',
  durable: 'learned, and it stuck',
};

export interface PathActions {
  openLesson(lessonId: string): void;
  openReview(): void;
  /** Start a session with the tutor on the session page. */
  startSession(question: string): void;
}

export const INTERVIEW_PROMPT = 'Interview me briefly to find out what I already know for this project, then draft the first lesson.';

/** For a project with work already done: start from it, and verify before believing it (P4). */
export const EXISTING_WORK_PROMPT =
  'I already have work for this project: my workspace and the files I added. Start from it. Explore it and read the files, ' +
  'then tell me which skills they suggest I have, and record them as claims in my skill map. A claim is not proof: check each one ' +
  'with short probes (questions about my own code are best) before anything counts. Then propose a roadmap for the rest of the ' +
  'project, and the first lesson from where I really am.';

function NextStep({ next, actions }: { next: NextStepDTO; actions: PathActions }) {
  const button = (() => {
    switch (next.kind) {
      case 'interview':
        return next.existing
          ? { label: 'Start from my existing work', go: () => actions.startSession(EXISTING_WORK_PROMPT) }
          : { label: 'Start the interview', go: () => actions.startSession(INTERVIEW_PROMPT) };
      case 'review':
        return { label: 'Review now', go: () => actions.openReview() };
      case 'lesson':
        return { label: 'Continue', go: () => actions.openLesson(next.lessonId) };
      case 'draft':
        return { label: 'Ask your tutor to write it', go: () => actions.startSession(`Draft the next lesson of the plan: "${next.title}" (plan item ${next.planId}). Set its lessonId on the plan once it is drafted.`) };
      case 'plan':
        return { label: 'Plan with your tutor', go: () => actions.startSession('Everything planned is done. Based on my progress, propose what to learn next, update the plan, and draft the next lesson.') };
    }
  })();
  return (
    <section className="next-step" aria-label="What's next">
      <p className="meta">What's next</p>
      <p className="next-text">{next.text}</p>
      <button type="button" className="primary" onClick={button.go}>
        {button.label}
      </button>
    </section>
  );
}

/** The path as a layered graph: foundations on the left, the project's goals on the right. */
function PathGraph({ nodes, edges, selected, onSelect }: { nodes: readonly PathNodeDTO[]; edges: CurriculumDTO['edges']; selected: string | undefined; onSelect: (id: string) => void }) {
  const pos = useMemo(() => {
    const rows = new Map<number, number>();
    const out = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      const r = rows.get(n.layer) ?? 0;
      rows.set(n.layer, r + 1);
      out.set(n.id, { x: PAD + n.layer * COL, y: PAD + r * ROW });
    }
    return out;
  }, [nodes]);
  const width = PAD * 2 + Math.max(0, ...nodes.map((n) => n.layer)) * COL + NODE_W;
  const height = PAD * 2 + Math.max(0, ...[...pos.values()].map((p) => p.y - PAD)) + NODE_H;
  return (
    <div className="path-graph" style={{ width, height }}>
      <svg className="path-edges" width={width} height={height} aria-hidden>
        {edges.map((e) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const on = selected === e.from || selected === e.to;
          return <path key={`${e.from}>${e.to}`} className={on ? 'on' : ''} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} />;
        })}
      </svg>
      {nodes.map((n) => {
        const p = pos.get(n.id)!;
        const label = `${n.title}: ${STATE_LABEL[n.state]}${n.claim && n.evidence === 0 ? ', claimed from your work, to verify' : ''}${n.goal ? ', a goal of this project' : ''}${n.needs.length ? `, needs ${n.needs.join(', ')}` : ''}`;
        return (
          <button
            key={n.id}
            type="button"
            className={`path-node state-${n.state} ${n.goal ? 'goal' : ''} ${n.claim && n.evidence === 0 ? 'claimed' : ''}`}
            style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H, opacity: 0.55 + 0.45 * (n.evidence > 0 ? Math.max(0.3, n.confidence) : 0.6) }}
            aria-pressed={selected === n.id}
            aria-label={label}
            title={n.needs.length ? `Needs: ${n.needs.join(', ')}` : STATE_LABEL[n.state]}
            onClick={() => onSelect(n.id)}
          >
            <span className="dot" aria-hidden />
            <span className="t">{n.title}</span>
          </button>
        );
      })}
    </div>
  );
}

const STATUS_LABEL: Record<MilestoneDTO['status'], string> = { planned: 'planned', active: 'working on it', done: 'done' };

/**
 * The project's roadmap: milestones in order. The tutor proposes changes, one milestone at a
 * time; the learner accepts or rejects each, and can undo any of them later. The status is the
 * learner's to set.
 */
function Roadmap({ projectId, milestones }: { projectId: string; milestones: readonly MilestoneDTO[] }) {
  const rpc = useRpc();
  const history = useQuery('history.list', { filter: {} }, ['history']);
  const [error, setError] = useState<string>();
  const changes = (history.data ?? []).filter((h) => h.target === `projects/${projectId}/roadmap.json` && h.author.kind !== 'system');
  const pending = changes.filter((h) => h.status === 'proposed');
  const recent = changes.filter((h) => h.status !== 'proposed' && h.status !== 'rejected').slice(0, 8);
  const act = (f: () => Promise<unknown>) => {
    setError(undefined);
    f().catch((err: Error) => setError(err.message));
  };
  const short = (h: HistoryItemDTO) => h.summary.replace(/^roadmap, /, '');
  return (
    <section className="roadmap" aria-label="Roadmap">
      <h2>Roadmap</h2>
      {milestones.length === 0 && pending.length === 0 && <p className="quiet">No roadmap yet. Your tutor proposes one from your goal, your work and your files; you decide what stays.</p>}
      <ol className="milestones">
        {milestones.map((m) => (
          <li key={m.id} className={`milestone status-${m.status}`}>
            <div className="milestone-head">
              <span className="milestone-title">{m.title}</span>
              <select
                aria-label={`Status of ${m.title}`}
                value={m.status}
                onChange={(e) => act(() => rpc.call('roadmap.setStatus', { projectId, milestoneId: m.id, status: e.target.value as MilestoneDTO['status'] }))}
              >
                {(['planned', 'active', 'done'] as const).map((st) => (
                  <option key={st} value={st}>
                    {STATUS_LABEL[st]}
                  </option>
                ))}
              </select>
            </div>
            {m.capability && <p className="quiet">Unlocks: {m.capability}</p>}
            {m.goal && <Markdown md={m.goal} />}
          </li>
        ))}
      </ol>
      {pending.length > 0 && (
        <div className="roadmap-pending">
          <h3>Proposed by your tutor</h3>
          <ul>
            {pending.map((h) => (
              <li key={h.id}>
                <p>{short(h)}</p>
                <ShowChange id={h.id} />
                <div className="proposal-actions">
                  <button type="button" className="primary" onClick={() => act(() => rpc.call('history.accept', { id: h.id }))}>
                    Accept
                  </button>
                  <button type="button" onClick={() => act(() => rpc.call('history.reject', { id: h.id }))}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {recent.length > 0 && (
        <details className="roadmap-history">
          <summary>Changes to the roadmap</summary>
          <ul>
            {recent.map((h) => (
              <li key={h.id} className={`status-${h.status}`}>
                <span>{short(h)}</span> <span className="quiet">{h.author.kind === 'learner' ? 'you' : 'your tutor'}</span>{' '}
                {h.status === 'applied' ? (
                  <button type="button" className="text" onClick={() => act(() => rpc.call('history.undo', { id: h.id, withDependants: true }))}>
                    undo
                  </button>
                ) : (
                  <button type="button" className="text" onClick={() => act(() => rpc.call('history.redo', { id: h.id }))}>
                    redo
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Findings({ title, items }: { title: string; items: readonly FindingDTO[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((f, i) => (
          <li key={i}>{f.text}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * The project map (ux §1, screen 4): the skills this project needs as a path, each placed by
 * evidence (mastered / in progress / ready / locked, with why), the rolling plan, the interview
 * findings, and one clear next step.
 */
export function PathView({ projectId, curriculum, actions }: { projectId: string; curriculum: CurriculumDTO; actions: PathActions }) {
  const [selected, setSelected] = useState<string>();
  const node = curriculum.nodes.find((n) => n.id === selected);
  return (
    <section className="path" aria-label="Path">
      <p className="meta">Path</p>
      <h1>Where this project takes you</h1>
      <NextStep next={curriculum.next} actions={actions} />
      <Roadmap projectId={projectId} milestones={curriculum.roadmap} />

      {curriculum.nodes.length > 0 ? (
        <>
          <h2>Skills</h2>
          <p className="quiet legend">
            <span className="key state-mastered" /> mastered <span className="key state-in-progress" /> in progress <span className="key state-available" /> ready to
            learn <span className="key state-locked" /> locked <span className="key claimed" /> claimed, to verify. Foundations on the left, this project's
            goals on the right.
          </p>
          <div className="path-scroll">
            <PathGraph nodes={curriculum.nodes} edges={curriculum.edges} selected={selected} onSelect={(id) => setSelected(id === selected ? undefined : id)} />
          </div>
          {node && (
            <div className="path-detail" role="region" aria-label={node.title}>
              <h3>{node.title}</h3>
              {node.summary && <p>{node.summary}</p>}
              <p>
                {STATE_LABEL[node.state]}
                {node.needs.length > 0 && <> · needs {node.needs.join(', ')}</>}
              </p>
              {node.claim && (
                <p className="claim">
                  {node.evidence === 0 ? 'Claimed, to verify: ' : 'Claimed at the start: '}
                  {node.claim.basis} <span className="quiet">({CLAIM_FROM[node.claim.from]})</span>
                </p>
              )}
              <p className="quiet">
                {MASTERY_LABEL[node.mastery]}
                {node.band && <> · level {node.band}</>} · {node.evidence} piece{node.evidence === 1 ? '' : 's'} of evidence · confidence {Math.round(node.confidence * 100)}%
              </p>
            </div>
          )}
        </>
      ) : (
        <p className="quiet">Your tutor drafts the skills of this project during the interview; they appear here as a path.</p>
      )}

      {curriculum.plan.length > 0 && (
        <>
          <h2>Plan</h2>
          <ol className="plan">
            {curriculum.plan.map((p) => (
              <li key={p.id} className={`plan-${p.status}`}>
                <span className="plan-status">{{ planned: 'planned', written: 'ready', 'in-progress': 'started', done: 'done' }[p.status]}</span>
                {p.lessonId && p.status !== 'planned' ? (
                  <button type="button" className="text" onClick={() => actions.openLesson(p.lessonId!)}>
                    {p.title}
                  </button>
                ) : (
                  <span className="plan-title">{p.title}</span>
                )}
                {p.progress && p.progress.total > 0 && (
                  <span className="num">
                    {' '}
                    {p.progress.done}/{p.progress.total}
                  </span>
                )}
                {p.capability && <p className="quiet">After it: {p.capability}</p>}
              </li>
            ))}
          </ol>
        </>
      )}

      {curriculum.assessment && (
        <section className="assessment" aria-label="What the interview found">
          <h2>What the interview found</h2>
          <p>{curriculum.assessment.summary}</p>
          <Findings title="Strong on" items={curriculum.assessment.strengths} />
          <Findings title="To work on" items={curriculum.assessment.gaps} />
          <Findings title="Possible misconceptions" items={curriculum.assessment.misconceptions} />
          <Findings title="What you can build on" items={curriculum.assessment.bridges} />
          {curriculum.assessment.preferences.length > 0 && (
            <>
              <h3>What you said you prefer</h3>
              <ul>
                {curriculum.assessment.preferences.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          )}
          <p className="quiet">Something wrong? Tell your tutor in a session, or undo it in History.</p>
        </section>
      )}
    </section>
  );
}
