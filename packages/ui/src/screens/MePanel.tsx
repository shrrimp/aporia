import type { ProfileDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';

const MASTERY: Record<string, string> = {
  unseen: 'not seen yet',
  introduced: 'introduced',
  practising: 'practising',
  provisional: 'got it (to confirm later)',
  durable: 'learned — it stuck',
};

/** The open learner model: what the app believes, with how sure it is, and the settings. */
export function MePanel({ profile, onSettings, onBrain }: { profile: ProfileDTO; onSettings: (p: ProfileDTO) => void; onBrain?: () => void }) {
  const rpc = useRpc();
  const learner = useQuery('learner.summary', {}, ['learner']);
  const d = learner.data;
  const update = async (s: Partial<ProfileDTO['settings']>) => onSettings(await rpc.call('profiles.updateSettings', s));
  return (
    <section className="me" aria-label="What the app knows about you">
      <h2>Your learning</h2>
      {d && d.recentSuccess.total > 0 && (
        <p>
          Recent first tries: {d.recentSuccess.correct}/{d.recentSuccess.total}. The app aims for 70–85%: hard enough to learn, not so hard you stall.
        </p>
      )}
      <h3>Skills</h3>
      {onBrain && (
        <p>
          <button type="button" className="text" onClick={onBrain}>
            See every skill on the map of your brain
          </button>
        </p>
      )}
      {d?.kcs.length ? (
        <table className="skills">
          <thead>
            <tr><th>Skill</th><th>Level</th><th>Status</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            {d.kcs.map((k) => (
              <tr key={k.kc}>
                <td><code>{k.kc}</code></td>
                <td>{k.band}</td>
                <td>{MASTERY[k.mastery] ?? k.mastery}</td>
                <td><meter min={0} max={1} value={k.confidence} aria-label={`confidence ${Math.round(k.confidence * 100)}%`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="quiet">No evidence yet. Skills appear as you answer and build.</p>
      )}
      <h3>How you seem to learn</h3>
      <p className="quiet">Hypotheses your tutor formed. Trust grows when a pattern repeats and shrinks when it is contradicted.</p>
      <ul className="insights">
        {d?.insights.map((i) => (
          <li key={i.id}>
            <meter min={0} max={1} value={i.trust} aria-label={`trust ${Math.round(i.trust * 100)}%`} /> {i.text}
          </li>
        ))}
      </ul>
      <h3>Settings</h3>
      <label className="setting">
        <input type="checkbox" checked={profile.settings.changeMode === 'auto'} onChange={(e) => void update({ changeMode: e.target.checked ? 'auto' : 'review' })} />
        Apply the tutor's changes immediately (you can still undo everything in History)
      </label>
      <label className="setting">
        Agent memory
        <select value={profile.settings.sessionMode} onChange={(e) => void update({ sessionMode: e.target.value as ProfileDTO['settings']['sessionMode'] })}>
          <option value="interaction">Fresh for every question (best for small or local models)</option>
          <option value="lesson">One conversation per lesson (recommended)</option>
          <option value="permanent">One long conversation per project (very strong models)</option>
        </select>
      </label>
      <label className="setting">
        New review questions
        <select value={profile.settings.reviewQuestions} onChange={(e) => void update({ reviewQuestions: e.target.value as ProfileDTO['settings']['reviewQuestions'] })}>
          <option value="pool">Written ahead by your tutor, in the background (recommended)</option>
          <option value="when-due">Written when you open Review (you wait for them)</option>
          <option value="numbers">Written once, with new numbers each time (no more tutor calls)</option>
        </select>
      </label>
    </section>
  );
}
