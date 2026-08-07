import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Guards the combobox-clipping regression: a scrollable menu rendered IN FLOW as
// `absolute top-full ...` is confined to its nearest clipping ancestor, because
// `z-index` does not escape an ancestor's `overflow: hidden` / `overflow-y-auto`.
// That is what cut the Model dropdown off at the bottom of the task-detail edit
// form, showing only the first two options until the user scrolled.
//
// The fix is to portal the menu to document.body and position it with
// `usePopoverPosition({ strategy: 'fixed' })`, via `OverlayPopover`'s `portal`
// prop. See LabelInput.tsx / ModelCombobox.tsx for the canonical shape.
//
// This scan is a cheap tripwire, not the load-bearing guard - it cannot tell
// whether a given mount site actually has a clipping ancestor. The real
// regression guards are tests/ui/combobox-portal-clipping.spec.ts (Combobox /
// FontCombobox / ModelCombobox / BranchPicker) and
// tests/ui/popover-clipping-promote-restore-shortcuts.spec.ts (PromotePopover /
// RestorePopover / ShortcutsTab's Presets menu), which assert the menu is not a
// descendant of its clipping ancestor.
//
// TWO scans, because a menu can position itself in flow two different ways and a
// class-string check only sees one of them:
//
//  1. `isInFlowScrollableMenu` - a Tailwind class string that positions against
//     the trigger (`absolute` + `top-full` / `bottom-full`) and scrolls or caps
//     its own height. Catches hand-rolled menus that never call the hook
//     (ToolbarSearchFilter, manage-labels/PopoverShell).
//
//  2. `dropdownCallsMissingFixedStrategy` - a `usePopoverPosition` call in
//     `mode: 'dropdown'` that does NOT pass `strategy: 'fixed'`. This is the
//     scan that matters most, and scan 1 is structurally blind to it: in the
//     default `'absolute'` strategy the hook writes `top: 100%` / `bottom: 100%`
//     IMPERATIVELY onto `element.style`, so there is no `top-full` class to
//     match. That was the pre-fix shape of most of the components this rule was
//     written for (PromotePopover, RestorePopover, StatsScopePicker,
//     StatsCustomRangePicker, ImportPopover, ToolBreakdownPopover) - scan 1
//     alone would have caught only 4 of the 12, and would not have caught
//     ToolBreakdownPopover even though it is a scrollable, height-capped menu.
//     `mode: 'flyout'` is correctly exempt: the hook ignores `strategy` entirely
//     in flyout mode, so a flyout call never trips this.
//
// A popover that genuinely has no clipping ancestor at any of its mount sites
// opts out of EITHER scan with a `popover-inflow-ok: <reason>` marker on the
// line or within the lookbehind window above it.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_DIR = path.join(REPO_ROOT, 'src/renderer');

const OPT_OUT_MARKER = 'popover-inflow-ok:';
/** How many lines above the offending line the marker may sit. Generous because
 *  the marker leads a justification that has to name the mount sites it checked,
 *  which does not fit on one line at this file's wrap width. */
const MARKER_LOOKBEHIND = 8;

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      found.push(fullPath);
    }
  }
  return found;
}

/**
 * True for a class string that positions an element in flow against its trigger
 * AND scrolls or caps its own height - i.e. a menu / listbox, the shape that
 * gets clipped. A bare `absolute top-full` tooltip (no scroll, no cap) is not
 * matched: it is small enough that clipping is cosmetic, not a broken control.
 */
function isInFlowScrollableMenu(classString: string): boolean {
  const positionsInFlow =
    classString.includes('absolute') &&
    (classString.includes('top-full') || classString.includes('bottom-full'));
  const scrollsOrCapsHeight =
    classString.includes('overflow-y-auto') ||
    classString.includes('overflow-auto') ||
    classString.includes('max-h-');
  return positionsInFlow && scrollsOrCapsHeight;
}

/**
 * Quoted string literals in a chunk of source (double, single, or template).
 *
 * Template literals get their `${...}` expressions blanked rather than being
 * skipped, so a className written as an interpolated template still presents its
 * STATIC Tailwind tokens as one string. Without that, a class string like
 * `` `absolute top-full ... ${variant === 'input' ? '' : 'w-64'}` `` shreds into
 * the tiny fragments `'input'`, `''`, `'w-64'` - the interpolation's inner quotes
 * terminate the outer match - and the tokens that matter are never tested. This
 * is the shape BranchPicker.tsx uses, so it is a live blind spot, not a
 * hypothetical one.
 */
function classStringsOn(chunk: string): string[] {
  const literals: string[] = [];
  for (const literal of chunk.match(/(["'])[^"'\n]*\1/g) ?? []) {
    literals.push(literal.slice(1, -1));
  }
  for (const literal of chunk.match(/`[^`]*`/g) ?? []) {
    literals.push(literal.slice(1, -1).replace(/\$\{[^}]*\}/g, ' '));
  }
  return literals;
}

/**
 * Line-anchored chunks to scan for class strings.
 *
 * A className template literal is routinely wrapped across several physical
 * lines, which leaves the opening backtick unmatched on its own line. Each chunk
 * therefore extends forward until the backticks balance (capped), so a multi-line
 * className is tested as a whole while still reporting the line it starts on.
 */
function scannableChunks(lines: string[]): Array<{ text: string; lineIndex: number }> {
  const MAX_JOINED_LINES = 8;
  const backtickCount = (text: string): number => (text.match(/`/g) ?? []).length;
  return lines.map((line, lineIndex) => {
    let text = line;
    for (let joined = 0; joined < MAX_JOINED_LINES && backtickCount(text) % 2 === 1; joined++) {
      const nextLine = lines[lineIndex + joined + 1];
      if (nextLine === undefined) break;
      text += `\n${nextLine}`;
    }
    return { text, lineIndex };
  });
}

const HOOK_CALL = 'usePopoverPosition(';
/** The hook's own definition, which is not a call site. */
const HOOK_DEFINITION_FILE = path.join(RENDERER_DIR, 'hooks', 'usePopoverPosition.ts');

/**
 * Byte offsets of `usePopoverPosition` calls that ask for `mode: 'dropdown'`
 * without `strategy: 'fixed'` - i.e. the hook writes `top: 100%` / `bottom: 100%`
 * imperatively and the menu stays in flow, clipped by any ancestor overflow.
 *
 * Balanced-paren extraction rather than a per-line regex, because these calls are
 * routinely spread over five or six lines.
 */
function dropdownCallOffsetsMissingFixedStrategy(fileText: string): number[] {
  const offsets: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const callIndex = fileText.indexOf(HOOK_CALL, searchFrom);
    if (callIndex === -1) break;
    searchFrom = callIndex + HOOK_CALL.length;

    const openParenIndex = callIndex + HOOK_CALL.length - 1;
    let depth = 0;
    let closeParenIndex = -1;
    for (let scan = openParenIndex; scan < fileText.length; scan++) {
      if (fileText[scan] === '(') depth++;
      else if (fileText[scan] === ')' && --depth === 0) {
        closeParenIndex = scan;
        break;
      }
    }
    if (closeParenIndex === -1) continue;

    const callText = fileText.slice(callIndex, closeParenIndex + 1);
    if (!/mode:\s*['"]dropdown['"]/.test(callText)) continue;
    if (/strategy:\s*['"]fixed['"]/.test(callText)) continue;
    offsets.push(callIndex);
  }
  return offsets;
}

function hasOptOut(lines: string[], lineIndex: number): boolean {
  const start = Math.max(0, lineIndex - MARKER_LOOKBEHIND);
  return lines.slice(start, lineIndex + 1).some((line) => line.includes(OPT_OUT_MARKER));
}

const inFlowClassOffenders: string[] = [];
const inFlowDropdownCallOffenders: string[] = [];

for (const filePath of collectSourceFiles(RENDERER_DIR)) {
  const fileText = fs.readFileSync(filePath, 'utf-8');
  const lines = fileText.split('\n');
  const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');

  for (const { text, lineIndex } of scannableChunks(lines)) {
    if (!classStringsOn(text).some(isInFlowScrollableMenu)) continue;
    if (hasOptOut(lines, lineIndex)) continue;
    inFlowClassOffenders.push(`${relativePath}:${lineIndex + 1}`);
  }

  if (filePath === HOOK_DEFINITION_FILE) continue;
  for (const offset of dropdownCallOffsetsMissingFixedStrategy(fileText)) {
    const lineIndex = fileText.slice(0, offset).split('\n').length - 1;
    if (hasOptOut(lines, lineIndex)) continue;
    inFlowDropdownCallOffenders.push(`${relativePath}:${lineIndex + 1}`);
  }
}

describe('in-flow scrollable popover menus (clipping regression guard)', () => {
  it('renders every scrollable menu through a portal, not an in-flow absolute box', () => {
    expect(
      inFlowClassOffenders,
      `These elements position themselves in flow (absolute top-full / bottom-full) AND scroll or cap their own height, so an ancestor's overflow clip will cut them off.\n`
        + `Portal them instead: OverlayPopover with the \`portal\` prop plus usePopoverPosition({ strategy: 'fixed' }) - see src/renderer/components/dialogs/ModelCombobox.tsx.\n`
        + `If the element genuinely has no clipping ancestor at any mount site, add a "${OPT_OUT_MARKER} <reason>" comment on the line or just above it.\n\n`
        + inFlowClassOffenders.join('\n'),
    ).toEqual([]);
  });

  it('positions every dropdown-mode popover with the fixed strategy', () => {
    expect(
      inFlowDropdownCallOffenders,
      `These usePopoverPosition calls ask for mode: 'dropdown' without strategy: 'fixed', so the hook writes top/bottom: 100% imperatively and the menu stays IN FLOW - clipped by any ancestor overflow: hidden / overflow-y-auto, no matter how high its z-index.\n`
        + `This is the shape a class-string scan cannot see (there is no \`top-full\` class to match), and it was the pre-fix shape of most of the popovers .claude/rules/popover-escapes-clipping.md was written for.\n`
        + `Pass { mode: 'dropdown', strategy: 'fixed' } and render through OverlayPopover's \`portal\` prop - see src/renderer/components/dialogs/ModelCombobox.tsx.\n`
        + `If the popover genuinely has no clipping ancestor at any mount site, add a "${OPT_OUT_MARKER} <reason>" comment on the call line or just above it.\n\n`
        + inFlowDropdownCallOffenders.join('\n'),
    ).toEqual([]);
  });

  it('exempts flyout mode, whose positioning ignores the strategy option', () => {
    // The hook reads `strategy` only inside its `mode === 'dropdown'` branch, so a
    // flyout is positioned against its parent regardless and must already live
    // inside a portaled parent. Flagging flyouts would be pure noise.
    expect(
      dropdownCallOffsetsMissingFixedStrategy(
        `const { placement } = usePopoverPosition(triggerRef, flyoutRef, open, { mode: 'flyout' });`,
      ),
    ).toEqual([]);
  });

  it('actually matches the shape it is meant to catch', () => {
    // Self-check: the pre-fix ModelCombobox class string must trip the predicate,
    // so a future refactor of `isInFlowScrollableMenu` cannot silently neuter it.
    expect(
      isInFlowScrollableMenu(
        'absolute top-full left-0 right-0 mt-1 bg-surface-raised border border-edge rounded shadow-lg z-50 max-h-48 overflow-y-auto',
      ),
    ).toBe(true);
    // A portaled menu (fixed, not absolute) must not trip it.
    expect(
      isInFlowScrollableMenu(
        'fixed z-[2147483646] bg-surface-raised border border-edge rounded shadow-lg max-h-48 overflow-y-auto',
      ),
    ).toBe(false);
    // A small in-flow tooltip with no scroll and no height cap must not trip it.
    expect(
      isInFlowScrollableMenu('absolute top-full left-0 mt-1.5 px-2.5 py-1.5 whitespace-nowrap z-50'),
    ).toBe(false);
  });

  it('sees the static tokens of a multi-line interpolated className', () => {
    // BranchPicker.tsx writes its className as a template literal wrapped across
    // lines, with an inner ternary whose own quotes terminate a naive match. The
    // static Tailwind tokens live on the FIRST line, which carries a single
    // unmatched backtick - so a per-line, quote-delimited scan silently drops the
    // only part that matters. Both defects have to stay fixed together for the
    // class scan to mean anything on this codebase's dominant className style.
    const multiLineClassName = [
      "        className={`absolute top-full mt-1 bg-surface-raised shadow-xl overflow-y-auto ${",
      "          variant === 'input' ? 'left-0 right-0' : 'w-64'",
      '        }`}',
    ];
    const [firstChunk] = scannableChunks(multiLineClassName);
    expect(classStringsOn(firstChunk.text).some(isInFlowScrollableMenu)).toBe(true);
  });

  it('flags a dropdown-mode call that omits the fixed strategy', () => {
    // The real pre-fix ToolBreakdownPopover call: a scrollable, height-capped menu
    // that the class scan could never see, because `usePopoverPosition` wrote its
    // offsets imperatively and the className carried no `top-full`.
    expect(
      dropdownCallOffsetsMissingFixedStrategy(
        [
          '  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, {',
          "    mode: 'dropdown',",
          "    preferVertical: 'above',",
          '  });',
        ].join('\n'),
      ),
    ).toHaveLength(1);

    // ...and the post-fix call must not trip it.
    expect(
      dropdownCallOffsetsMissingFixedStrategy(
        [
          '  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, {',
          "    mode: 'dropdown',",
          "    strategy: 'fixed',",
          "    preferVertical: 'above',",
          '  });',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

/**
 * The flip-above decision must be made from the popover's UNTRANSFORMED size.
 *
 * `OverlayPopover` plays a grow-in animation starting at `transform:
 * scale(0.96)`, and `usePopoverPosition`'s layout effect runs on the commit that
 * mounts it. `getBoundingClientRect()` reports the TRANSFORMED box, so the
 * popover measured ~4% short and, on a marginal fit, the hook concluded "fits
 * below" for a menu that then painted at full size and ran off the bottom of the
 * screen. `offsetWidth` / `offsetHeight` are layout dimensions and ignore
 * transforms.
 *
 * A static scan on purpose. Reproducing the bug through the DOM requires the
 * trigger to land inside the ~12px window where a 4% error flips the decision,
 * and a test tuned to a 12px window is exactly the pixel-fragile kind
 * `.claude/rules/cross-platform-parity.md` forbids. The user-facing invariant (a
 * too-tall dropdown stays on screen) is covered behaviorally by
 * `tests/ui/popover-viewport-flip.spec.ts`; this pins the mechanism that spec
 * cannot isolate.
 */
describe('usePopoverPosition measures the popover without its entrance transform', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src/renderer/hooks/usePopoverPosition.ts'),
    'utf-8',
  );

  it('reads the popover size from offsetWidth / offsetHeight', () => {
    expect(source).toMatch(/const popoverWidth = popover\.offsetWidth/);
    expect(source).toMatch(/const popoverHeight = popover\.offsetHeight/);
  });

  it('never measures the popover element with getBoundingClientRect', () => {
    // The TRIGGER still needs a rect: it supplies viewport coordinates, which
    // offsetTop/offsetLeft cannot. Only the popover's own size is at issue.
    const popoverRectReads = source.match(/popover\.getBoundingClientRect\(\)/g) ?? [];
    expect(popoverRectReads).toEqual([]);
    expect(source).toMatch(/trigger\.getBoundingClientRect\(\)/);
  });
});
