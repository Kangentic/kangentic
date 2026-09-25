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
