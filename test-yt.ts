import { YouTubeService } from "./src/youtube/index";
import { config } from "./src/config/index";

async function main() {
  const yt = new YouTubeService();
  console.log("Config channels:", config.youtube.channels.length);
  const result = await yt.getVideoMetrics(config.youtube.channels[0].name, "dQw4w9WgXcQ");
  console.log("Result:", result);
}
main().catch(console.error);
