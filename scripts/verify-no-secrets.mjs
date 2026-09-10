import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const sourceFiles = [...new Set([...tracked, '.env.example'])];
function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [relative(root, path).replaceAll('\\', '/')];
  });
}

const generated = [
  ...filesBelow(resolve(root, 'dist')),
  'src-tauri/target/release/backlogger.exe',
  ...filesBelow(resolve(root, 'src-tauri/target/release/bundle')),
].filter((path, index, paths) => paths.indexOf(path) === index);

const forbidden = [
  { label: 'Supabase service-role JWT', pattern: /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g },
  { label: 'Google OAuth client secret', pattern: /GOCSPX-[a-zA-Z0-9_-]{20,}/g },
  { label: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: 'service-role assignment', pattern: /(?:SUPABASE_SERVICE_ROLE_KEY|service_role_key)\s*[:=]\s*["'][^"']{8,}/gi },
];

const findings = [];
for (const relativePath of [...sourceFiles, ...generated]) {
  const path = resolve(root, relativePath);
  if (!existsSync(path) || statSync(path).isDirectory()) continue;
  const content = readFileSync(path).toString('utf8');
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) findings.push(`${relativePath}: ${rule.label}`);
  }
}

if (findings.length) {
  console.error(`Forbidden secrets found:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${sourceFiles.length} source files plus available production artifacts).`);
