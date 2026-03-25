import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { BacklogAttachment } from '../../../shared/types';

export class BacklogAttachmentRepository {
  constructor(private db: Database.Database) {}

  list(backlogTaskId: string): BacklogAttachment[] {
    return this.db.prepare(
      'SELECT * FROM backlog_attachments WHERE backlog_task_id = ? ORDER BY created_at ASC'
    ).all(backlogTaskId) as BacklogAttachment[];
  }

  getById(id: string): BacklogAttachment | undefined {
    return this.db.prepare(
      'SELECT * FROM backlog_attachments WHERE id = ?'
    ).get(id) as BacklogAttachment | undefined;
  }

  add(
    projectPath: string,
    backlogTaskId: string,
    filename: string,
    base64Data: string,
    mediaType: string,
  ): BacklogAttachment {
    const id = uuidv4();
    const now = new Date().toISOString();

    // Sanitize filename: keep only safe characters
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const diskName = `${id}_${sanitized}`;

    const attachDir = path.join(projectPath, '.kangentic', 'backlog', backlogTaskId, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const filePath = path.join(attachDir, diskName);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);

    const attachment: BacklogAttachment = {
      id,
      backlog_task_id: backlogTaskId,
      filename,
      file_path: filePath,
      media_type: mediaType,
      size_bytes: buffer.length,
      created_at: now,
    };

    this.db.prepare(`
      INSERT INTO backlog_attachments (id, backlog_task_id, filename, file_path, media_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(attachment.id, attachment.backlog_task_id, attachment.filename, attachment.file_path, attachment.media_type, attachment.size_bytes, attachment.created_at);

    this.syncAttachmentCount(backlogTaskId);

    return attachment;
  }

  remove(id: string): void {
    const attachment = this.getById(id);
    if (!attachment) return;

    try {
      fs.unlinkSync(attachment.file_path);
    } catch { /* file may already be gone */ }

    this.db.prepare('DELETE FROM backlog_attachments WHERE id = ?').run(id);
    this.syncAttachmentCount(attachment.backlog_task_id);
  }

  deleteByTaskId(backlogTaskId: string): void {
    const attachments = this.list(backlogTaskId);
    for (const attachment of attachments) {
      try {
        fs.unlinkSync(attachment.file_path);
      } catch { /* file may already be gone */ }
    }

    this.db.prepare('DELETE FROM backlog_attachments WHERE backlog_task_id = ?').run(backlogTaskId);
    this.syncAttachmentCount(backlogTaskId);

    // Try to clean up the empty attachments directory
    if (attachments.length > 0) {
      try {
        const dir = path.dirname(attachments[0].file_path);
        fs.rmdirSync(dir);
        // Also try to remove the parent backlog/<taskId> directory if empty
        fs.rmdirSync(path.dirname(dir));
      } catch { /* not empty or doesn't exist */ }
    }
  }

  getPathsForTask(backlogTaskId: string): string[] {
    const rows = this.db.prepare(
      'SELECT file_path FROM backlog_attachments WHERE backlog_task_id = ? ORDER BY created_at ASC'
    ).all(backlogTaskId) as Array<{ file_path: string }>;
    return rows.map((row) => row.file_path);
  }

  getDataUrl(id: string): string {
    const attachment = this.getById(id);
    if (!attachment) throw new Error(`Backlog attachment ${id} not found`);

    const buffer = fs.readFileSync(attachment.file_path);
    const base64 = buffer.toString('base64');
    return `data:${attachment.media_type};base64,${base64}`;
  }

  /** Keep backlog_tasks.attachment_count in sync with actual attachment rows. */
  private syncAttachmentCount(backlogTaskId: string): void {
    const count = (this.db.prepare(
      'SELECT COUNT(*) as c FROM backlog_attachments WHERE backlog_task_id = ?'
    ).get(backlogTaskId) as { c: number }).c;
    this.db.prepare(
      'UPDATE backlog_tasks SET attachment_count = ? WHERE id = ?'
    ).run(count, backlogTaskId);
  }
}
