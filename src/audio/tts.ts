import { EdgeTTS } from 'node-edge-tts';
import { exec } from 'child_process';
import { pipelineLogger } from '../utils/logger';
import fs from 'fs';

export class TTSService {
  public async generateVoiceover(script: string, outputPath: string, channelKey?: string): Promise<number> {
    try {
      pipelineLogger.info(`Generating TTS voiceover (${script.length} chars) for channel: ${channelKey || 'default'}...`, 'TTSService');
      
      const isEnglishMale = channelKey?.toLowerCase() === 'codeorcap';
      const edgeVoice = isEnglishMale ? 'en-IN-PrabhatNeural' : 'hi-IN-SwaraNeural';
      const edgeLang = isEnglishMale ? 'en-IN' : 'hi-IN';
      const openaiVoice = isEnglishMale ? 'onyx' : 'nova';
      
      let generated = false;
      
      // Try OpenAI first
      try {
        pipelineLogger.info(`Attempting OpenAI.fm TTS voiceover generation with voice: ${openaiVoice}...`, 'TTSService');
        await this.generateOpenAIVoiceover(script, openaiVoice, outputPath);
        generated = true;
        pipelineLogger.info(`✓ OpenAI.fm TTS generation successful. Output: ${outputPath}`, 'TTSService');
      } catch (openAiErr) {
        pipelineLogger.warn(
          `OpenAI.fm TTS generation failed/limit reached. Falling back to Edge TTS. Error: ${openAiErr instanceof Error ? openAiErr.message : openAiErr}`,
          'TTSService'
        );
      }
      
      // Fallback to Edge TTS
      if (!generated) {
        pipelineLogger.info(`Generating Edge TTS voiceover with voice: ${edgeVoice}...`, 'TTSService');
        const tts = new EdgeTTS({
          voice: edgeVoice,
          lang: edgeLang,
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
        });
        await tts.ttsPromise(script, outputPath);
        pipelineLogger.info(`✓ Edge TTS generation successful. Output: ${outputPath}`, 'TTSService');
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

  private async generateOpenAIVoiceover(script: string, voice: string, outputPath: string): Promise<void> {
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
      const page = await browser.newPage();
      pipelineLogger.info("Navigating to site to clear Vercel Security Checkpoint...", "TTSService");
      await page.goto('https://www.openai.fm/', { waitUntil: 'networkidle2' });
      
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

