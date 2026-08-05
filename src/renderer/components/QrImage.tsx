import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrImageProps {
  /** The string to encode (any URL or URI). */
  value: string;
  /** Accessible description of what scanning the code reaches. */
  alt: string;
  /** Rendered square size in px. */
  size?: number;
  testId?: string;
}

/**
 * A QR code rendered as a data-URL <img>, for links meant to be scanned with
 * a phone (mobile pairing, store opt-in pages, announcement links). Renders
 * nothing until the encode resolves, so callers never see a broken image.
 */
export function QrImage({ value, alt, size = 220, testId }: QrImageProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    QRCode.toDataURL(value, { margin: 1, width: size })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch((error: unknown) => {
        // Fail closed to "no image": a value that exceeds QR capacity (e.g. an
        // over-long feed URL) must not surface as an unhandled rejection, and
        // every caller renders a labeled link beside the QR, so the
        // destination stays reachable without it.
        console.warn('[QrImage] encode failed:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!qrDataUrl) return null;
  return (
    <img
      src={qrDataUrl}
      alt={alt}
      width={size}
      height={size}
      className="rounded-md border border-edge"
      data-testid={testId}
    />
  );
}
