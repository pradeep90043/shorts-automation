// scripts/verify.js
/**
 * Local verification script – runs the full build and pipeline tests.
 * It is intentionally disabled on production/VM environments.
 *
 * To enable it locally set the environment variable LOCAL_DEV=true
 * (e.g., `LOCAL_DEV=true npm run verify`).
 */
if (process.env.LOCAL_DEV === 'true') {
  const { execSync } = require('child_process');
  console.log('🔧 Running local verification (build + pipeline tests)');
  execSync('npm run build', { stdio: 'inherit' });
  execSync('npm run test:pipeline', { stdio: 'inherit' });
} else {
  console.log('⚠️ verify is disabled in non‑local environments.');
  console.log('   Set LOCAL_DEV=true to run it locally.');
}
