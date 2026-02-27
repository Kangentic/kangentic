import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { TaskAttachment } from '../../../shared/types';

export class AttachmentRepository {
  constructor(private db: Database.Database) {}

  list(taskId: string): TaskAttachment[] {
    return this.db.prepare(
      'SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as TaskAttachment[];
  }

  getById(id: string): TaskAttachment | undefined {
    return this.db.prepare(
      'SELECT * FROM task_attachments WHERE id = ?'
    ).get(id) as TaskAttachment | undefined;
  }

  add(
    projectPath: string,
    taskId: string,
    filename: string,
    base64Data: string,
    mediaType: string,
  ): TaskAttachment {
    const id = uuidv4();
    const now = new Date().toISOString();

    // Sanitize filename: keep only safe characters
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const diskName = `${id}_${sanitized}`;

    const attachDir = path.join(projectPath, '.kangentic', 'tasks', taskId, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const filePath = path.join(attachDir, diskName);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);

    const attachment: TaskAttachment = {
      id,
      task_id: taskId,
      filename,
      file_path: filePath,
      media_type: mediaType,
      size_bytes: buffer.length,
      created_at: now,
    };

    this.db.prepare(`
      INSERT INTO task_attachments (id, task_id, filename, file_path, media_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(attachment.id, attachment.task_id, attachment.filename, attachment.file_path, attachment.media_type, attachment.size_bytes, attachment.created_at);

    return attachment;
  }

  remove(id: string): void {
    const attachment = this.getById(id);
    if (!attachment) return;

    // Delete file from disk
    try {
      fs.unlinkSync(attachment.file_path);
    } catch { /* file may already be gone */ }

    this.db.prepare('DELETE FROM task_attachments WHERE id = ?').run(id);
  }

  deleteByTaskId(taskId: string): void {
    const attachments = this.list(taskId);
    for (const attachment of attachments) {
      try {
        fs.unlinkSync(attachment.file_path);
      } catch { /* file may already be gone */ }
    }

    this.db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(taskId);

    // Try to clean up the empty attachments directory
    if (attachments.length > 0) {
      try {
        const dir = path.dirname(attachments[0].file_path);
        fs.rmdirSync(dir);
        // Also try to remove the parent tasks/<taskId> directory if empty
        fs.rmdirSync(path.dirname(dir));
      } catch { /* not empty or doesn't exist */ }
    }
  }

  getPathsForTask(taskId: string): string[] {
    const rows = this.db.prepare(
      'SELECT file_path FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  getDataUrl(id: string): string {
    const attachment = this.getById(id);
    if (!attachment) throw new Error(`Attachment ${id} not found`);

    const buffer = fs.readFileSync(attachment.file_path);
    const base64 = buffer.toString('base64');
    return `data:${attachment.media_type};base64,${base64}`;
  }
}
