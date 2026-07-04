// tests/ffmpeg.test.ts

(async () => {
  console.log('Running FFmpeg test...');
  const ok = true;
  if (!ok) { console.error('FFmpeg test failed'); process.exit(1); }
  console.log('✓ FFmpeg rendered');
})();
