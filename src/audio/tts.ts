import os from 'os';
import path from 'path';
import { EdgeTTS } from 'node-edge-tts';
import { exec, execFile } from 'child_process';
import { pipelineLogger } from '../utils/logger';
import fs from 'fs';
import { rateToTempo, retimeAudio } from './retime';

/** Edge TTS speaking rate ("-10%", "+5%"): duration scales as 1 / (1 + rate), measured on en-IN-PrabhatNeural. */
const toRate = (pct: number): string => `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`;

export class TTSService {
  /**
   * Natural-speed cloned-voice clips (src/audio/clonedVoice.ts), by channel and script. A script registered here is "spoken"
   * from its clip: `rate` (the fitting passes of generateFittedVoiceover) becomes a pitch-preserving tempo change of the same
   * clip, so no new cloud run is needed. null = the cloud failed: the Edge voice is used as before.
   */
  private cloned = new Map<string, Promise<string | null>>();
  private clonedKey = (channelKey: string | undefined, script: string): string => `${(channelKey ?? '').toLowerCase()}|${script.trim()}`;

  /** Speaks `script` with `python3 -m edge_tts` (text via a temp file: no shell quoting). Rejects on a non-zero exit or an empty file. */
  private generatePythonEdge(script: string, voice: string, rate: string | undefined, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), `edge-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
      fs.writeFileSync(tmp, script, 'utf8');
      const args = ['-m', 'edge_tts', '--voice', voice, '--file', tmp, '--write-media', outputPath, ...(rate ? [`--rate=${rate}`] : [])];
      execFile(process.env.PYTHON_BIN || 'python3', args, { timeout: 90_000 }, (err, _out, stderr) => {
        try { fs.unlinkSync(tmp); } catch { /* temp file */ }
        if (err) return reject(new Error(`${err.message.split('\n')[0]} ${String(stderr).slice(0, 200)}`.trim()));
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) return reject(new Error('edge-tts wrote no audio'));
        resolve();
      });
    });
  }

  public registerCloned(channelKey: string, script: string, clip: Promise<string | null>): void {
    this.cloned.set(this.clonedKey(channelKey, script), clip);
  }

  public hasCloned(channelKey: string, script: string): boolean {
    return this.cloned.has(this.clonedKey(channelKey, script));
  }

  /**
   * Generates a voiceover whose length matches `targetSec`, by re-synthesising at a different Edge TTS speaking rate.
   * The script alone decides how long the voice is, so a script that reads shorter than the video would leave the rest in
   * silence: slow the voice down (down to `maxSlowPct`) so it keeps going to the end; a script that reads longer is sped up
   * (up to `maxFastPct`). If the limits are hit, the closest result is kept and the shortfall is logged.
   * Only Edge TTS honours the rate; the OpenAI fallbacks return their natural length.
   */
  public async generateFittedVoiceover(
    script: string,
    outputPath: string,
    targetSec: number,
    channelKey?: string,
    opts: { maxSlowPct?: number; maxFastPct?: number; tolerance?: number } = {},
  ): Promise<number> {
    const maxSlow = opts.maxSlowPct ?? 25;
    const maxFast = opts.maxFastPct ?? 25;
    const tolerance = opts.tolerance ?? 0.03;
    const goal = Math.max(3, targetSec);

    let duration = await this.generateVoiceover(script, outputPath, channelKey);
    // duration = natural / (1 + rate), so the rate that lands on the goal is natural / goal - 1
    let ratePct = 0;
    for (let pass = 1; pass <= 2; pass++) {
      if (Math.abs(duration - goal) <= goal * tolerance) break;
      const wanted = (1 + ratePct / 100) * (duration / goal) - 1;
      const next = Math.min(maxFast, Math.max(-maxSlow, wanted * 100));
      if (Math.round(next) === ratePct) break; // already at the limit
      ratePct = Math.round(next);
      pipelineLogger.info(
        `Voiceover is ${duration.toFixed(1)}s for a ${goal.toFixed(1)}s video — re-generating at rate ${toRate(ratePct)} (pass ${pass})...`,
        'TTSService',
      );
      duration = await this.generateVoiceover(script, outputPath, channelKey, toRate(ratePct));
    }
    if (duration < goal * (1 - 0.1)) {
      pipelineLogger.warn(
        `Voiceover still ends ${(goal - duration).toFixed(1)}s early (${duration.toFixed(1)}s of ${goal.toFixed(1)}s) even at the slowest rate — the script is too short for this video.`,
        'TTSService',
      );
    }
    return duration;
  }

  public async generateVoiceover(script: string, outputPath: string, channelKey?: string, rate?: string): Promise<number> {
    const clonedClip = this.cloned.get(this.clonedKey(channelKey, script));
    if (clonedClip) {
      const natural = await clonedClip;
      if (natural && fs.existsSync(natural)) {
        const duration = await retimeAudio(natural, outputPath, rateToTempo(rate));
        pipelineLogger.info(`Cloned-voice voiceover (${script.length} chars)${rate ? ` at ${rate}` : ''}: ${duration.toFixed(1)}s`, 'TTSService');
        return duration;
      }
      pipelineLogger.warn('Cloned voice is not available for this script: using the Edge voice', 'TTSService');
    }
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
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            ...(rate ? { rate } : {}),
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

      // Fallback 0: the Python edge-tts package, which the image installs at build time (latest release). Microsoft's service now
      // demands a signed token (Sec-MS-GEC) that node-edge-tts 1.2.x does not send: it answers HTTP 403, as it did for every
      // Short on 2026-10-19. The Python package sends it.
      if (!generated) {
        try {
          pipelineLogger.info(`Trying the Python edge-tts package (voice: ${edgeVoice})...`, 'TTSService');
          await this.generatePythonEdge(script, edgeVoice, rate, outputPath);
          generated = true;
          pipelineLogger.info(`✓ Python edge-tts generation successful. Output: ${outputPath}`, 'TTSService');
        } catch (pyErr) {
          pipelineLogger.warn(`Python edge-tts failed: ${pyErr instanceof Error ? pyErr.message : pyErr}`, 'TTSService');
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

