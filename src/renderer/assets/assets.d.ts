declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

// Vite `?url` suffix: emits the referenced file as a hashed static asset and
// resolves to its URL string.
declare module '*?url' {
  const url: string;
  export default url;
}

// Vite `?raw` suffix: inlines the referenced file's contents as a string. Three uses:
// the AudioWorklet processor source, registered via a Blob URL because
// `audioWorklet.addModule` supports that reliably across platforms; and the branding
// brandmark (`BrandMark.tsx`) and activity marks (`ActivityMark.tsx`), inlined so their
// strokes inherit `currentColor` instead of being opaque `<img>` pixels.
declare module '*?raw' {
  const content: string;
  export default content;
}
