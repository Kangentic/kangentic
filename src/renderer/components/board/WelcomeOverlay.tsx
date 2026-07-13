import { useState, useEffect, useRef, useCallback } from 'react';
import { ListPlus, ArrowRightLeft, Eye, Lightbulb } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { BrandMark } from '../BrandMark';

const DISPLAY_DURATION_MS = 15000;
const FADE_DURATION_MS = 500;

export function WelcomeOverlay() {
  const hasCompletedFirstRun = useConfigStore((state) => state.config.hasCompletedFirstRun);
  const loading = useConfigStore((state) => state.loading);
  const projectName = useProjectStore((state) => state.currentProject?.name);
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const [entered, setEntered] = useState(false);
  const [progressPercent, setProgressPercent] = useState(100);
  const animationFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(Date.now());
  const elapsedBeforePauseRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startCountdown = useCallback(() => {
    // Animate progress bar with requestAnimationFrame for smooth countdown
    const tick = () => {
      if (pausedRef.current) return;
      const elapsed = elapsedBeforePauseRef.current + (Date.now() - startTimeRef.current);
      const remaining = Math.max(0, 1 - elapsed / DISPLAY_DURATION_MS);
      setProgressPercent(remaining * 100);
      if (remaining > 0) {
        animationFrameRef.current = requestAnimationFrame(tick);
      }
    };
    animationFrameRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    // Trigger entrance animation on next frame
    requestAnimationFrame(() => setEntered(true));

    startTimeRef.current = Date.now();
    startCountdown();

    fadeTimerRef.current = setTimeout(() => setFading(true), DISPLAY_DURATION_MS);
    hideTimerRef.current = setTimeout(() => setVisible(false), DISPLAY_DURATION_MS + FADE_DURATION_MS);
    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [startCountdown]);

  const handleMouseEnter = useCallback(() => {
    pausedRef.current = true;
    // Accumulate elapsed time before pause
    elapsedBeforePauseRef.current += Date.now() - startTimeRef.current;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  const handleMouseLeave = useCallback(() => {
    pausedRef.current = false;
    startTimeRef.current = Date.now();
    startCountdown();
    const remainingTime = Math.max(0, DISPLAY_DURATION_MS - elapsedBeforePauseRef.current);
    fadeTimerRef.current = setTimeout(() => setFading(true), remainingTime);
    hideTimerRef.current = setTimeout(() => setVisible(false), remainingTime + FADE_DURATION_MS);
  }, [startCountdown]);

  if (loading || hasCompletedFirstRun || !visible) return null;

  const dismiss = () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setFading(true);
    hideTimerRef.current = setTimeout(() => setVisible(false), FADE_DURATION_MS);

    // Briefly pulse the Backlog column to guide the user's eye
    const backlogColumn = document.querySelector('[data-swimlane-name="Backlog"]');
    if (backlogColumn) {
      backlogColumn.classList.add('ring-2', 'ring-accent/60');
      pulseTimerRef.current = setTimeout(() => backlogColumn.classList.remove('ring-2', 'ring-accent/60'), 2000);
    }
  };

  const steps = [
    { icon: ListPlus, label: 'Create a task', description: 'Add a card with a title and prompt' },
    { icon: ArrowRightLeft, label: 'Drag to run', description: 'Drag the card to any active column to spawn an agent' },
    { icon: Eye, label: 'Watch it code', description: 'Follow along in the live terminal. See diffs, tests, and tool calls' },
  ];

  return (
    <div
      // `data-no-dismiss`: this first-run overlay sits absolute inset-0 inside the board
      // dismiss surface; mark it so a click never light-dismisses a window (defensive -
      // no task windows exist during first run anyway).
      data-no-dismiss
      className={`absolute inset-0 z-50 flex items-center justify-center bg-surface/60 backdrop-blur-sm transition-opacity ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ transitionDuration: `${FADE_DURATION_MS}ms` }}
      data-testid="welcome-overlay"
    >
      <div
        className={`bg-surface-raised border border-edge rounded-xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden transition-all duration-300 ease-out ${
          entered ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        data-testid="welcome-overlay-card"
      >
        <div className="px-12 pt-10 pb-8 text-center">
          {/* Logo */}
          <div className="flex justify-center mb-4">
            <BrandMark className="w-10 h-10 text-fg" />
          </div>

          <h2 className="text-2xl font-bold text-fg mb-1.5">
            Welcome to {projectName ?? 'your project'}
          </h2>
          <p className="text-sm text-fg-muted mb-8">Here's how to get started</p>

          <div className="space-y-5 text-left mb-10">
            {steps.map((step, index) => (
              <div key={index} className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center text-sm font-bold mt-0.5">
                  {index + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <step.icon size={16} strokeWidth={1.75} className="text-fg-muted" />
                    {step.label}
                  </div>
                  <p className="text-xs text-fg-faint mt-0.5 leading-relaxed">{step.description}</p>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center select-none cursor-pointer px-8 py-2.5 rounded-full bg-accent text-white font-medium hover:opacity-90 transition-opacity shadow-md text-sm"
            data-testid="welcome-overlay-dismiss"
          >
            Get Started
          </button>

          {/* Tip pill */}
          <div className="mt-6 inline-flex items-center select-none gap-1.5 px-3 py-1.5 rounded-full bg-surface-hover/50 text-xs text-fg-faint">
            <Lightbulb size={12} className="flex-shrink-0" />
            <span>Customize columns and apply a theme from Settings</span>
          </div>
        </div>

        {/* Progress bar countdown with glow effect */}
        <div className="h-1 bg-edge/30 rounded-b-xl overflow-hidden">
          <div
            className="h-full bg-accent/60 transition-none relative"
            style={{ width: `${progressPercent}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-accent/40 blur-sm" />
          </div>
        </div>
      </div>
    </div>
  );
}
