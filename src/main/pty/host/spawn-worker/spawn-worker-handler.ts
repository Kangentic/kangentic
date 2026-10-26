/**
 * What the pty host's spawn worker does with each message (`protocol.ts`):
 * the one-shot runs (`runHostExec`), the agent CLI runs (`HostCliProcesses`),
 * and the `ps` / PowerShell process table (`process-tree.ts`). The entry
 * (`spawn-worker-entry.ts`) wires it to the worker's port; the unit tests drive
 * it on their own thread.
 *
 * It loads no native module, which is unsafe in a worker thread: koffi stays on
 * the terminal thread, which pins a run's pid around its tree kill when this
 * reports one starting (`treeKillStarted`).
 */

import type { spawn } from 'node:child_process';
import { createProcessTreeProbe, type ProcessTreeProbe } from '../../../activity-engine/background-shell/process-tree';
import { HostCliProcesses } from '../host-cli-processes';
import { runHostExec } from '../host-exec';
import type { PtyHostEvent } from '../protocol';
import type { FromSpawnWorkerMessage, ToSpawnWorkerMessage } from './protocol';

type CliEvent = Extract<FromSpawnWorkerMessage, { type: 'cliEvent' }>['event'];

function isCliEvent(event: PtyHostEvent): event is CliEvent {
  return event.type.startsWith('cli');
}

export interface SpawnWorkerHandlerOptions {
  spawnChild?: typeof spawn;
  createProbe?: () => ProcessTreeProbe;
  /** This app's executables, which a run may never start. Read from main's report by default. */
  ownExecutable?: string;
}

export class SpawnWorkerHandler {
  private readonly cliProcesses: HostCliProcesses;
  private probe: ProcessTreeProbe | null = null;

  constructor(
    private readonly post: (message: FromSpawnWorkerMessage) => void,
    private readonly options: SpawnWorkerHandlerOptions = {},
  ) {
    this.cliProcesses = new HostCliProcesses(
      (event) => {
        if (isCliEvent(event)) post({ type: 'cliEvent', event });
      },
      options.spawnChild,
      options.ownExecutable,
      // The terminal thread pinned the pid before it sent the stop; this says
      // when the tree kill starts and when its taskkill has exited.
      (pid) => {
        post({ type: 'treeKillStarted', pid });
        return () => post({ type: 'treeKillEnded', pid });
      },
    );
  }

  handle(message: ToSpawnWorkerMessage): void {
    switch (message.type) {
      case 'exec':
        void runHostExec(message.request).then((result) => this.post({ type: 'execResult', id: message.id, result }));
        return;
      case 'listProcesses': {
        this.probe ??= (this.options.createProbe ?? createProcessTreeProbe)();
        this.probe.listAllProcesses().then(
          (rows) => this.post({ type: 'listProcessesResult', id: message.id, rows }),
          // [] is "no table this cycle", as the probe itself answers a failure.
          () => this.post({ type: 'listProcessesResult', id: message.id, rows: [] }),
        );
        return;
      }
      case 'disposeProcessTable':
        this.probe?.dispose();
        this.probe = null;
        return;
      case 'cliSpawn': {
        this.cliProcesses.start(message.params);
        // In the same turn as the spawn, so the terminal thread knows the pid
        // even if this worker dies before the child's `spawn` event.
        const pid = this.cliProcesses.pidOf(message.params.processId);
        if (pid !== undefined) this.post({ type: 'cliStarted', processId: message.params.processId, pid });
        return;
      }
      case 'cliWrite':
        this.cliProcesses.write(message.processId, message.data);
        return;
      case 'cliEndInput':
        this.cliProcesses.endInput(message.processId, message.data);
        return;
      case 'cliStop':
        this.cliProcesses.stop(message.processId);
        return;
      case 'cliStopAll':
        this.cliProcesses.stopAll();
        return;
      default: {
        const unknownMessage: never = message;
        throw new Error(`unknown spawn worker message: ${JSON.stringify(unknownMessage)}`);
      }
    }
  }
}
