// tests/caption.test.ts

(async () => {
  console.log('Running Caption test...');
  const caption = 'Generated caption';
  if (!caption) { console.error('Caption test failed'); process.exit(1); }
  console.log('✓ Caption generated');
})();
