const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['server.js', 'src', 'public', 'browser-extension', 'electron', 'scripts'];

function walk(entry) {
  if (!fs.existsSync(entry)) return [];
  const stat = fs.statSync(entry);
  if (stat.isFile()) return /\.(js|mjs)$/.test(entry) ? [entry] : [];
  if (!stat.isDirectory()) return [];

  return fs
    .readdirSync(entry)
    .flatMap((child) => walk(path.join(entry, child)))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`));
}

const files = roots.flatMap(walk).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax check passed for ${files.length} JavaScript/ES module files.`);
