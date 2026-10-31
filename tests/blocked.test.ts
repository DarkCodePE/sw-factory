import { afterEach, expect, test } from 'bun:test';
import { Store } from '../src/store.ts';
import { handleKey, newTuiState } from '../src/tui.ts';
import { mergeBlocker } from '../src/validators/publish.ts';

const store = new Store(':memory:');
afterEach(() => store.db.exec('DELETE FROM workstreams'));
function setup() {
  const ws = store.createWorkstream({slug:'blocked',repo:'/tmp/unused',goal:'g',requireChangeApproval:false,requireApproval:false});
  store.setWorkstreamState(ws.id,'active');
  const c = store.createChange(ws.id,'fix','d');
  return {ws,c};
}
test('blocked keeps full reason, is terminal, supports human retry and clears inbox', () => {
  const {ws,c} = setup();
  const a = store.claimActivity(ws.id,'w')!;
  const reason = 'blocked - '+ 'reason '.repeat(5000);
  store.blockActivity(a.id,'w',reason);
  expect(store.inbox(ws.id)[0]!.error).toBe(reason);
  expect(store.isTerminal('blocked')).toBe(true);
  expect(store.claimActivity(ws.id,'w')).toBeNull();
  const state = newTuiState(); handleKey(store,ws.id,state,'r');
  expect(state.flash).toContain('re-encolado');
  expect(store.getChange(c.id).status).toBe('pending');
  expect(store.inbox(ws.id)).toHaveLength(0);
});
test('blocked validator prevents merge and retries as the same validator through TUI', () => {
  const {ws,c} = setup();
  store.completeActivity(store.claimActivity(ws.id,'w')!.id,'w','STATUS: done');
  store.completeActivity(store.claimActivity(ws.id,'w')!.id,'w','STATUS: done');
  store.requestValidation(c.id,['qa']);
  const qa = store.claimActivity(ws.id,'w')!;
  store.blockActivity(qa.id,'w','blocked - need credentials');
  expect(mergeBlocker(store.validationSummary(c.id))).toContain('qa');
  const state = newTuiState(); handleKey(store,ws.id,state,'r');
  expect(store.getChange(c.id).status).toBe('implemented');
  expect(store.claimActivity(ws.id,'w')!.validator).toBe('qa');
});
test('TUI retries an exhausted validator on implemented change', () => {
  const {ws,c} = setup();
  store.completeActivity(store.claimActivity(ws.id,'w')!.id,'w','STATUS: done');
  store.completeActivity(store.claimActivity(ws.id,'w')!.id,'w','STATUS: done');
  store.requestValidation(c.id,['qa']);
  for (let i=0;i<3;i++) store.failActivity(store.claimActivity(ws.id,'w')!.id,'w','missing');
  const state = newTuiState(); handleKey(store,ws.id,state,'r');
  expect(state.flash).toContain('re-encolado');
  expect(store.claimActivity(ws.id,'w')!.validator).toBe('qa');
});
test('a late blocked result cannot reopen a canceled change', () => {
  const {ws,c} = setup(); const a = store.claimActivity(ws.id,'w')!;
  store.closeChange(c.id,'canceled');
  expect(()=>store.blockActivity(a.id,'w','blocked - late')).toThrow('not held');
  expect(store.getChange(c.id).status).toBe('canceled');
});
test('late failures cannot requeue workers after the change is blocked', () => {
  const {ws,c} = setup(); const a=store.claimActivity(ws.id,'w')!;
  store.db.query(`UPDATE changes SET status='blocked' WHERE id=?`).run(c.id);
  expect(()=>store.failActivity(a.id,'w','late failure')).toThrow(/not held|is terminal/);
  expect(store.getChange(c.id).status).toBe('blocked');
  expect(store.listActivities({changeId:c.id,status:'pending'})).toHaveLength(0);
});
