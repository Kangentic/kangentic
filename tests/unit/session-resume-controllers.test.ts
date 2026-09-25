/**
 * The per-task abort registry behind SESSION_SUSPEND / SESSION_RESET / a newer
 * SESSION_RESUME / project-relocate cancelling an in-flight resume
 * (src/main/ipc/handlers/session-resume-controllers.ts).
 *
 * It used to be one slot per task, which was fine while SESSION_RESUME was
 * the only registrant and always aborted the previous holder first. The
 * phone's start-session verb reaches `autoSpawnForTask`, which registers
 * WITHOUT aborting (a Start must never cancel desktop work), so two
 * controllers can be in flight for one task. On the single slot the second
 * registration displaced the first: a desktop Resume's controller fell out of
 * the registry the moment a Start landed, and the Pause that followed
 * cancelled only the Start while the Resume went on to spawn.
 */
import { describe, it, expect } from 'vitest';
import {
  abortInFlightResume,
  registerResumeController,
  releaseResumeController,
} from '../../src/main/ipc/handlers/session-resume-controllers';

describe('session resume controller registry', () => {
  it('aborts every controller registered for the task, not only the latest', () => {
    const desktopResume = new AbortController();
    const phoneStart = new AbortController();
    registerResumeController('task-a', desktopResume);
    registerResumeController('task-a', phoneStart);

    abortInFlightResume('task-a');

    // Red on the single-slot registry: the phone Start displaced the desktop
    // Resume, so only phoneStart aborted.
    expect(desktopResume.signal.aborted).toBe(true);
    expect(phoneStart.signal.aborted).toBe(true);

    releaseResumeController('task-a', desktopResume);
    releaseResumeController('task-a', phoneStart);
  });

  it('a release removes only the caller\'s own controller', () => {
    const desktopResume = new AbortController();
    const phoneStart = new AbortController();
    registerResumeController('task-b', desktopResume);
    registerResumeController('task-b', phoneStart);

    // The Start settles first and releases itself; the Resume must stay
    // reachable by the next suspend.
    releaseResumeController('task-b', phoneStart);
    abortInFlightResume('task-b');

    expect(phoneStart.signal.aborted).toBe(false);
    expect(desktopResume.signal.aborted).toBe(true);

    releaseResumeController('task-b', desktopResume);
  });

  it('keeps SESSION_RESUME\'s abort-then-register shape working: the older resume is cancelled, the newer is not', () => {
    const firstResume = new AbortController();
    registerResumeController('task-c', firstResume);

    // What a second SESSION_RESUME does on entry.
    abortInFlightResume('task-c');
    const secondResume = new AbortController();
    registerResumeController('task-c', secondResume);

    expect(firstResume.signal.aborted).toBe(true);
    expect(secondResume.signal.aborted).toBe(false);

    // The first resume's own finally releases it; the second stays registered.
    releaseResumeController('task-c', firstResume);
    abortInFlightResume('task-c');
    expect(secondResume.signal.aborted).toBe(true);

    releaseResumeController('task-c', secondResume);
  });

  it('is scoped per task and tolerates a release for a task with nothing registered', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    registerResumeController('task-d', controllerA);
    registerResumeController('task-e', controllerB);

    abortInFlightResume('task-d');
    expect(controllerA.signal.aborted).toBe(true);
    expect(controllerB.signal.aborted).toBe(false);

    releaseResumeController('task-d', controllerA);
    releaseResumeController('task-e', controllerB);
    // Fully released: a later abort finds nothing and a stray release is a no-op.
    expect(() => abortInFlightResume('task-d')).not.toThrow();
    expect(() => releaseResumeController('task-d', controllerA)).not.toThrow();
    expect(() => releaseResumeController('never-registered', controllerA)).not.toThrow();
  });
});
