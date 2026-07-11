import { usePopOutStore } from '../stores/pop-out-store';
import { popOutInstanceKey } from '../../shared/pop-out';
import type { PopOutKind, PopOutParamsByKind } from '../../shared/pop-out';

export interface UsePopOutResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  focus: () => void;
}

/** UX contract for one detachable surface instance: while detached, the in-app
 *  surface closes and its trigger focuses the external window instead. */
export function usePopOut<K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]): UsePopOutResult {
  const key = popOutInstanceKey(kind, params);
  const isOpen = usePopOutStore((state) => Boolean(state.openInstanceKeys[key]));
  return {
    isOpen,
    open: () => { void window.electronAPI.popOut.open(kind, params); },
    close: () => { void window.electronAPI.popOut.close(kind, params); },
    focus: () => { void window.electronAPI.popOut.focus(kind, params); },
  };
}
