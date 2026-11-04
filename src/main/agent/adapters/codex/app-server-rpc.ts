import type { CliChildProcess } from '../../../utility-process/off-main-cli';

/** How a conversation's handlers answer it and talk to the app-server. */
export interface AppServerConversation<T> {
  send(message: unknown): void;
  resolve(value: T): void;
  reject(error: Error): void;
}

/**
 * One stdio JSON-RPC conversation with `codex app-server`, the framing the hook
 * trust read (`hooks/list`) and the model list read (`model/list`) share. It
 * sends `initialize` as id 1, answers its result with `initialized`, then calls
 * `afterInitialize` to send the read's own request. Every later message with an
 * id goes to `onMessage`, which settles the conversation. Rejects on an
 * `initialize` error, the bound, a spawn error, or an exit before it settles.
 * Lines that are not JSON, and notifications, are skipped.
 */
export function converseWithAppServer<T>(
  child: CliChildProcess,
  timeoutMs: number,
  afterInitialize: (conversation: AppServerConversation<T>) => void,
  onMessage: (message: Record<string, unknown>, conversation: AppServerConversation<T>) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let settled = false;
    // An app-server that exits before reading (a Codex without the subcommand)
    // fails the write with EPIPE; its exit rejects the read.
    child.stdin.on('error', () => undefined);
    const timer = setTimeout(() => finish(() => reject(new Error('timed out'))), timeoutMs);
    timer.unref?.();
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    }
    const conversation: AppServerConversation<T> = {
      send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); },
      resolve: (value) => finish(() => resolve(value)),
      reject: (error) => finish(() => reject(error)),
    };
    child.once('error', (error: Error) => conversation.reject(error));
    child.once('exit', () => conversation.reject(new Error('app-server exited before answering')));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0 && !settled) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(message) || message.id === undefined) continue;
        if (message.id === 1) {
          if (message.error) {
            conversation.reject(new Error('initialize failed'));
            return;
          }
          conversation.send({ jsonrpc: '2.0', method: 'initialized' });
          afterInitialize(conversation);
        } else {
          onMessage(message, conversation);
        }
      }
    });
    conversation.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'kangentic', title: 'Kangentic', version: '0' } } });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
