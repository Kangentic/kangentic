/**
 * Shared attachment on-disk naming.
 *
 * Both AttachmentRepository and BacklogAttachmentRepository write a file's
 * disk name as `attachmentDiskName(id, filename)` while keeping the ORIGINAL
 * (unsanitized) filename in the DB row for display. Reads go through the
 * stored absolute `file_path`, so this is a NAME BUILDER, not a lookup key:
 * its other caller, the attachment-open helper's Windows temp copy, uses it
 * to name a fresh destination file. Keeping one builder is still what makes
 * the temp copy carry the same extension the OS picks a default app from.
 */

/** Keep only characters safe across Windows/macOS/Linux filesystems. */
export function sanitizeAttachmentFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Longest single path component NTFS, APFS, and ext4 all accept. Board
 * imports name attachments from a remote URL path or issue alt text, neither
 * of which is length-bounded, so an over-long name has to be trimmed here
 * rather than thrown at `fs.writeFileSync`.
 */
const MAX_DISK_NAME_LENGTH = 255;

/** The on-disk filename for an attachment: `${id}_${sanitized filename}`. */
export function attachmentDiskName(id: string, filename: string): string {
  const diskName = `${id}_${sanitizeAttachmentFilename(filename)}`;
  if (diskName.length <= MAX_DISK_NAME_LENGTH) return diskName;

  // Trim the middle, not the tail: the extension is what the OS reads to pick
  // a default application, so it is the one part that has to survive.
  const extension = trailingExtension(diskName);
  return diskName.slice(0, MAX_DISK_NAME_LENGTH - extension.length) + extension;
}

/** The trailing `.ext` of a disk name, or '' when there is no usable one. */
function trailingExtension(diskName: string): string {
  const dotIndex = diskName.lastIndexOf('.');
  if (dotIndex < 0) return '';
  const extension = diskName.slice(dotIndex);
  // An "extension" long enough to crowd out the name is not worth keeping.
  return extension.length > 16 ? '' : extension;
}
