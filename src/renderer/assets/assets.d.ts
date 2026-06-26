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

// Vite `?raw` suffix: inlines the referenced file's contents as a string. Used
// to load the AudioWorklet processor source and register it via a Blob URL,
// which `audioWorklet.addModule` supports reliably across platforms.
declare module '*?raw' {
  const content: string;
  export default content;
}
