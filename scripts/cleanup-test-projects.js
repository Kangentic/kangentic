/**
 * Remove test projects from the global index DB.
 * Keeps only projects whose name does NOT contain typical test patterns.
 * Run via: npx electron scripts/cleanup-test-projects.js
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.env.APPDATA || '', 'kangentic', 'index.db');
if (!fs.existsSync(dbPath)) {
  console.log('No index.db found at', dbPath);
  process.exit(0);
}

const db = new Database(dbPath);
const projects = db.prepare('SELECT id, name FROM projects ORDER BY name').all();

// Keep only explicitly named real projects; delete everything else.
// Pass project names to keep as CLI args, or default to 'kangentic'.
const keepNames = process.argv.slice(2);
if (keepNames.length === 0) keepNames.push('kangentic');

const toKeep = projects.filter(p =>
  keepNames.some(name => p.name.toLowerCase() === name.toLowerCase())
);

const toDelete = projects.filter(p =>
  !keepNames.some(name => p.name.toLowerCase() === name.toLowerCase())
);

console.log(`Keeping ${toKeep.length} project(s):`);
toKeep.forEach(p => console.log(`  - ${p.name}`));

console.log(`\nDeleting ${toDelete.length} test project(s):`);
toDelete.forEach(p => console.log(`  - ${p.name}`));

if (toDelete.length === 0) {
  console.log('\nNothing to clean up.');
  process.exit(0);
}

const projectsDir = path.join(process.env.APPDATA || '', 'kangentic', 'projects');

const tx = db.transaction(() => {
  for (const p of toDelete) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    // Also remove the per-project DB file
    const projDb = path.join(projectsDir, `${p.id}.db`);
    try { fs.unlinkSync(projDb); } catch {}
    try { fs.unlinkSync(projDb + '-wal'); } catch {}
    try { fs.unlinkSync(projDb + '-shm'); } catch {}
  }
});
tx();

db.close();
console.log('\nDone! Restart the app to see the changes.');
process.exit(0);
