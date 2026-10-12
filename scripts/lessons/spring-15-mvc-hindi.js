// Generates the plan-only JSON for the ~20 minute HINDI tutorial:
// "Spring MVC Architecture: DispatcherServlet, HandlerMapping & JSP Flow" (Spring Boot Full Course #15)
// Source: the lecture transcript. Class names, flows and code come from it; things it never says (web.xml, HandlerAdapter,
// ModelAndView, application.properties, JSTL) are left out. The narration is spoken by the cloned Voicebox voice, so every
// scene carries "ttsText": the caption with each English term spelled in Devanagari (see spring-15/lib.js).
//   node spring-15-mvc-hindi.js out.json
const fs = require("fs");
const L = require("./spring-15/lib");

for (const chapterFile of ["c01", "c02", "c03", "c04", "c05", "c06"]) require(`./spring-15/${chapterFile}`)();
const scenes = L.scenes;
if (L.MISSING.size) {
  console.error("English words with no Hindi spelling (add them to SAY in spring-15/lib.js):");
  for (const [w, where] of L.MISSING) console.error(`  ${w}    <- ${where.slice(0, 70)}`);
  process.exit(1);
}

// every scene must be speakable: no English letters may reach the voice
for (const s of scenes) {
  const left = s.ttsText.match(/[A-Za-z@][A-Za-z0-9_.@\-/]*/g);
  if (left) throw new Error(`Scene ${s.i}: English left in ttsText (${[...new Set(left)].join(", ")}): ${s.ttsText}`);
}

// Scenes cut to land on about 20 minutes (they repeat a point made by a neighbouring scene). A cut scene's chapter title moves to the next one.
const DROP = [
  "फिर हम बिना Spring Boot के", "और आख़िर में देखेंगे, कि MVC", "कोई कॉन्फ़िगरेशन नहीं, कोई सर्वर सेटअप नहीं", "बीच में कोई तो है",
  "आख़िर में Tomcat भरा हुआ रिस्पॉन्स लेकर", "सुनने में ठीक लगता है", "पहला, आए हुए रिक्वेस्ट पैरामीटर्स", "दूसरा, रिक्वेस्ट बॉडी के JSON", "तीसरा, जवाब बनाना",
  "चौथा, Java ऑब्जेक्ट को वापस JSON", "और पाँचवाँ, एक्सेप्शन को सँभालना", "पैरामीटर की जाँच, JSON से Java", "वो कोई जादू नहीं है", "UserServlet की जगह UserController",
  "उनमें सबसे पहला है HandlerMapping", "DispatcherServlet अंदर से और भी कंपोनेंट्स", "और POST /students जाएगा", "अब एक और सवाल। रुककर सोचिए",
  "अंदर ये काम HandlerMethodArgumentResolver", "क्वेरी पैरामीटर Tomcat ने रिक्वेस्ट ऑब्जेक्ट में रख दिया था", "यानी DispatcherServlet, Tomcat और Controller के बीच",
  "और सही मेथड चुनने के लिए वो HandlerMapping", "ये इसलिए चलता है, कि Servlet के मेथड void हैं", "IoC कंटेनर बगल से बीन्स की जानकारी", "दो और सवाल, ताकि ये पक्का हो जाए",
  "अब दूसरा सवाल। क्वेरी पैरामीटर", "पैकेज के नाम हमेशा छोटे अक्षरों में", "JPA और JDBC बाद में आएँगे", "हर मेथड सीधा काम Repository को सौंप देता है", "तीनों एंडपॉइंट तैयार हैं",
  "फिर getConnector बुलाओ", "एक और Student, Rohit", "id दो पर Rohit मिलता है", "पाथ वेरिएबल में अगर दिक्कत आए", "पूरा ऐप चल गया, पर देखिए", "ऐसा करने पर ऐप पहले जैसा ही चलता है",
  "एक सवाल। रुककर सोचिए।", "कंटेनर वही है, बस वेब के लिए", "हर पाथ स्लैश से ही शुरू होता है", "Spring MVC ये इसलिए समझता है", "ये हिस्सा कॉपी करके रख लीजिए", "Rohit लिखिए तो",
  "आज के समय में Spring MVC ज़्यादातर", "वजह ये है कि DispatcherServlet स्लैश वाली", "Jasper Tomcat का JSP इंजन है", "JSP आज थोड़ा पुराना है", "स्टाइल के लिए assets फ़ोल्डर में",
  "इसीलिए Boot बना, क्योंकि",
];
for (let k = scenes.length - 1; k >= 0; k--) {
  if (!DROP.some((d) => scenes[k].text.startsWith(d))) continue;
  if (scenes[k].chapter && scenes[k + 1] && !scenes[k + 1].chapter) scenes[k + 1].chapter = scenes[k].chapter;
  scenes.splice(k, 1);
}
scenes.forEach((sc, k) => { sc.i = k; });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const chars = scenes.reduce((n, s) => n + s.ttsText.length, 0);
const longest = scenes.reduce((m, s) => Math.max(m, s.text.trim().split(/\s+/).length), 0);
const estMin = chars / 13 / 60; // about 13 characters of Hindi are spoken per second (measured on the cloned voice)

const plan = {
  title: "Spring MVC का इंटरनल आर्किटेक्चर | DispatcherServlet, HandlerMapping और JSP | Spring Boot Full Course #15",
  description:
    "Spring Boot असल में Spring MVC के ऊपर एक ऑटो कॉन्फ़िगरेशन लेयर है। इस वीडियो में हम Spring MVC का पूरा इंटरनल आर्किटेक्चर समझते हैं: " +
    "पुराने Servlets में क्या दिक्कत थी, DispatcherServlet सारी रिक्वेस्ट कैसे सँभालता है, HandlerMapping मैपिंग टेबल कैसे बनाता है, " +
    "और JSON, पाथ वेरिएबल और क्वेरी पैरामीटर Controller तक कैसे पहुँचते हैं। फिर बिना Spring Boot के, Embedded Tomcat, WebConfig और main मेथड के साथ " +
    "एक पूरा Student REST ऐप और एक JSP डेमो बनाते हैं, ताकि @Controller, Model, View और ViewResolver साफ़ हो जाएँ।\n\n" +
    "Chapters: 1 वो जादू जो दिखता नहीं | 2 Spring MVC क्या है | 3 Tomcat और Controller के बीच | 4 पुराने Servlets की दिक्कत | 5 DispatcherServlet | " +
    "6 HandlerMapping | 7 डेटा कैसे पहुँचता है | 8 पूरा आर्किटेक्चर | 9 प्रोजेक्ट की तैयारी | 10 Student ऐप | 11 जो Spring Boot छिपाता है | " +
    "12 चलाकर देखते हैं | 13 @Controller बनाम @RestController | 14 MVC | 15 JSP डेमो | 16 सारांश\n\n" +
    "Spring Boot Full Course के लेक्चर 15 (हिंदी) पर आधारित। अगला वीडियो: Spring Boot के फ़ीचर्स।\n\n#SpringBoot #SpringMVC #Java #CodeOrCap",
  tags: ["Spring MVC", "DispatcherServlet", "HandlerMapping", "Spring Boot", "Spring Boot हिंदी", "JSP", "Tomcat", "Java", "Spring Boot Full Course", "CodeOrCap"],
  voice: "voicebox",
  language: "hi",
  scenes,
};

const out = process.argv[2] || "spring15-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} (longest scene ${longest} words) speech chars=${chars} => about ${estMin.toFixed(1)} min of speech -> ${out}`);
