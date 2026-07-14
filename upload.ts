import { YouTubeService } from "./src/youtube/index";
import { VideoMetadata } from "./src/types";

async function main() {
  const yt = new YouTubeService();
  
  const videoPath = "/Users/apple/Downloads/codeorcap_final_publish.mp4";
  const metadata: VideoMetadata = {
    title: "Building a Headless CMS in 5 Minutes! 🔥 Next.js & Strapi Tutorial",
    description: "Discover how to quickly set up a headless CMS with Strapi! We go from installation to building a blog API in under 5 minutes. No more backend headaches. Perfect for React and Next.js developers!\n\n#Strapi #HeadlessCMS #WebDevelopment #Coding #CodeOrCap #Nextjs #Reactjs #Backend",
    tags: ["Strapi", "Headless CMS", "Next.js", "React", "Web Development", "Backend", "CodeOrCap"]
  };

  console.log("Starting YouTube upload...");
  const results = await yt.uploadToAllChannels(videoPath, metadata);
  console.log("Upload completed!");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
