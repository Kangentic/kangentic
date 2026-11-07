// Packs a folder into a .tar.gz whose bytes depend only on the folder's names and contents.
//
// The host asset's SHA-256 is pinned in the manifest that ships inside the app, and the archive itself
// is uploaded to the release by a different job. A rebuild (a re-run of the release workflow) must
// therefore produce the same bytes, or an app already in users' hands would reject the archive on the
// release as corrupt. `tar -czf` cannot promise that: entry order follows the directory listing,
// every header carries the file's mtime, and the owner is whoever ran it.
//
// So this writes the tar itself: entries sorted by path, one fixed mtime, owner root, modes 0644 for
// a file and 0755 for a folder (the host's installer sets the execute bits it needs), then gzip with
// no name or time in the header and one fixed OS byte. Symbolic links are refused rather than
// followed or dropped, since the asset is built without any.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 2020-01-01T00:00:00Z. Not 0: GNU tar warns that a 1970 time stamp is implausibly old. */
const FIXED_MTIME_SECONDS = 1577836800;
const BLOCK = 512;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** Splits a path across the ustar name (100 bytes) and prefix (155 bytes) fields. */
function splitName(entryPath) {
  const bytes = Buffer.byteLength(entryPath);
  if (bytes <= 100) return { name: entryPath, prefix: '' };
  for (let index = entryPath.indexOf('/'); index !== -1; index = entryPath.indexOf('/', index + 1)) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`${entryPath} is too long for a tar header (${bytes} bytes; 100 for the name, 155 more for its folders).`);
}

function header({ entryPath, size, isDirectory }) {
  const block = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(isDirectory ? `${entryPath}/` : entryPath);
  block.write(name, 0, 'utf8');
  block.write(octal(isDirectory ? 0o755 : 0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(FIXED_MTIME_SECONDS, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii'); // the checksum is summed with this field as eight spaces
  block.write(isDirectory ? '5' : '0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write('root', 265, 'ascii');
  block.write('root', 297, 'ascii');
  block.write(prefix, 345, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** Every file and folder under a root, as sorted `/`-separated paths relative to it. */
function listEntries(rootDirectory) {
  const entries = [];
  const visit = (relative) => {
    for (const dirent of fs.readdirSync(path.join(rootDirectory, relative), { withFileTypes: true })) {
      const entryPath = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) throw new Error(`${entryPath} is a symbolic link. The host asset carries none, so something added one.`);
      if (dirent.isDirectory()) {
        entries.push({ entryPath, isDirectory: true });
        visit(entryPath);
      } else if (dirent.isFile()) {
        entries.push({ entryPath, isDirectory: false });
      } else {
        throw new Error(`${entryPath} is neither a file nor a folder.`);
      }
    }
  };
  visit('');
  // Code-unit order, not locale order: the same list on every machine.
  return entries.sort((left, right) => (left.entryPath < right.entryPath ? -1 : left.entryPath > right.entryPath ? 1 : 0));
}

/** The archive's bytes for a folder. */
export function packDirectory(rootDirectory) {
  const parts = [];
  for (const { entryPath, isDirectory } of listEntries(rootDirectory)) {
    if (isDirectory) {
      parts.push(header({ entryPath, size: 0, isDirectory }));
      continue;
    }
    const content = fs.readFileSync(path.join(rootDirectory, entryPath));
    parts.push(header({ entryPath, size: content.length, isDirectory }), content);
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  const compressed = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  // zlib writes the OS it was built for into byte 9 (11 on Windows, 3 elsewhere). Fixed, so the
  // archive is the same whichever machine built it.
  compressed[9] = 3;
  return compressed;
}

/** Writes the archive for a folder to a file. */
export function packDirectoryToFile(rootDirectory, destination) {
  const bytes = packDirectory(rootDirectory);
  fs.writeFileSync(destination, bytes);
  return bytes;
}
