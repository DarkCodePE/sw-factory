// Solo lectura contra GitHub real, solo con FAB_LIVE_TEST=1. Repo público pequeño configurable con FAB_LIVE_REPO.
import { expect, test } from 'bun:test';
import { pollIssues } from '../src/admission/github.ts';

test.skipIf(process.env.FAB_LIVE_TEST !== '1')('live: pollIssues lee issues reales y respeta el cursor', async () => {
  const repo = process.env.FAB_LIVE_REPO ?? 'octocat/git-consortium';
  const events = await pollIssues(repo, undefined);
  expect(events.length).toBeGreaterThan(0);
  const last = events.at(-1)!;
  expect(last.repo).toBe(repo);
  expect(['open', 'closed']).toContain(last.state);
  const again = await pollIssues(repo, last.updatedAt);
  expect(again.length).toBeGreaterThanOrEqual(1);
  expect(again.every(e => e.updatedAt >= last.updatedAt)).toBe(true);
}, 120_000);
