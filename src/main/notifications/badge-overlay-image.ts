/**
 * The Windows taskbar overlay: a count drawn as an image, since `setOverlayIcon`
 * takes no text. Windows has no badge API an installed desktop app can use, and
 * it places the overlay itself. The API takes no position: Microsoft's guide says
 * lower right, and Windows 11 build 26200 draws it top right (measured on a taskbar).
 *
 * Main has no canvas, so the main window's renderer draws it, as Mattermost's
 * desktop app does. Nothing here needs a file: a real bold font renders each label
 * crisply, where a pixel font scaled up did not.
 */
import { nativeImage, type NativeImage, type WebContents } from 'electron';

export const BADGE_FILL = '#e81123';

/**
 * The overlay is 16 pixels, so a count past 9 reads as 9+. Null means no overlay.
 */
export function overlayLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}

/**
 * Draws one label at 16 and 32 pixels. The shapes come in 16 pixel units and keep a
 * transparent margin: a shape drawn to the edge has its outer pixels cut when
 * Windows scales it, which flattens a pill's ends. A digit sits in a circle; 9+ is
 * too wide for one at this size, so it sits in a pill, as a macOS Dock badge widens.
 */
export function overlayDrawScript(label: string): string {
  const wide = label.length > 1;
  return `(() => {
    const draw = (size) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      context.scale(size / 16, size / 16);
      context.fillStyle = ${JSON.stringify(BADGE_FILL)};
      context.beginPath();
      ${wide ? 'context.roundRect(0.5, 2, 15, 12, 6);' : 'context.arc(8, 8, 7.5, 0, Math.PI * 2);'}
      context.fill();
      context.fillStyle = '#ffffff';
      context.font = '700 ${wide ? '9.5' : '11'}px "Segoe UI", sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';
      context.fillText(${JSON.stringify(label)}, 8, ${wide ? '11.3' : '12'});
      return canvas.toDataURL('image/png');
    };
    return [draw(16), draw(32)];
  })()`;
}

const overlayImages = new Map<string, NativeImage>();

/** One label is drawn once. */
export async function loadOverlayImage(webContents: WebContents, label: string): Promise<NativeImage> {
  const cached = overlayImages.get(label);
  if (cached) return cached;
  const [standardDataUrl, doubleDataUrl] = await webContents.executeJavaScript(overlayDrawScript(label)) as [string, string];
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: standardDataUrl });
  image.addRepresentation({ scaleFactor: 2, dataURL: doubleDataUrl });
  overlayImages.set(label, image);
  return image;
}
