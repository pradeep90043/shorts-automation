import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
const execAsync = promisify(exec);

async function run() {
  const prompt = `Read the image at /Users/apple/Desktop/pradeep/shorts-automation/temp/gen-1783317713119-569/original.jpg using your view_file tool, then use generate_image to redesign it as a cyberpunk aesthetic infographic. Finally, output the absolute file path to the newly generated image.`;
  console.log("Running agy...");
  try {
    const { stdout, stderr } = await execAsync(`agy -p "${prompt}" --dangerously-skip-permissions`);
    console.log("STDOUT:", stdout);
    console.log("STDERR:", stderr);
    
    // Extract path
    const match = stdout.match(/(\/Users\/apple\/.*?\.jpg)/i);
    if (match) {
      console.log("FOUND IMAGE PATH:", match[1]);
    }
  } catch(e) {
    console.error(e);
  }
}
run();
