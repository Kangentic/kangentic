import { useState, useRef, useEffect, useCallback } from 'react';
import { useToastStore } from '../../../stores/toast-store';

export function useCopyDisplayId(displayId: number) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(`Task #${displayId}`);
    useToastStore.getState().addToast({ title: 'Task ID copied', message: `#${displayId}`, variant: 'info' });
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [displayId]);

  return { copied, copy };
}
