import { config } from "./src/config";

async function run() {
  const puppeteerModule = await new Function("return import('puppeteer-core')")();
  const puppeteer = puppeteerModule.default;
  
  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    executablePath: config.binaries.chrome,
    headless: true, // we will test headless first
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  
  // Test Hailuo AI (MiniMax video generator)
  const testUrl = "https://hailuoai.video/";
  console.log(`Navigating to ${testUrl}...`);
  
  try {
    await page.goto(testUrl, { waitUntil: "networkidle2", timeout: 30000 });
    const pageTitle = await page.title();
    console.log(`Successfully loaded! Page Title: "${pageTitle}"`);
    
    // Take a screenshot to see if we hit Cloudflare or a captcha
    const screenshotPath = "puppeteer_test_result.jpg";
    await page.screenshot({ path: screenshotPath, type: "jpeg" });
    console.log(`Saved screenshot to ${screenshotPath}`);
    
    // Check if there's a login button or obvious text
    const textContent = await page.evaluate(() => (globalThis as any).document.body.innerText.slice(0, 300));
    console.log("Page Content Snippet:\\n", textContent);
  } catch (err) {
    console.error("Failed to load page:", err);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

run();
