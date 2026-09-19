import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAndroidRoot = path.join(repositoryRoot, 'src-tauri', 'gen', 'android');
const gradleFile = path.join(generatedAndroidRoot, 'app', 'build.gradle.kts');
const keystorePropertiesFile = path.join(generatedAndroidRoot, 'keystore.properties');
const buildType = process.argv.includes('--aab') ? 'aab' : 'apk';

function fail(message) {
  console.error(`Android release build failed: ${message}`);
  process.exit(1);
}

function requiredSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is not set. See the Milestone 8 signing setup in mobile-implementation.md.`);
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? 'unknown'}.`);
}

function escapeProperties(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/([:=])/g, '\\$1');
}

function ensureAndroidProject() {
  if (fs.existsSync(gradleFile)) return;
  run('npm.cmd', ['run', 'tauri', '--', 'android', 'init', '--ci', '--skip-targets-install']);
  if (!fs.existsSync(gradleFile)) fail('Tauri Android initialization did not create app/build.gradle.kts.');
}

function writeSigningProperties() {
  const keystore = path.resolve(requiredSecret('BACKLOGGER_ANDROID_KEYSTORE'));
  const alias = requiredSecret('BACKLOGGER_ANDROID_KEY_ALIAS');
  const storePassword = requiredSecret('BACKLOGGER_ANDROID_STORE_PASSWORD');
  const keyPassword = requiredSecret('BACKLOGGER_ANDROID_KEY_PASSWORD');
  if (!fs.existsSync(keystore) || !fs.statSync(keystore).isFile()) {
    fail(`Keystore does not exist: ${keystore}`);
  }
  const relative = path.relative(repositoryRoot, keystore);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    fail('Keep the production keystore outside the repository.');
  }
  const properties = [
    `storePassword=${escapeProperties(storePassword)}`,
    `keyPassword=${escapeProperties(keyPassword)}`,
    `keyAlias=${escapeProperties(alias)}`,
    `storeFile=${escapeProperties(keystore.replaceAll('\\', '/'))}`,
    '',
  ].join('\n');
  fs.writeFileSync(keystorePropertiesFile, properties, { encoding: 'utf8', mode: 0o600 });
}

function configureGradleSigning() {
  let source = fs.readFileSync(gradleFile, 'utf8');
  const marker = '// Backlogger managed Android release signing.';
  if (!source.includes(marker)) {
    const buildTypes = source.indexOf('    buildTypes {');
    if (buildTypes < 0) fail('Could not find the Android buildTypes block in the generated Gradle file.');
    if (!source.includes('import java.io.FileInputStream')) source = `import java.io.FileInputStream\n${source}`;
    const insertionPoint = source.indexOf('    buildTypes {');
    const signingConfig = `
${marker}
signingConfigs {
    create("release") {
        val keystorePropertiesFile = rootProject.file("keystore.properties")
        val keystoreProperties = Properties()
        if (!keystorePropertiesFile.exists()) {
            throw GradleException("Missing gen/android/keystore.properties for a signed release build.")
        }
        keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
        keyAlias = keystoreProperties["keyAlias"] as String
        keyPassword = keystoreProperties["keyPassword"] as String
        storeFile = file(keystoreProperties["storeFile"] as String)
        storePassword = keystoreProperties["storePassword"] as String
    }
}

`;
    source = `${source.slice(0, insertionPoint)}${signingConfig}${source.slice(insertionPoint)}`;
  }
  const releaseBlock = '        getByName("release") {';
  const signingLine = '            signingConfig = signingConfigs.getByName("release")';
  if (!source.includes(signingLine)) {
    const releaseIndex = source.indexOf(releaseBlock);
    if (releaseIndex < 0) fail('Could not find the release build type in the generated Gradle file.');
    const insertAt = releaseIndex + releaseBlock.length;
    source = `${source.slice(0, insertAt)}\n${signingLine}${source.slice(insertAt)}`;
  }
  fs.writeFileSync(gradleFile, source, 'utf8');
}

function androidVersionName() {
  const configured = process.env.BACKLOGGER_ANDROID_VERSION_NAME?.trim();
  if (configured) return configured;
  const baseConfig = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const androidConfig = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'src-tauri', 'tauri.android.conf.json'), 'utf8'));
  return String(androidConfig.version ?? baseConfig.version ?? '0.1.0');
}

function findReleaseArtifact(buildStartedAt) {
  const outputRoot = path.join(generatedAndroidRoot, 'app', 'build', 'outputs', buildType === 'apk' ? 'apk' : 'bundle');
  if (!fs.existsSync(outputRoot)) fail(`No Android ${buildType} output directory was created.`);
  const candidates = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(`.${buildType}`) && !entry.name.includes('unsigned')) {
        const modifiedAt = fs.statSync(target).mtimeMs;
        if (modifiedAt >= buildStartedAt - 1000) candidates.push(target);
      }
    }
  };
  visit(outputRoot);
  if (candidates.length === 0) {
    fail(`Gradle produced no signed ${buildType.toUpperCase()} artifact. Only unsigned output is available or the release signing config was not applied.`);
  }
  return candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
}

function verifyApk(pathname) {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome) fail('ANDROID_HOME or ANDROID_SDK_ROOT is required to verify the release APK signature.');
  const buildToolsRoot = path.join(androidHome, 'build-tools');
  if (!fs.existsSync(buildToolsRoot)) fail(`Android build-tools directory does not exist: ${buildToolsRoot}`);
  const versions = fs.readdirSync(buildToolsRoot).sort().reverse();
  const signerDirectory = versions.map(version => path.join(buildToolsRoot, version)).find(directory => fs.existsSync(path.join(directory, 'apksigner.bat')) || fs.existsSync(path.join(directory, 'apksigner')));
  if (!signerDirectory) fail('No Android build-tools installation with apksigner was found.');
  const signer = path.join(signerDirectory, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  run(signer, ['verify', '--verbose', pathname]);
}

ensureAndroidProject();
writeSigningProperties();
configureGradleSigning();
const buildStartedAt = Date.now();
run('npm.cmd', ['run', 'tauri', '--', 'android', 'build', `--${buildType}`, '--target', 'aarch64', '--ci']);

const builtArtifact = findReleaseArtifact(buildStartedAt);
const extension = buildType;
const version = androidVersionName().replace(/[^0-9A-Za-z._-]/g, '_');
const suffix = extension === 'apk' ? '' : '-release';
const destination = path.join(path.dirname(builtArtifact), `Backlogger_${version}_android-arm64${suffix}.${extension}`);
if (path.resolve(builtArtifact) !== path.resolve(destination)) fs.copyFileSync(builtArtifact, destination);
if (buildType === 'apk') verifyApk(destination);

const hash = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex').toUpperCase();
const size = fs.statSync(destination).size;
console.log(`Signed Android ${buildType.toUpperCase()}: ${destination}`);
console.log(`Size: ${size} bytes`);
console.log(`SHA-256: ${hash}`);
