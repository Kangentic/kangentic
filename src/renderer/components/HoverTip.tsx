/**
 * The one tooltip. Every explanatory hover text in the renderer is a HoverTip; a native `title`
 * survives only for the full value of text the layout cuts short (`.claude/rules/one-tooltip.md`).
 *
 * Two shapes:
 *  - A LABEL: a word or a sentence, inverted (`bg-fg` on `text-surface`) so it reads like the
 *    platform tip it replaces. It can lead with a 12px icon in its own text colour and end with
 *    the live key chips of a KEYBINDINGS action, and it wraps at 280px, keeping "\n" breaks.
 *  - A RICH tip: the raised panel with a muted outline, an optional header band (icon and title
 *    over a divider), a free-form body and an optional footer. Any of `content`, `header` or
 *    `footer` selects it; `label` is then what a screen reader reads.
 *
 * Behaviour (timing and placement live in `utils/hover-tip.ts`):
 *  - Opens after HOVER_TIP_DWELL_MS of hover. The dwell arms on a pointer MOVE over the trigger,
 *    not on the enter alone: a control that appears under a resting pointer (a button in a
 *    dialog that just opened) only gets boundary events, so it shows nothing until the pointer
 *    moves, and a stray tip cannot eat the Escape meant for that dialog.
 *  - Opens at once on keyboard focus (`:focus-visible`, and not the focus a press gave it), and at
 *    once while another tip shows or for HOVER_TIP_WARM_MS after one closed.
 *  - Closes on pointer leave (a tip keyboard focus opened stays until blur), blur, a press or
 *    click of the trigger, Escape, a scroll of anything holding the trigger, a window resize, and
 *    the window losing focus. A press keeps it shut until the pointer leaves.
 *  - Escape closes ONLY the tip. A `window` capture-phase listener, added only while the tip
 *    shows, stops the key before any menu or dialog listener sees it, so one press undoes one
 *    thing. Focus in a terminal (Escape is the agent interrupt) or a hotkey rebind keeps the key.
 *  - Never takes focus or a click: a `pointer-events: none` body portal. It carries no
 *    `data-dismissable-layer`, which WalkthroughLayer, the pop-out Escape guard and
 *    useClickOutsideToClose would read as an open overlay.
 *  - Adds no element around its trigger. The one child renders as itself with the tip's handlers
 *    chained after its own, so its own layout classes (`flex-1`, `last:`, a `<th>` cell) are
 *    untouched. A disabled control works the same way, because the tip listens to POINTER
 *    events, which Chromium and React both deliver to a disabled button (React suppresses only
 *    its mouse events and click). A click handler is chained only onto a DOM element or a child
 *    that already takes one, because a component can render differently once it has one (Pill
 *    becomes a `<button>`).
 *  - An empty label holds the tip shut, as `enabled={false}` does, so a control passes an
 *    optional tip straight through. A tip held shut never claims an event, so the trigger
 *    around it still shows its own tip.
 *  - The trigger keeps its own accessible name. What the tip adds (a reason, an explanation, the
 *    shortcut) is the trigger's accessible description, set as `aria-description` on the trigger
 *    itself, so it is there without hovering. Chromium exposes it exactly as it does
 *    `aria-describedby`, but it puts no node in the page: a hidden description node in `<body>`
 *    would also answer every page-level text lookup that matches its words. A label that only
 *    repeats the trigger's name is not read twice. A trigger's own `aria-describedby` outranks
 *    `aria-description`, so a trigger that already has one does not hear the tip. A trigger's own
 *    `aria-description` is kept when the tip adds nothing to read.
 *
 * A body portal is the only placement that escapes both ways an in-flow tip fails: an
 * `overflow-hidden` ancestor clips it, and a `backdrop-filter` ancestor turns `position: fixed`
 * into "fixed to that ancestor".
 */

import {
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ElementType,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useEffectiveCombo } from '../hooks/useKeybinding';
import { formatCombo, formatComboSegments } from '../utils/keybindings';
import { isRebindCaptureActive } from '../utils/rebind-state';
import {
  HOVER_TIP_DWELL_MS,
  claimTip,
  isTipWarm,
  placeTip,
  releaseTip,
  repeatsTriggerName,
  tipDescription,
} from '../utils/hover-tip';

export interface HoverTipHeader {
  icon?: ReactNode;
  title: string;
}

export interface HoverTipProps {
  /**
   * Plain text: the label tip itself, and what a screen reader reads for a rich tip. "\n" breaks
   * a line. An empty label with no rich part holds the tip shut.
   */
  label: string;
  /** A muted second part under the label (a commit's author under its subject). Label shape only. */
  detail?: string;
  /** A KEYBINDINGS id. Its live combo (the user's override, or the default) is drawn as chips and read. */
  keys?: string;
  /** A leading 12px glyph, drawn in the label's own text colour: pass no colour class. Label shape only. */
  icon?: ReactNode;
  /** A rich tip's body. Any of `content`, `header` or `footer` selects the rich shape. */
  content?: ReactNode;
  header?: HoverTipHeader;
  footer?: ReactNode;
  /**
   * Whether the label and detail are read as the trigger's description. Default: yes, unless the
   * label only repeats the trigger's own name. The shortcut is always read.
   */
  describe?: boolean;
  /** False holds the tip shut, for example while the trigger's own menu is open. Default true. */
  enabled?: boolean;
  testId?: string;
  /**
   * ONE element that passes the pointer, focus and click handlers and `aria-description` through
   * to a DOM node. A plain DOM element does; a component must forward them.
   */
  children: ReactElement;
}

/** What HoverTip reads from its child and chains onto it. */
interface TriggerProps {
  onPointerEnter?: (event: ReactPointerEvent<Element>) => void;
  onPointerMove?: (event: ReactPointerEvent<Element>) => void;
  onPointerLeave?: (event: ReactPointerEvent<Element>) => void;
  onPointerDown?: (event: ReactPointerEvent<Element>) => void;
  onClick?: (event: ReactMouseEvent<Element>) => void;
  onFocus?: (event: FocusEvent<Element>) => void;
  onBlur?: (event: FocusEvent<Element>) => void;
  'aria-description'?: string;
  'aria-label'?: string;
  children?: ReactNode;
}

interface TipLayerHandle {
  show(mode: 'cold' | 'warm'): void;
  /** `warm` starts the warm window (leave, blur); a cold close (Escape, a press) does not. */
  hide(warm: boolean): void;
}

/** Every tip: fixed above everything, never hit by the pointer. Positioned imperatively. */
const TIP_BASE_CLASS = 'pointer-events-none fixed left-0 top-0 z-[2147483646] rounded-md text-xs shadow-tip';
/** The label shape: inverted, wrapping at 280px (or the window, if narrower). */
const LABEL_TIP_CLASS = 'w-max max-w-[min(280px,calc(100vw-16px))] bg-fg px-2 py-1 leading-4 text-surface';
/** The rich shape: the raised panel with a muted outline. */
const RICH_TIP_CLASS = 'w-max max-w-[calc(100vw-16px)] overflow-hidden border border-fg-muted bg-surface-raised text-fg';
const KEY_CHIP_CLASS = 'inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-tip-chip-edge bg-tip-chip px-1 font-sans text-[11px] font-medium leading-none text-surface';

/**
 * Events an inner trigger already answered. A trigger can sit inside another (a PR state badge
 * inside the PR link pill), and pointer and focus events bubble, so without this both tips
 * would arm on one move. The innermost trigger takes the event and the outer one stands down.
 */
const answeredEvents = new WeakSet<Event>();

/** True the first time a trigger sees `event`; false for every trigger it bubbles to after. */
function answerFirst(event: Event): boolean {
  if (answeredEvents.has(event)) return false;
  answeredEvents.add(event);
  return true;
}

function isUsablePointer(event: ReactPointerEvent<Element>): boolean {
  // Touch never hovers: a tap is a press. A held button is a drag crossing the control.
  return event.pointerType !== 'touch' && event.buttons === 0;
}

/** Dev-only checks on a trigger, run once when it is first touched. */
function warnAboutTrigger(element: Element): void {
  const where = element.outerHTML.slice(0, 120);
  if (element.hasAttribute('title')) {
    console.error(`HoverTip: the trigger still carries a native title, so two tooltips show: ${where}`);
  }
  const interactive = element.matches('button, a[href], [role="button"], [role="switch"], [role="tab"]');
  const named = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby')
    || (element.textContent ?? '').trim() !== '';
  if (interactive && !named) {
    console.error(`HoverTip: the trigger has no accessible name. A tip never names its trigger; give it an aria-label: ${where}`);
  }
}

export function HoverTip(props: HoverTipProps): ReactElement {
  const { label, detail, keys, icon, content, header, footer, describe, enabled = true, testId, children } = props;
  const child = isValidElement(children) ? (children as ReactElement<TriggerProps>) : null;
  const childProps: TriggerProps = child?.props ?? {};
  const rich = content !== undefined || header !== undefined || footer !== undefined;
  // Whether the tip may open at all. An empty label has nothing to show.
  const active = enabled && (label !== '' || rich);
  const childIsFragment = child?.type === Fragment;

  // The trigger element, taken from the event that opens a tip rather than through a ref, so the
  // child's own ref passes through untouched and nothing has to be merged.
  const triggerRef = useRef<Element | null>(null);
  const layerRef = useRef<TipLayerHandle | null>(null);
  const hoveredRef = useRef(false);
  const armedRef = useRef(false);
  const hoverBlockedRef = useRef(false);
  const pressFocusRef = useRef(false);
  const focusOpenedRef = useRef(false);
  const enabledRef = useRef(active);
  const dwellTimerRef = useRef<number | null>(null);
  const checkedRef = useRef(false);

  const clearDwell = useCallback((): void => {
    if (dwellTimerRef.current === null) return;
    window.clearTimeout(dwellTimerRef.current);
    dwellTimerRef.current = null;
  }, []);

  const takeTrigger = useCallback((element: Element): void => {
    triggerRef.current = element;
    if (!__KANGENTIC_DEV__ || checkedRef.current) return;
    checkedRef.current = true;
    warnAboutTrigger(element);
  }, []);

  const handlePointerEnter = useCallback((event: ReactPointerEvent<Element>): void => {
    if (!isUsablePointer(event)) return;
    hoveredRef.current = true;
    // A fresh enter is a new hover. A keyboard click made while the pointer was elsewhere must
    // not keep this one shut; a press made inside is cleared by the leave that ends it.
    hoverBlockedRef.current = false;
    takeTrigger(event.currentTarget);
  }, [takeTrigger]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<Element>): void => {
    if (!isUsablePointer(event)) return;
    hoveredRef.current = true;
    // A tip held shut lets the move pass to the trigger around it, so a badge with nothing to say
    // does not silence the pill it sits in.
    if (!enabledRef.current) return;
    if (!answerFirst(event.nativeEvent)) {
      // An inner trigger owns this move, so this one stands down until the pointer is back on
      // its own area.
      if (!armedRef.current) return;
      armedRef.current = false;
      clearDwell();
      layerRef.current?.hide(true);
      return;
    }
    if (armedRef.current || hoverBlockedRef.current) return;
    takeTrigger(event.currentTarget);
    armedRef.current = true;
    if (isTipWarm(performance.now())) {
      layerRef.current?.show('warm');
      return;
    }
    dwellTimerRef.current = window.setTimeout(() => {
      dwellTimerRef.current = null;
      if (hoveredRef.current && !hoverBlockedRef.current && enabledRef.current) layerRef.current?.show('cold');
    }, HOVER_TIP_DWELL_MS);
  }, [clearDwell, takeTrigger]);

  const handlePointerLeave = useCallback((): void => {
    hoveredRef.current = false;
    armedRef.current = false;
    hoverBlockedRef.current = false;
    clearDwell();
    if (!focusOpenedRef.current) layerRef.current?.hide(true);
  }, [clearDwell]);

  const handlePointerDown = useCallback((): void => {
    hoverBlockedRef.current = true;
    pressFocusRef.current = true;
    clearDwell();
    layerRef.current?.hide(false);
    // The focus a press gives the trigger arrives before the release, so the release ends the
    // "this focus came from a press" window.
    const release = (): void => {
      pressFocusRef.current = false;
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  }, [clearDwell]);

  const handleClick = useCallback((): void => {
    // A keyboard Enter or Space click, or the click a press ends in.
    hoverBlockedRef.current = true;
    clearDwell();
    layerRef.current?.hide(false);
  }, [clearDwell]);

  const handleFocus = useCallback((event: FocusEvent<Element>): void => {
    const target = event.target;
    if (!enabledRef.current) return;
    if (!answerFirst(event.nativeEvent)) return;
    if (pressFocusRef.current) return;
    if (!(target instanceof Element) || !target.matches(':focus-visible')) return;
    takeTrigger(event.currentTarget);
    focusOpenedRef.current = true;
    clearDwell();
    layerRef.current?.show(isTipWarm(performance.now()) ? 'warm' : 'cold');
  }, [clearDwell, takeTrigger]);

  const handleBlur = useCallback((event: FocusEvent<Element>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    pressFocusRef.current = false;
    focusOpenedRef.current = false;
    // A tip the pointer is still holding open outlives the focus.
    if (hoveredRef.current && armedRef.current && !hoverBlockedRef.current) return;
    layerRef.current?.hide(true);
  }, []);

  // Whatever closed the tip (Escape, a press, a scroll, another tip), the one focus opened is
  // gone, so the next tip a hover opens closes on leave again.
  const handleHidden = useCallback((): void => {
    focusOpenedRef.current = false;
  }, []);

  useLayoutEffect(() => {
    enabledRef.current = active;
    if (active) return;
    // Disarmed as well as hidden, so the tip arms again on the next move once it is enabled,
    // even with the pointer still resting on the trigger.
    armedRef.current = false;
    focusOpenedRef.current = false;
    clearDwell();
    layerRef.current?.hide(false);
  }, [active, clearDwell]);

  useEffect(() => clearDwell, [clearDwell]);

  useEffect(() => {
    if (__KANGENTIC_DEV__ && childIsFragment) {
      console.error('HoverTip: the trigger is a Fragment, which takes no handlers, so its tip never opens. Pass one element.');
    }
  }, [childIsFragment]);

  // Every tip reads the store, but its selector returns nothing unless it has keys, so a tip
  // re-renders only when its own shortcut is rebound.
  const combo = useEffectiveCombo(keys);
  const triggerName = childProps['aria-label']
    ?? (typeof childProps.children === 'string' ? childProps.children : undefined);
  const readLabel = describe ?? !repeatsTriggerName(label, triggerName);
  // A tip held shut describes nothing either: its detail or shortcut alone would be read for a
  // tip no one can open.
  const description = active
    ? tipDescription({
        label,
        readLabel,
        combo: combo === '' ? '' : formatCombo(combo),
        detail: describe === false ? undefined : detail,
      })
    : '';

  if (child === null) return <>{children}</>;

  // The child re-rendered as itself with the tip's handlers chained after its own. Plain JSX on
  // the child's own type rather than cloneElement: React 19 keeps `ref` in props, so the spread
  // carries the child's ref through.
  const Trigger = child.type as ElementType;
  // A component with no click of its own gets none: Pill renders a <button> once it has an
  // `onClick`. The press handler already closes the tip; only a keyboard Enter or Space, which
  // such a child does not answer, goes without the close.
  const chainClick = typeof child.type === 'string' || childProps.onClick !== undefined;
  const clickProps = chainClick
    ? {
        onClick: (event: ReactMouseEvent<Element>) => {
          childProps.onClick?.(event);
          handleClick();
        },
      }
    : {};
  return (
    <>
      <Trigger
        {...child.props}
        {...clickProps}
        onPointerEnter={(event: ReactPointerEvent<Element>) => {
          childProps.onPointerEnter?.(event);
          handlePointerEnter(event);
        }}
        onPointerMove={(event: ReactPointerEvent<Element>) => {
          childProps.onPointerMove?.(event);
          handlePointerMove(event);
        }}
        onPointerLeave={(event: ReactPointerEvent<Element>) => {
          childProps.onPointerLeave?.(event);
          handlePointerLeave();
        }}
        onPointerDown={(event: ReactPointerEvent<Element>) => {
          childProps.onPointerDown?.(event);
          handlePointerDown();
        }}
        onFocus={(event: FocusEvent<Element>) => {
          childProps.onFocus?.(event);
          handleFocus(event);
        }}
        onBlur={(event: FocusEvent<Element>) => {
          childProps.onBlur?.(event);
          handleBlur(event);
        }}
        aria-description={description === '' ? childProps['aria-description'] : description}
      />
      <TipLayer
        handleRef={layerRef}
        triggerRef={triggerRef}
        onHidden={handleHidden}
        rich={rich}
        label={label}
        detail={detail}
        combo={combo}
        icon={icon}
        content={content}
        header={header}
        footer={footer}
        testId={testId}
      />
    </>
  );
}

function TipKeys({ combo }: { combo: string }): ReactElement {
  return (
    <span className="ml-1 flex shrink-0 items-center gap-0.5 self-center" data-hover-tip-part="keys">
      {formatComboSegments(combo).map((segment, index) => (
        <kbd key={`${index}-${segment}`} className={KEY_CHIP_CLASS}>{segment}</kbd>
      ))}
    </span>
  );
}

interface TipLayerProps {
  handleRef: RefObject<TipLayerHandle | null>;
  triggerRef: RefObject<Element | null>;
  /** Called on every close of a shown tip, whatever closed it. */
  onHidden: () => void;
  /** The rich shape: HoverTip decides it, since it also decides whether the tip opens at all. */
  rich: boolean;
  label: string;
  detail?: string;
  /** The live combo in canonical form, or '' for no keys. */
  combo: string;
  icon?: ReactNode;
  content?: ReactNode;
  header?: HoverTipHeader;
  footer?: ReactNode;
  testId?: string;
}

/**
 * The tip itself, and everything that lives only while it shows. It owns the open state, so
 * opening a tip re-renders this layer and never the trigger's subtree.
 */
function TipLayer(props: TipLayerProps): ReactElement | null {
  const { handleRef, triggerRef, onHidden, rich, label, detail, combo, icon, content, header, footer, testId } = props;
  const [shown, setShown] = useState<'cold' | 'warm' | null>(null);
  const shownRef = useRef<'cold' | 'warm' | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const hideRef = useRef<(warm: boolean) => void>(() => {});
  // A stable identity for the shared one-tip-at-a-time slot. Another tip claiming the slot
  // replaces this one, which is a warm close: the pointer is already on the next trigger.
  const [replaceThisTip] = useState(() => (): void => hideRef.current(true));

  const hide = useCallback((warm: boolean): void => {
    if (shownRef.current === null) return;
    shownRef.current = null;
    releaseTip(replaceThisTip, warm, performance.now());
    setShown(null);
    onHidden();
  }, [replaceThisTip, onHidden]);

  const show = useCallback((mode: 'cold' | 'warm'): void => {
    if (shownRef.current !== null) return;
    claimTip(replaceThisTip);
    shownRef.current = mode;
    setShown(mode);
  }, [replaceThisTip]);

  useLayoutEffect(() => {
    hideRef.current = hide;
  }, [hide]);

  useImperativeHandle(handleRef, () => ({ show, hide }), [show, hide]);

  useEffect(() => () => {
    if (shownRef.current === null) return;
    shownRef.current = null;
    releaseTip(replaceThisTip, true, performance.now());
  }, [replaceThisTip]);

  const position = useCallback((): void => {
    const tip = tipRef.current;
    const trigger = triggerRef.current;
    if (tip === null || trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    if (!trigger.isConnected || (anchor.width === 0 && anchor.height === 0)) {
      hide(false);
      return;
    }
    // offsetWidth/offsetHeight, not the rect: a cold tip enters from a scaled transform, and a
    // rect measured mid-animation reads short.
    const placement = placeTip(
      anchor,
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    tip.style.left = `${placement.left}px`;
    tip.style.top = `${placement.top}px`;
    tip.style.transformOrigin = placement.side === 'above' ? 'bottom center' : 'top center';
    tip.dataset.side = placement.side;
  }, [hide, triggerRef]);

  // Before paint, so the first frame is already in place.
  useLayoutEffect(() => {
    if (shown !== null) position();
  }, [shown, position]);

  useEffect(() => {
    if (shown === null) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return;
      hide(false);
      if (isRebindCaptureActive()) return;
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest('.xterm') !== null) return;
      event.stopPropagation();
    };
    const handleScroll = (event: Event): void => {
      const target = event.target;
      const trigger = triggerRef.current;
      // Only a scroll that moves the trigger: a terminal streaming output elsewhere must not
      // close a tip on a header button.
      if (target === document || (target instanceof Node && trigger !== null && target.contains(trigger))) hide(false);
    };
    const closeCold = (): void => hide(false);
    const observer = new ResizeObserver(() => position());
    if (tipRef.current !== null) observer.observe(tipRef.current);
    if (triggerRef.current !== null) observer.observe(triggerRef.current);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    window.addEventListener('resize', closeCold);
    window.addEventListener('blur', closeCold);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', closeCold);
      window.removeEventListener('blur', closeCold);
    };
  }, [shown, hide, position, triggerRef]);

  if (shown === null) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      data-hover-tip=""
      data-shape={rich ? 'rich' : 'label'}
      data-testid={testId}
      className={`${TIP_BASE_CLASS} ${rich ? RICH_TIP_CLASS : LABEL_TIP_CLASS}${shown === 'cold' ? ' overlay-popover-in' : ''}`}
    >
      {rich ? (
        <>
          {header !== undefined && (
            <div data-hover-tip-part="header" className="flex items-center gap-2 border-b border-edge bg-surface-hover/40 px-3 py-2">
              {header.icon !== undefined && (
                <span aria-hidden="true" className="flex shrink-0 text-fg-muted [&>svg]:size-[13px]">{header.icon}</span>
              )}
              <span className="font-semibold">{header.title}</span>
            </div>
          )}
          {content !== undefined && (
            <div data-hover-tip-part="body" className="px-3 py-2.5">{content}</div>
          )}
          {footer !== undefined && (
            <div data-hover-tip-part="footer" className="border-t border-edge px-3 py-1.5 text-fg-muted">{footer}</div>
          )}
        </>
      ) : (
        <span className="flex items-start gap-1.5">
          {icon !== undefined && (
            <span aria-hidden="true" className="mt-0.5 flex size-3 shrink-0 items-center justify-center [&>svg]:size-3">{icon}</span>
          )}
          <span className="min-w-0 whitespace-pre-line break-words">
            {label}
            {detail !== undefined && detail !== '' && (
              <span className="block text-tip-muted">{detail}</span>
            )}
          </span>
          {combo !== '' && <TipKeys combo={combo} />}
        </span>
      )}
    </div>,
    document.body,
  );
}
