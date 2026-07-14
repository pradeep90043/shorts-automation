import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const API_VERSION = "v21.0";
  const videoPath = "/Users/apple/Desktop/pradeep/shorts-automation/temp/gen-1783764086271-75/video_final.mp4";
  
  console.log("Initializing container...");
  const initRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${igUserId}/media?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: "Test caption",
    })
  });
  
  const initData: any = await initRes.json();
  console.log("Init Res:", initData);
  if (!initData.uri) return;
  
  const ruploadUri = initData.uri;
  const fileStats = fs.statSync(videoPath);
  const fileBuffer = fs.readFileSync(videoPath);

  console.log("Uploading binary...");
  const uploadRes = await fetch(ruploadUri, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${token}`,
      'offset': '0',
      'file_size': fileStats.size.toString(),
    },
    body: fileBuffer
  });

  console.log("Upload Status:", uploadRes.status);
  console.log("Upload Data:", await uploadRes.text());
}

run().catch(console.error);
