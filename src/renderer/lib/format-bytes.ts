/** Bytes as the size a person would say out loud. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes / 1024 / 1024;
  if (megabytes < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (megabytes < 1024) return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
  return `${(megabytes / 1024).toFixed(2)} GB`;
}
