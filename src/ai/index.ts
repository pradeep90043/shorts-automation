import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { IAiService, VideoMetadata } from '../types';
import { config } from '../config';
import { pipelineLogger } from '../utils/logger';
import { FreeLlmApiClient } from './freellmapi';

export class AiService implements IAiService {
  private ai: GoogleGenAI | null = null;

  constructor() {
    if (config.ai.geminiApiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.ai.geminiApiKey });
    }
  }

  public async generateMetadata(ocrText: string, imageContext: string): Promise<VideoMetadata> {
    pipelineLogger.info('Generating video metadata using AI...', 'AIService');

    // Clean OCR text to remove empty lines and redundant spaces
    const cleanOcr = ocrText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    const prompt = `You are a viral YouTube Shorts creator specializing in programming, web development, and tech education.
Analyze the following OCR text extracted from a programming screenshot:

=== OCR TEXT ===
${cleanOcr || '[No text detected in screenshot]'}
=== IMAGE CONTEXT ===
${imageContext || 'Programming screenshot, code challenge, or tech trick'}

Generate engaging, high-CTR metadata for a 15-second YouTube Short based on this content. 
Follow these guidelines:
- Title: Curiosity-driven, engaging, tech-focused, under 100 characters. Use emojis (e.g., "React Developers Still Make This Mistake 🤯", "This VS Code Trick Saves Hours ⌛").
- Description: Concise, SEO-friendly, under 300 characters, explaining the code snippet or trick. End with 4-5 relevant hashtags (e.g. #programming #coding #webdev #javascript).
- Tags: List of 8-10 relevant tags.

You MUST return EXACTLY a raw JSON object and nothing else. No markdown wrappers (like \`\`\`json), no introductory text.
Output JSON format:
{
  "title": "title string",
  "description": "description string",
  "tags": ["tag1", "tag2", "tag3"]
}
`;

    const provider = config.ai.provider;

    if (provider === 'mock') {
      pipelineLogger.info('AI Provider is set to mock, using rule-based fallback generator.', 'AIService');
      return this.generateFallbackMetadata(cleanOcr);
    }

    if (provider === 'freellmapi') {
      pipelineLogger.info('Using FreeLLMAPI to generate metadata...', 'AIService');
      if (!config.ai.freellmapiKey) {
        pipelineLogger.warn('FreeLLMAPI API key is missing. Falling back to rule-based generation.', 'AIService');
        return this.generateFallbackMetadata(cleanOcr);
      }

      try {
        const client = new FreeLlmApiClient();
        const stdout = await client.generateText(prompt);

        let jsonText = stdout.trim();
        if (jsonText.includes('```')) {
          const matches = jsonText.match(/```(?:json)?([\s\S]*?)```/);
          if (matches && matches[1]) {
            jsonText = matches[1].trim();
          }
        }

        const parsed: VideoMetadata = JSON.parse(jsonText);
        if (!parsed.title || !parsed.description || !Array.isArray(parsed.tags)) {
          throw new Error('FreeLLMAPI returned JSON, but structure is missing required fields.');
        }

        pipelineLogger.checkpoint('FreeLLMAPI metadata generated', true, `Title: "${parsed.title}"`);
        return parsed;
      } catch (err) {
        pipelineLogger.warn(`FreeLLMAPI API metadata generation failed: ${err instanceof Error ? err.message : err}. Falling back to rule-based generation.`, 'AIService');
        return this.generateFallbackMetadata(cleanOcr);
      }
    }

    if (provider === 'gemini') {
      pipelineLogger.info('Using Gemini API to generate metadata...', 'AIService');
      if (!this.ai) {
        pipelineLogger.warn('Gemini API key is missing. Falling back to rule-based generation.', 'AIService');
        return this.generateFallbackMetadata(cleanOcr);
      }

      try {
        const response = await this.ai.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: prompt,
        });

        const stdout = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        let jsonText = stdout.trim();
        if (jsonText.includes('```')) {
          const matches = jsonText.match(/```(?:json)?([\s\S]*?)```/);
          if (matches && matches[1]) {
            jsonText = matches[1].trim();
          }
        }

        const parsed: VideoMetadata = JSON.parse(jsonText);
        if (!parsed.title || !parsed.description || !Array.isArray(parsed.tags)) {
          throw new Error('Gemini returned JSON, but structure is missing required fields.');
        }

        pipelineLogger.checkpoint('Gemini metadata generated', true, `Title: "${parsed.title}"`);
        return parsed;
      } catch (err) {
        pipelineLogger.warn(`Gemini API metadata generation failed: ${err instanceof Error ? err.message : err}. Falling back to rule-based generation.`, 'AIService');
        return this.generateFallbackMetadata(cleanOcr);
      }
    }

    const tempPromptPath = path.join(config.paths.tempDir, `prompt-${Date.now()}.txt`);
    
    try {
      fs.writeFileSync(tempPromptPath, prompt, 'utf8');
      
      let cmd = '';
      if (provider === 'claude') {
        cmd = `cat "${tempPromptPath}" | ${config.ai.claudePath}`;
      } else if (provider === 'antigravity') {
        cmd = `cat "${tempPromptPath}" | ${config.ai.antigravityPath} ask`;
      }

      pipelineLogger.info(`Executing CLI Command: ${cmd}`, 'AIService');

      const stdout = await new Promise<string>((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            pipelineLogger.error(`AI CLI command execution failed: ${stderr}`, error, 'AIService');
            reject(error);
          } else {
            resolve(stdout);
          }
        });
      });

      // Try to parse the result. Clean it first in case the model ignored directions and returned markdown codeblocks.
      let jsonText = stdout.trim();
      if (jsonText.includes('```')) {
        const matches = jsonText.match(/```(?:json)?([\s\S]*?)```/);
        if (matches && matches[1]) {
          jsonText = matches[1].trim();
        }
      }

      const parsed: VideoMetadata = JSON.parse(jsonText);
      
      if (!parsed.title || !parsed.description || !Array.isArray(parsed.tags)) {
        throw new Error('AI returned JSON, but structure is missing required fields.');
      }

      pipelineLogger.checkpoint('AI metadata generated', true, `Title: "${parsed.title}"`);
      return parsed;

    } catch (err) {
      pipelineLogger.warn(`AI CLI processing failed: ${err instanceof Error ? err.message : err}. Falling back to rule-based generation.`, 'AIService');
      return this.generateFallbackMetadata(cleanOcr);
    } finally {
      // Clean up prompt file
      if (fs.existsSync(tempPromptPath)) {
        try {
          fs.unlinkSync(tempPromptPath);
        } catch (_) {}
      }
    }
  }

  /**
   * Generates a contextually-relevant tech title & description using rule-based NLP on the OCR text.
   */
  private generateFallbackMetadata(ocrText: string): VideoMetadata {
    const text = ocrText.toLowerCase();
    
    // Detect framework/language keywords
    let topic = 'Coding';
    let tags = ['programming', 'coding', 'developer', 'shorts', 'learncoding'];
    
    if (text.includes('react') || text.includes('jsx') || text.includes('useeffect') || text.includes('usestate')) {
      topic = 'React';
      tags.push('reactjs', 'javascript', 'webdev');
    } else if (text.includes('system.out') || text.includes('public static void') || text.includes('string[] args') || text.includes('public class') || text.includes('java.')) {
      topic = 'Java';
      tags.push('java', 'javacode', 'javaprogramming');
    } else if (text.includes('typescript') || text.includes('interface ') || text.includes(' type ')) {
      topic = 'TypeScript';
      tags.push('typescript', 'javascript', 'webdev');
    } else if (text.includes('javascript') || text.includes('const ') || text.includes('let ') || text.includes('async/await')) {
      topic = 'JavaScript';
      tags.push('javascript', 'js', 'webdev');
    } else if (text.includes('python') || text.includes('def ') || (text.includes('import ') && text.includes('.py'))) {
      topic = 'Python';
      tags.push('python', 'py', 'datascience');
    } else if (text.includes('dockerfile') || text.includes('docker ') || text.includes('docker-compose') || (text.includes('image:') && text.includes('container'))) {
      topic = 'Docker';
      tags.push('docker', 'devops', 'sysadmin');
    } else if (text.includes('git ') || text.includes('git commit') || text.includes('git branch')) {
      topic = 'Git';
      tags.push('git', 'github', 'versioncontrol');
    } else if (text.includes('css') || text.includes('flexbox') || text.includes('grid-template')) {
      topic = 'CSS';
      tags.push('css', 'webdesign', 'frontend');
    } else if (text.includes('html') || text.includes('div') || text.includes('href')) {
      topic = 'HTML';
      tags.push('html', 'frontend', 'webdev');
    } else if (text.includes('node') || text.includes('express') || text.includes('require(')) {
      topic = 'Node.js';
      tags.push('nodejs', 'backend', 'javascript');
    }

    const titles = [
      `Stop Writing ${topic} Code Like This! 🛑`,
      `This ${topic} Trick Saves So Much Time! ⌛`,
      `${topic} Developers Still Make This Mistake 🤯`,
      `How Well Do You Know ${topic}? 🧠 (Try This Challenge!)`,
      `The Cleanest Way To Write ${topic} Code 💎`,
      `Mind-Blowing ${topic} Hack You Need To Know! ⚡`,
    ];

    // Select a title based on timestamp index to introduce variance
    const titleIndex = Math.floor(Date.now() / 100) % titles.length;
    const title = titles[titleIndex];

    const description = `Let's level up our ${topic} skills! Check out this essential snippet and make sure you're writing clean, optimized code. Double tap if you learned something! 💻🔥\n\n#${tags.slice(0, 5).join(' #')}`;

    pipelineLogger.checkpoint('Fallback metadata generated', true, `Title: "${title}"`);

    return {
      title,
      description,
      tags: tags.slice(0, 10),
    };
  }
}
