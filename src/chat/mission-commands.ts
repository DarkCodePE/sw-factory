import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionStore, type SessionState } from '../agent/session.ts';
import type { MissionAttempt, FeatureHandoff } from '../agent/mission-contract.ts';
import type { ChatController } from './controller.ts';

export async function handleMissionCommand(controller: ChatController, arg: string): Promise<boolean> {
  const [sub, ...rest] = (arg || 'status').trim().split(/\s+/);
  const subArg = rest.join(' ').trim();

  switch (sub) {
    case 'status': {
      if (!controller.missionTracker.hasMission && controller.sessionId) {
        try {
          const store = await SessionStore.create(controller.sessionDir);
          const s = await store.inspect(controller.sessionId);
          if (s.mission) {
            controller.missionTracker.state = s.mission.state;
            controller.missionTracker.directory = s.mission.directory;
            controller.missionTracker.missionId = s.mission.missionId;
          }
        } catch {}
      }
      if (!controller.missionTracker.hasMission) {
        controller.print('No hay una misión activa en esta sesión. Usa /mode mission con /auto high para iniciar una.');
      } else {
        controller.print(controller.missionTracker.renderPanel(80, controller.config.theme === 'plain'));
      }
      break;
    }
    case 'pause': {
      controller.pauseMission(subArg);
      break;
    }
    case 'resume': {
      if (controller.missionTracker.activeRun) throw new Error('La misión ya está en ejecución');
      if (controller.missionTracker.state !== 'paused' && controller.missionTracker.state !== 'orchestrator_turn') {
        throw new Error('Solo se puede reanudar una misión en estado paused u orchestrator_turn');
      }
      const prompt = subArg ? `Continuar la misión: ${subArg}` : 'Continuar con la ejecución de la misión.';
      controller.clearActive();
      return await controller.submit(prompt);
    }
    case 'workers': {
      let attempts: MissionAttempt[] = [];
      if (controller.sessionId) {
        try {
          const store = await SessionStore.create(controller.sessionDir);
          const s: SessionState = await store.inspect(controller.sessionId);
          attempts = s.mission?.attempts ?? [];
        } catch {}
      }
      if (!subArg) {
        if (controller.missionTracker.snapshot?.workers?.length) {
          for (const w of controller.missionTracker.snapshot.workers) {
            controller.print(`• Worker: ${w.workerSessionId} · Feature: ${w.featureId} · Rol: ${w.role} · Estado: ${w.status} · in ${w.usage.inputTokens} / out ${w.usage.outputTokens} · ${(w.durationMs / 1000).toFixed(1)}s`);
          }
        } else if (attempts.length) {
          for (const a of attempts) {
            controller.print(`• Worker: ${a.workerSessionId} · Feature: ${a.featureId} · Rol: ${a.role}${a.handoff ? ' · con handoff' : ''}`);
          }
        } else {
          controller.print('Sin workers registrados en esta misión.');
        }
      } else {
        const attempt = attempts.find(a => a.workerSessionId === subArg);
        const snapshotWorker = controller.missionTracker.snapshot?.workers.find(w => w.workerSessionId === subArg);
        if (!attempt && !snapshotWorker) {
          controller.print(`Worker ${subArg}: no se encontró en el snapshot de sesión.`);
        } else {
          const role = attempt?.role ?? snapshotWorker?.role ?? 'worker';
          const featureId = attempt?.featureId ?? snapshotWorker?.featureId ?? 'desconocida';
          controller.print(`Worker ${subArg} (${role}, feature: ${featureId}):`);
          const h: FeatureHandoff | undefined = attempt?.handoff;
          if (h?.handoff) {
            controller.print(`Estado de éxito: ${h.successState ?? 'desconocido'}`);
            controller.print(`Resumen: ${h.handoff.salientSummary ?? '(sin resumen)'}`);
            if (h.handoff.whatWasImplemented) controller.print(`Implementado: ${h.handoff.whatWasImplemented}`);
            if (h.handoff.whatWasLeftUndone) controller.print(`Pendiente: ${h.handoff.whatWasLeftUndone}`);
            const obsCmds = attempt?.observed ?? [];
            const claimedCmds = h.handoff.verification?.commandsRun ?? [];
            controller.print('Verificación observada:');
            if (obsCmds.length) {
              for (const obs of obsCmds) controller.print(`  • [observado] ${obs.command} -> exit ${obs.exitCode}`);
            } else if (claimedCmds.length) {
              for (const claim of claimedCmds) controller.print(`  • [declarado] ${claim.command} -> exit ${claim.exitCode}: ${claim.observation}`);
            } else {
              controller.print('  (ninguna)');
            }
            const issues = h.handoff.discoveredIssues ?? [];
            controller.print(`Issues detectados (${issues.length}):`);
            if (issues.length) {
              for (const iss of issues) controller.print(`  • [${iss.severity}] ${iss.description}${iss.suggestedFix ? ` (fix: ${iss.suggestedFix})` : ''}`);
            } else {
              controller.print('  (ninguno)');
            }
          } else {
            controller.print('Sin handoff registrado para este worker.');
            if (attempt?.observed?.length) {
              controller.print('Verificación observada:');
              for (const obs of attempt.observed) controller.print(`  • [observado] ${obs.command} -> exit ${obs.exitCode}`);
            }
          }
        }
      }
      break;
    }
    case 'log': {
      let missionDir = controller.missionTracker.directory;
      if (!missionDir && controller.sessionId) {
        try {
          const store = await SessionStore.create(controller.sessionDir);
          const s = await store.inspect(controller.sessionId);
          missionDir = s.mission?.directory;
        } catch {}
      }
      if (!missionDir && controller.sessionId) {
        missionDir = resolve(controller.sessionDir, '..', 'missions', controller.sessionId);
      }
      if (!missionDir) {
        controller.print('Sin registro de progreso (progress_log.jsonl no existe en esta misión).');
        break;
      }
      const logFile = join(missionDir, 'progress_log.jsonl');
      try {
        const content = await readFile(logFile, 'utf8');
        const count = Math.min(200, Math.max(1, Number(subArg) || 50));
        const lines = content.split('\n').filter(Boolean).slice(-count);
        if (!lines.length) {
          controller.print('El registro de progreso está vacío.');
        } else {
          controller.print(`Últimas ${lines.length} entradas de progress_log.jsonl:`);
          for (const l of lines) {
            try {
              const obj = JSON.parse(l) as Record<string, unknown>;
              controller.print(`[${String(obj.timestamp ?? '')}] ${String(obj.type ?? '')}: ${JSON.stringify(obj)}`);
            } catch {
              controller.print(l);
            }
          }
        }
      } catch {
        controller.print('Sin registro de progreso (progress_log.jsonl no existe en esta misión).');
      }
      break;
    }
    case 'list': {
      const store = await SessionStore.create(controller.sessionDir);
      let entries: Array<{ name: string; isFile(): boolean }> = [];
      try {
        entries = (await readdir(controller.sessionDir, { withFileTypes: true })).filter(e => e.isFile() && /^[\w-]{1,100}\.json$/.test(e.name));
      } catch {}
      const missionSessions: Array<{ id: string; title: string; state: string; updatedAt: number }> = [];
      for (const entry of entries) {
        const id = entry.name.slice(0, -5);
        try {
          const s = await store.inspect(id);
          if (s.cwd === controller.cwd && s.mission) {
            missionSessions.push({
              id: s.id,
              title: s.mission.title ?? s.title ?? s.id,
              state: s.mission.state ?? s.status,
              updatedAt: s.updatedAt ?? 0,
            });
          }
        } catch {}
      }
      missionSessions.sort((a, b) => b.updatedAt - a.updatedAt);
      if (!missionSessions.length) {
        controller.print('No se encontraron sesiones con misión en esta carpeta.');
        break;
      }
      const choices = missionSessions.map(m => `${m.id} · ${m.title} · estado: ${m.state}`);
      const chosenIndex = await controller.io.select('Seleccionar misión para reanudar', choices, controller.activeSignal);
      if (chosenIndex === undefined) break;
      const chosen = missionSessions[chosenIndex];
      if (chosen) {
        await controller.resume(chosen.id);
      }
      break;
    }
    default:
      throw new Error(`Subcomando desconocido: /mission ${sub}. Subcomandos disponibles: status, pause, resume, workers, log, list`);
  }
  return true;
}
