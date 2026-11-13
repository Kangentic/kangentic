/**
 * Catch a throw from a renderer callback the preload calls on a push.
 *
 * Every `on*` method of `ElectronAPI` takes a renderer callback and calls it
 * from an `ipcRenderer.on` handler, which runs in the preload's isolated world.
 * A throw there is an uncaught error of THAT world. The renderer's Sentry SDK
 * listens only in the main world, and the preload's own `error` listener gets
 * `Script error.` with no stack (measured in Electron 45). So the throw was
 * invisible, and it also stopped every listener registered after it on the
 * same channel.
 *
 * `guardPushCallbacks` wraps each function argument of each `on*` method, once,
 * before the API is exposed, so no call site needs its own try. The callback's
 * return value passes through; a throw goes to `onFailure` and stops there.
 */

/** Hears a push callback that threw, by the API method it was registered through. */
export type PushCallbackFailureSink = (method: string, error: unknown) => void;

const PUSH_METHOD_NAME = /^on[A-Z]/;

type AnyFunction = (...args: unknown[]) => unknown;

function guardCallback(method: string, callback: AnyFunction, onFailure: PushCallbackFailureSink): AnyFunction {
  return (...args: unknown[]) => {
    try {
      return callback(...args);
    } catch (error) {
      try {
        onFailure(method, error);
      } catch {
        // report-ok: the sink is the report; its own throw must not escape into the push.
      }
      return undefined;
    }
  };
}

function guardMethod(method: string, member: AnyFunction, owner: object, onFailure: PushCallbackFailureSink): AnyFunction {
  return (...args: unknown[]) => member.apply(owner, args.map((argument) =>
    typeof argument === 'function' ? guardCallback(method, argument as AnyFunction, onFailure) : argument));
}

/** Wrap every `on*` method on `api` and on each of its namespaces, in place. */
export function guardPushCallbacks<Api extends object>(api: Api, onFailure: PushCallbackFailureSink): Api {
  const wrapOwner = (owner: Record<string, unknown>, prefix: string): void => {
    for (const [name, member] of Object.entries(owner)) {
      if (typeof member !== 'function' || !PUSH_METHOD_NAME.test(name)) continue;
      owner[name] = guardMethod(`${prefix}${name}`, member as AnyFunction, owner, onFailure);
    }
  };
  const root = api as Record<string, unknown>;
  wrapOwner(root, '');
  for (const [namespace, value] of Object.entries(root)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) wrapOwner(value as Record<string, unknown>, `${namespace}.`);
  }
  return api;
}
