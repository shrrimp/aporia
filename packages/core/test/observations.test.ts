import { describe, expect, it } from 'vitest';
import { Journal, ManualClock, Observations, UnknownEventError, activeObservations } from '../src/index.ts';
import { agent, learner, tempDir } from './helpers.ts';

async function setup() {
  const journal = await Journal.open(await tempDir(), new ManualClock('2026-10-05T10:00:00.000Z'));
  return new Observations(journal);
}

const evidence = {
  author: agent,
  itemId: 'drill-1',
  kcs: [{ kc: 'quaternion.unit', weight: 1 }],
  difficulty: 0,
  evidenceType: 'production' as const,
  outcome: 1,
};

describe('Observations', () => {
  it('records evidence, instruction and insights with defaults applied', async () => {
    const o = await setup();
    const ev = await o.recordEvidence(evidence);
    expect(ev).toMatchObject({ type: 'evidence', hintLevel: 0, transfer: false });
    await o.recordInstruction({ author: agent, kcs: ['quaternion.unit'] });
    await o.recordInsight({ author: agent, insightId: 'ins_01234567-89ab-7cde-8f01-23456789abcd', stance: 'propose', text: 'x' });
    expect(activeObservations(o.journal.events)).toHaveLength(3);
  });

  it('revokes and restores, and refuses unknown or non-observation ids', async () => {
    const o = await setup();
    const ev = await o.recordEvidence(evidence);
    await o.revoke([ev.id], learner, 'judged badly');
    expect(activeObservations(o.journal.events)).toHaveLength(0);
    await o.restore([ev.id], learner);
    expect(activeObservations(o.journal.events)).toHaveLength(1);
    const revokeEventId = o.journal.events[1]!.id;
    await expect(o.revoke([revokeEventId], learner)).rejects.toThrow(UnknownEventError);
  });

  it('bulk-revokes by filter', async () => {
    const o = await setup();
    await o.recordEvidence(evidence);
    await o.recordEvidence({ ...evidence, author: { ...agent, model: 'tiny-model' } });
    const revoked = await o.revokeWhere({ model: 'tiny-model' }, learner);
    expect(revoked).toHaveLength(1);
    expect(activeObservations(o.journal.events)).toHaveLength(1);
    expect(await o.revokeWhere({ model: 'nobody' }, learner)).toEqual([]);
  });
});
