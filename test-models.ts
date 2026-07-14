import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    try {
        const response = await ai.models.list();
        console.log(response);
    } catch (e: any) {
        console.error("Failed:", e.message);
    }
}
run();
