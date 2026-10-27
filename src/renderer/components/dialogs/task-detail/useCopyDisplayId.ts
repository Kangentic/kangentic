import { useState, useRef, useEffect, useCallback } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useToastStore } from '../../../stores/toast-store';

export function useCopyDisplayId(displayId: number) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const copy = useCallback(() => {
    // i18n-ok: a reference the user pastes into commits and prompts, so it stays English.
    navigator.clipboard.writeText(`Task #${displayId}`);
    useToastStore.getState().addToast({ title: i18n._(msg`Task ID copied`), message: `#${displayId}`, variant: 'info' });
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [displayId]);

  return { copied, copy };
}
