import dotenv from "dotenv";
dotenv.config();

async function testIG() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_USER_ID;

  if (!token || !igUserId) {
    console.error("Missing IG credentials in .env");
    process.exit(1);
  }

  console.log(`Testing token against IG User ID: ${igUserId}...`);
  
  const res = await fetch(`https://graph.facebook.com/v21.0/${igUserId}?fields=username,name,profile_picture_url&access_token=${token}`);
  const data = await res.json();
  
  if (res.ok) {
    console.log("✅ Token is VALID!");
    console.log("Profile Data:", JSON.stringify(data, null, 2));
  } else {
    console.error("❌ Token test FAILED!");
    console.error("Error:", JSON.stringify(data, null, 2));
  }
}

testIG();
