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

export const ALL_RESOLUTIONS: Resolution[] = [hero, inline, thumbnail];
