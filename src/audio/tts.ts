import { EdgeTTS } from 'node-edge-tts';
import { exec } from 'child_process';
import { pipelineLogger } from '../utils/logger';
import fs from 'fs';

export class TTSService {
  public async generateVoiceover(script: string, outputPath: string, channelKey?: string): Promise<number> {
    try {
      pipelineLogger.info(`Generating TTS voiceover (${script.length} chars) for channel: ${channelKey || 'default'}...`, 'TTSService');
      
      const key = channelKey?.toLowerCase();
      const isEnglishMale   = key === 'codeorcap';
      const isEnglishFemale = key === 'storiyum_cta'; // English female for Storiyum CTA clip
      const edgeVoice  = isEnglishMale ? 'en-IN-PrabhatNeural' : isEnglishFemale ? 'en-IN-NeerjaNeural' : 'hi-IN-SwaraNeural';
      const edgeLang   = (isEnglishMale || isEnglishFemale) ? 'en-IN' : 'hi-IN';
      const openaiVoice = isEnglishMale ? 'onyx' : isEnglishFemale ? 'nova' : 'nova';
      
      let generated = false;

      // Edge TTS is the fast, reliable primary — no browser launch required.
      // OpenAI.fm needs a real headless Chromium (a 30s+ launch on constrained
      // hosts, and it has never once succeeded in production), so it's kept
      // only as a last-resort fallback rather than tried first on every job.
      // Edge TTS is a WebSocket call to Microsoft — fast, but occasionally
      // throttles the datacenter IP with a "Timed out". One quick retry clears
      // most transient failures.
      for (let attempt = 1; attempt <= 2 && !generated; attempt++) {
        try {
          pipelineLogger.info(`Generating Edge TTS voiceover with voice: ${edgeVoice} (attempt ${attempt}/2)...`, 'TTSService');
          const tts = new EdgeTTS({
            voice: edgeVoice,
            lang: edgeLang,
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
          });
          await tts.ttsPromise(script, outputPath);
          generated = true;
          pipelineLogger.info(`✓ Edge TTS generation successful. Output: ${outputPath}`, 'TTSService');
        } catch (edgeErr) {
          pipelineLogger.warn(
            `Edge TTS attempt ${attempt} failed: ${edgeErr instanceof Error ? edgeErr.message : edgeErr}`,
            'TTSService'
          );
          if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Fallback 1: OpenAI's official TTS HTTP API (reliable, no browser).
      if (!generated && process.env.OPENAI_API_KEY) {
        try {
          pipelineLogger.info(`Falling back to OpenAI TTS API (voice: ${openaiVoice})...`, 'TTSService');
          await this.generateOpenAIApiVoiceover(script, openaiVoice, outputPath);
          generated = true;
          pipelineLogger.info(`✓ OpenAI TTS API generation successful. Output: ${outputPath}`, 'TTSService');
        } catch (apiErr) {
          pipelineLogger.warn(`OpenAI TTS API failed: ${apiErr instanceof Error ? apiErr.message : apiErr}`, 'TTSService');
        }
      }

      // Fallback 2: OpenAI.fm scraped via headless Chromium (last resort).
      if (!generated) {
        try {
          pipelineLogger.info(`Attempting OpenAI.fm TTS voiceover generation with voice: ${openaiVoice}...`, 'TTSService');
          await this.generateOpenAIVoiceover(script, openaiVoice, outputPath);
          generated = true;
          pipelineLogger.info(`✓ OpenAI.fm TTS generation successful. Output: ${outputPath}`, 'TTSService');
        } catch (openAiErr) {
          pipelineLogger.error(`All TTS providers failed (Edge, OpenAI API, OpenAI.fm)`, openAiErr, 'TTSService');
          throw openAiErr;
        }
      }
      
      // Determine duration using ffprobe
      return new Promise<number>((resolve) => {
        exec(
          `ffprobe -i "${outputPath}" -show_entries format=duration -v quiet -of csv="p=0"`,
          (error, stdout) => {
            if (error) {
              pipelineLogger.warn(`Failed to measure TTS duration: ${error.message}. Defaulting to 15s.`, 'TTSService');
              resolve(15);
            } else {
              const duration = parseFloat(stdout.trim());
              resolve(isNaN(duration) ? 15 : duration);
            }
          }
        );
      });
    } catch (err) {
      pipelineLogger.error(`Failed to generate TTS voiceover`, err, 'TTSService');
      throw err;
    }
  }

  /** OpenAI's official text-to-speech HTTP API — a plain request, no browser. */
  private async generateOpenAIApiVoiceover(script: string, voice: string, outputPath: string): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'coral', 'sage'];
    const chosen = validVoices.includes(voice) ? voice : 'onyx';
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: chosen,
        input: script,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI TTS API HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`OpenAI TTS API returned only ${buf.length} bytes`);
    fs.writeFileSync(outputPath, buf);
  }

  private async generateOpenAIVoiceover(script: string, voice: string, outputPath: string): Promise<void> {
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    
    const browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 90000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
      ],
    });

    try {
      const page = await browser.newPage();
      pipelineLogger.info("Navigating to site to clear Vercel Security Checkpoint...", "TTSService");
      await page.goto('https://www.openai.fm/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      
      await new Promise(r => setTimeout(r, 4000)); // wait for WAF challenge to complete
      
      pipelineLogger.info("Requesting OpenAI.fm generation API...", "TTSService");
      const base64Audio = await page.evaluate(async (selectedVoice: string, inputText: string) => {
        const formData = new FormData();
        formData.append("input", inputText);
        formData.append("prompt", `Voice Affect: Extremely energetic, highly enthusiastic, loud, clear, and powerful. Speak in a natural Indian English accent with high excitement, motivation, and punchy cadence.\n\nTone: High intensity, energetic, enthusiastic, and confident.\n\nPacing: Fast-paced, punchy, and highly dynamic.\n\nEmotion: Full of energy, excitement, and positive hype.`);
        formData.append("voice", selectedVoice);
        formData.append("vibe", "");
        
        const response = await fetch('https://www.openai.fm/api/generate', {
          method: 'POST',
          body: formData
        });
        
        if (!response.ok) {
          throw new Error('HTTP error ' + response.status);
        }
        
        const blob = await response.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new (globalThis as any).FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, voice, script);
      
      if (!base64Audio || !base64Audio.includes(',')) {
        throw new Error('Invalid base64 audio response from page evaluate');
      }
      
      const base64Data = base64Audio.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(outputPath, buffer);
    } finally {
      await browser.close();
    }
  }
}

