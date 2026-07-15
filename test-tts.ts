import { TTSService } from './src/audio/tts';

async function test() {
  try {
    const service = new TTSService();
    console.log("Testing CodeOrCap (onyx/Edge) voice...");
    const dur1 = await service.generateVoiceover("Hello, this is a test of the OpenAI.fm Onyx voice or the Edge TTS system for CodeOrCap.", "./test_output_codeorcap.mp3", "codeorcap");
    console.log("Success! CodeOrCap voice duration:", dur1);

    console.log("\nTesting Storiyum (nova/Edge) voice...");
    const dur2 = await service.generateVoiceover("Aaine mein dekho. Ek bhoot hai wahan.", "./test_output_storiyum.mp3", "storiyum");
    console.log("Success! Storiyum voice duration:", dur2);
  } catch (e) {
    console.error(e);
  }
}
test();
