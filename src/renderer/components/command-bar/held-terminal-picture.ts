/**
 * The picture a Command Terminal's resize veil holds while the terminal jumps
 * size (Expand, Restore, and the panel falling back to one expanded terminal).
 *
 * The veil used to be the terminal's background color, so every jump showed
 * each terminal black for 190 to 500 ms, until the agent had repainted at the
 * new size (`resize-veil.ts`). Now the layer takes one picture of the terminal
 * area just BEFORE the layout changes (`window:captureRegion`, as the swap drag
 * does), and each terminal's veil shows its own part of it, at its real size
 * and anchored at the terminal's top-left. The text stays where it was, only a
 * strip the terminal grew into shows background, and the live terminal fades
 * in over it once the agent's frame has landed.
 *
 * A terminal hidden behind an expanded one is not on screen, so a capture
 * cannot see it. Each terminal's last picture is kept, so one coming out from
 * behind (Restore) shows the frame it had when it was hidden, which is what the
 * user last saw of it. A terminal that was on screen but whose capture failed
 * gets the plain veil, never an older picture of itself. So does a jump that
 * did not come through here (the swap drag keeps its own picture).
 */

export interface HeldTerminalPicture {
  /** The captured terminal area, as a data URL. */
  url: string;
  /** The captured area's size, in CSS pixels. */
  areaWidth: number;
  areaHeight: number;
  /** Where this terminal's pane sat inside the captured area, in CSS pixels. */
  offsetX: number;
  offsetY: number;
}

interface PendingJump {
  at: number;
  /** The terminals on screen when the picture was taken. */
  visible: Set<string>;
  pictures: Map<string, HeldTerminalPicture>;
}

/**
 * How long a jump waits for the picture before it goes ahead without one. A
 * capture measured 51 ms (the swap drag's `PICTURE_WAIT_MS` has the same bound):
 * a window that is not compositing may never answer, and Expand must not hang.
 */
const PICTURE_WAIT_MS = 300;

/** A jump's pictures are for the commit that applies it, a frame or two later. */
const JUMP_PICTURES_LIVE_MS = 250;

// hmr-safe: the jump being painted now; a reset on HMR loses at most one jump's pictures.
let pendingJump: PendingJump | null = null;
// hmr-safe: each terminal's last picture; a reset on HMR leaves the next hidden terminal on the plain veil.
const lastPicture = new Map<string, HeldTerminalPicture>();

async function captureWithin(box: DOMRect): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PICTURE_WAIT_MS); });
  try {
    return await Promise.race([
      window.electronAPI.window.captureRegion({ x: box.left, y: box.top, width: box.width, height: box.height }),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Take the picture each visible terminal will hold, then `apply` the layout
 * change. `apply` runs whether or not a picture came back.
 */
export async function holdTerminalPicturesThen(apply: () => void): Promise<void> {
  const visible = new Set<string>();
  const pictures = new Map<string, HeldTerminalPicture>();
  const area = document.querySelector<HTMLElement>('[data-testid="command-terminal-area"]');
  if (area) {
    const areaBox = area.getBoundingClientRect();
    const panes: Array<{ sessionId: string; box: DOMRect }> = [];
    for (const pane of area.querySelectorAll<HTMLElement>('[data-testid="command-bar-terminal-pane"]')) {
      const sessionId = pane.getAttribute('data-session-id');
      // Behind an expanded terminal: in the DOM, not in the picture.
      if (!sessionId || pane.closest('[aria-hidden="true"]')) continue;
      const box = pane.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      visible.add(sessionId);
      panes.push({ sessionId, box });
    }
    const url = panes.length > 0 ? await captureWithin(areaBox) : null;
    if (url) {
      for (const { sessionId, box } of panes) {
        const picture: HeldTerminalPicture = {
          url,
          areaWidth: areaBox.width,
          areaHeight: areaBox.height,
          offsetX: box.left - areaBox.left,
          offsetY: box.top - areaBox.top,
        };
        pictures.set(sessionId, picture);
        lastPicture.set(sessionId, picture);
      }
    }
  }
  pendingJump = { at: performance.now(), visible, pictures };
  apply();
}

/**
 * The picture `sessionId`'s veil holds for the jump now being painted: the one
 * taken just before it, or the terminal's last one if it was hidden then. Null
 * when no jump came through `holdTerminalPicturesThen` just now.
 */
export function takeHeldTerminalPicture(sessionId: string): HeldTerminalPicture | null {
  if (!pendingJump || performance.now() - pendingJump.at > JUMP_PICTURES_LIVE_MS) return null;
  if (pendingJump.visible.has(sessionId)) return pendingJump.pictures.get(sessionId) ?? null;
  return lastPicture.get(sessionId) ?? null;
}

/** Drop a terminal's picture when its pane goes away. */
export function forgetHeldTerminalPicture(sessionId: string): void {
  lastPicture.delete(sessionId);
}
