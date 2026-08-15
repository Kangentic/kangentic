/**
 * Calibration harness for compressClipboardImage.
 *
 * Sweeps long-edge target x quality across synthetic 1080p, 1440p (2K), and
 * 4K noise screenshots and prints a results table. Use this to re-tune
 * IMAGE_LONG_EDGE_CAP (src/shared/image-fidelity.ts) / TARGET_BYTES /
 * QUALITY_LADDER when monitor sizes shift or the Anthropic vision API budget
 * changes.
 *
 * Skipped by default because it takes ~20s. Run with:
 *   CALIBRATE_IMAGE_COMPRESS=1 npx playwright test --project=ui tests/ui/image-compress-calibration.spec.ts
 *
 * The harness imports the internal compressImage pure pipeline from
 * src/renderer/components/dialogs/image-compress.ts so the numbers reflect
 * exactly what the production helper will produce.
 */
import { test } from '@playwright/test';
import { launchPage } from './helpers';

// Brackets the shipped IMAGE_LONG_EDGE_CAP (2000) so a sweep can see one rung
// either side of it, rather than topping out below the value it exists to tune.
const LONG_EDGES = [1568, 2000, 2400];
const QUALITIES = [0.85, 0.75, 0.6];
const RESOLUTIONS = [
  { name: '1080p', width: 1920, height: 1080 },
  { name: '2K', width: 2560, height: 1440 },
  { name: '4K', width: 3840, height: 2160 },
];

interface ImageCompressModule {
  compressImage: (input: File, options: { longEdge: number; quality: number }) => Promise<Blob>;
}

test.describe('image-compress calibration', () => {
  test.skip(!process.env.CALIBRATE_IMAGE_COMPRESS, 'Set CALIBRATE_IMAGE_COMPRESS=1 to run');

  test('sweep long-edge x quality across 1080p/2K/4K noise screenshots', async () => {
    const { browser, page } = await launchPage();
    try {
      const results = await page.evaluate(
        async ({ longEdges, qualities, resolutions }) => {
          const mod = await import(
            '/src/renderer/components/dialogs/image-compress.ts'
          );
          const compressImage = (mod as ImageCompressModule).compressImage;

          /** Build a noise PNG of the given dimensions. Math.random() per pixel
           *  defeats PNG's run-length compression so the source size approximates
           *  worst-case real-screenshot density. */
          async function makeNoisePng(width: number, height: number): Promise<File> {
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('no 2d context');
            const data = ctx.createImageData(width, height);
            for (let index = 0; index < data.data.length; index += 4) {
              data.data[index + 0] = Math.floor(Math.random() * 256);
              data.data[index + 1] = Math.floor(Math.random() * 256);
              data.data[index + 2] = Math.floor(Math.random() * 256);
              data.data[index + 3] = 255;
            }
            ctx.putImageData(data, 0, 0);
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            return new File([blob], 'noise.png', { type: 'image/png' });
          }

          const rows: Array<{ resolution: string; sourceBytes: number; longEdge: number; quality: number; outputBytes: number }> = [];
          for (const res of resolutions) {
            const file = await makeNoisePng(res.width, res.height);
            for (const longEdge of longEdges) {
              for (const quality of qualities) {
                const blob = await compressImage(file, { longEdge, quality });
                rows.push({
                  resolution: res.name,
                  sourceBytes: file.size,
                  longEdge,
                  quality,
                  outputBytes: blob.size,
                });
              }
            }
          }
          return rows;
        },
        { longEdges: LONG_EDGES, qualities: QUALITIES, resolutions: RESOLUTIONS },
      );

      console.log('\n=== Image compression calibration ===');
      console.log('Source image: synthetic random-pixel noise (worst case for compression)');
      console.log('All output sizes are the encoded WebP blob (pre-base64).\n');
      const formatBytes = (bytes: number): string => {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / 1024).toFixed(0)} KB`;
      };
      const seenSources = new Set<string>();
      for (const row of results) {
        if (!seenSources.has(row.resolution)) {
          console.log(`\n${row.resolution} source PNG: ${formatBytes(row.sourceBytes)}`);
          seenSources.add(row.resolution);
        }
        const fitsTarget = row.outputBytes <= 1.5 * 1024 * 1024 ? '<=1.5MB' : '>1.5MB';
        console.log(
          `  longEdge=${row.longEdge.toString().padStart(4)}  quality=${row.quality.toFixed(2)}  ->  ${formatBytes(row.outputBytes).padStart(9)}  ${fitsTarget}`,
        );
      }
      console.log('\nDecision rule: pick the smallest longEdge that keeps all 3 resolutions under 1.5MB at quality 0.85.\n');
    } finally {
      await browser.close();
    }
  });
});
