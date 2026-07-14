import { YouTubeService } from "../youtube";
import { InstagramPublisher } from "../instagram/publisher";
import { AiService } from "../ai";

async function main() {
  const videoPath = "/Users/apple/Downloads/clean_video.mp4";
  
  console.log("Generating metadata...");
  const ai = new AiService();
  
  // The user requested: "this video is regarding event loop pf node js"
  const ocrText = "Node.js Event Loop explained step by step with code examples";
  const imageContext = "Node.js programming tutorial video";
  
  const metadata = await ai.generateMetadata(ocrText, imageContext);
  metadata.title = "Node.js Event Loop Explained ⏳🤯";
  metadata.description = "Understanding the Node.js event loop doesn't have to be hard! In this video, we break down exactly how Node handles asynchronous operations behind the scenes. 🚀 #nodejs #javascript #webdevelopment #programming #coding";
  metadata.tags = ["nodejs", "javascript", "webdevelopment", "programming", "coding", "eventloop", "backend"];

  console.log("Using Metadata:", metadata);

  const youtube = new YouTubeService();
  const instagram = new InstagramPublisher();

  console.log("Uploading to YouTube...");
  const ytResults = await youtube.uploadToAllChannels(videoPath, metadata);
  console.log("YouTube results:", ytResults);

  console.log("Uploading to Instagram...");
  const igResults = await instagram.uploadToAllAccounts(videoPath, metadata);
  console.log("Instagram results:", igResults);
  
  console.log("All done!");
}

main().catch(console.error);
