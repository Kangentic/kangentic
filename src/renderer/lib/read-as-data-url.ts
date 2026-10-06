/**
 * A Blob as a `data:` URL. It needs only FileReader, so the pixel-diff worker
 * uses it as well as the renderer, and a data URL never has to be revoked the
 * way an object URL does.
 */
export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the blob'));
    reader.readAsDataURL(blob);
  });
}
