import { YouTubeService } from "./src/youtube/index";
import { InstagramPublisher } from "./src/instagram/publisher";
import { VideoMetadata } from "./src/types";

async function main() {
  const yt = new YouTubeService();
  const ig = new InstagramPublisher();
  
  const videoPath = "/Users/apple/Downloads/teaser_reel_watermarked_final.mp4";
  const metadata: VideoMetadata = {
    title: "Stop Building Backends Manually! 🛑 Strapi in 30 Seconds",
    description: "Tired of 403 Forbidden errors and writing the same API boilerplate over and over? 😤 Let Strapi do the heavy lifting! Watch how we spin up an instant API and publish content directly to a mobile app in seconds. No backend headaches required. \n\nCheck the link in bio for the full 5-minute tutorial! 🚀\n\n#Strapi #HeadlessCMS #WebDevelopment #Backend #CodeOrCap #Programming #Tech",
    tags: ["Strapi", "Headless CMS", "Backend", "Web Development", "CodeOrCap", "Programming", "Tech", "API"]
  };

  console.log("Starting YouTube and Instagram uploads...");
  
  const ytResults = await yt.uploadToAllChannels(videoPath, metadata);
  console.log("YouTube Upload completed:", JSON.stringify(ytResults, null, 2));

  const igResults = await ig.uploadToAllAccounts(videoPath, metadata);
  console.log("Instagram Upload completed:", JSON.stringify(igResults, null, 2));
}

main().catch(console.error);
