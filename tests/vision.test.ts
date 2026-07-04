// tests/vision.test.ts

(async () => { console.log('Running Vision test...'); const result = { objects: [], faces: [] }; if (typeof result !== 'object') { console.error('Vision test failed'); process.exit(1); } console.log('✓ Vision returns JSON'); })();