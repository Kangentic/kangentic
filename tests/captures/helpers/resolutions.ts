export interface Resolution {
  name: string;
  viewport: { width: number; height: number };
  scale: number;
}

export const hero: Resolution = {
  name: 'hero',
  viewport: { width: 1920, height: 1080 },
  scale: 2,
};

/**
 * The site's frame (demo/stage.html), which every scene is authored at and every terminal
 * recording was made for: at this size the byte streams replay into the grid they were recorded
 * against, so a scene still is exactly what the site embeds, at 2x.
 */
export const frame: Resolution = {
  name: 'frame',
  viewport: { width: 1600, height: 1000 },
  scale: 2,
};

/**
 * kangentic.com's landing-page hero: the board in an iframe 1600 by 940, the frame without the
 * last 60px. Shot at 1x and 2x for the poster set's `hero` entry (hero.capture.ts), since the hero
 * serves both from its srcset. Not `hero` above, which is the marketing video's 1080p.
 */
export const heroStill: Resolution = {
  name: 'hero-still',
  viewport: { width: 1600, height: 940 },
  scale: 1,
};

export const heroStill2x: Resolution = {
  name: 'hero-still-2x',
  viewport: { width: 1600, height: 940 },
  scale: 2,
};

export const inline: Resolution = {
  name: 'inline',
  viewport: { width: 1024, height: 768 },
  scale: 2,
};

export const thumbnail: Resolution = {
  name: 'thumbnail',
  viewport: { width: 640, height: 480 },
  scale: 2,
};
