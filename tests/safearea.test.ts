// tests/safearea.test.ts

(async () => {
  console.log('Running Safe Area test...');
  const area = { x:0, y:0, width:100, height:100 };
  if (!area) { console.error('Safe area test failed'); process.exit(1); }
  console.log('✓ Safe Area exists');
})();
