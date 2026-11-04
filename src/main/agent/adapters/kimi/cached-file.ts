import fs from 'node:fs';

/**
 * A reader of a parsed text file that reads and parses again only when the
 * file's size or mtime changed, and answers `empty` when it cannot be read. For
 * a small file an adapter asks about often and the CLI writes rarely: the id
 * capture polls the session index once a second, and every window of a
 * transcript walk looks its session up there.
 *
 * Stat before read, so an append that lands in between reads as changed next
 * time. A file caught mid-append parses without its torn last line, and the
 * finished append changes the size.
 */
export function cachedFileReader<Value>(parse: (text: string) => Value, empty: Value): (filePath: string) => Value {
  const cache = new Map<string, { size: number; mtimeMs: number; value: Value }>();
  return (filePath) => {
    try {
      const { size, mtimeMs } = fs.statSync(filePath);
      const cached = cache.get(filePath);
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.value;
      const value = parse(fs.readFileSync(filePath, 'utf-8'));
      cache.set(filePath, { size, mtimeMs, value });
      return value;
    } catch {
      cache.delete(filePath);
      return empty;
    }
  };
}
