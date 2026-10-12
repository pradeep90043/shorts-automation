// Shared helpers for the Hindi lesson "Spring MVC Architecture" (Spring Boot Full Course #15).
// A scene's "text" is the caption (Hindi with the real English class names); "ttsText" is what the cloned voice speaks:
// the same sentence with every English term spelled in Devanagari, so the Hindi model pronounces it the way the teacher does.

const scenes = [];
let curSetting = "stage";
let chapterPending = null;
let pi = 0;
const POSES = ["present", "point", "think", "smug", "idle", "present", "point", "shrug"];

// English term -> how it is said in Hindi. Longest keys are applied first. Anything left over fails the build (see speak()).
const SAY = {
  // annotations and classes
  "@RestController": "रेस्ट कंट्रोलर", "@Controller": "कंट्रोलर", "@RequestMapping": "रिक्वेस्ट मैपिंग", "@GetMapping": "गेट मैपिंग",
  "@PostMapping": "पोस्ट मैपिंग", "@PutMapping": "पुट मैपिंग", "@DeleteMapping": "डिलीट मैपिंग", "@RequestBody": "रिक्वेस्ट बॉडी",
  "@PathVariable": "पाथ वेरिएबल", "@RequestParam": "रिक्वेस्ट पैरामीटर", "@ResponseBody": "रिस्पॉन्स बॉडी", "@Configuration": "कॉन्फ़िगरेशन",
  "@ComponentScan": "कंपोनेंट स्कैन", "@EnableWebMvc": "इनेबल वेब एमवीसी", "@EnableAutoConfiguration": "इनेबल ऑटो कॉन्फ़िगरेशन",
  "@SpringBootApplication": "स्प्रिंग बूट एप्लीकेशन", "@Service": "सर्विस", "@Repository": "रिपॉज़िटरी", "@Component": "कंपोनेंट", "@Bean": "बीन",
  "@Entity": "एंटिटी",
  "DispatcherServlet": "डिस्पैचर सर्वलेट", "HandlerMethodArgumentResolver": "हैंडलर मेथड आर्ग्युमेंट रिज़ॉल्वर", "HandlerMapping": "हैंडलर मैपिंग",
  "HttpServletRequest": "एचटीटीपी सर्वलेट रिक्वेस्ट", "HttpServletResponse": "एचटीटीपी सर्वलेट रिस्पॉन्स",
  "AnnotationConfigWebApplicationContext": "एनोटेशन कॉन्फ़िग वेब एप्लीकेशन कॉन्टेक्स्ट",
  "AnnotationConfigApplicationContext": "एनोटेशन कॉन्फ़िग एप्लीकेशन कॉन्टेक्स्ट",
  "StudentController": "स्टूडेंट कंट्रोलर", "StudentService": "स्टूडेंट सर्विस", "StudentRepository": "स्टूडेंट रिपॉज़िटरी", "HelloController": "हैलो कंट्रोलर",
  "UserController": "यूज़र कंट्रोलर", "OrderController": "ऑर्डर कंट्रोलर", "PaymentController": "पेमेंट कंट्रोलर",
  "UserServlet": "यूज़र सर्वलेट", "OrderServlet": "ऑर्डर सर्वलेट", "PaymentServlet": "पेमेंट सर्वलेट",
  "WebMvcConfigurer": "वेब एमवीसी कॉन्फ़िगरर", "ViewResolver": "व्यू रिज़ॉल्वर", "JasperInitializer": "जैस्पर इनिशियलाइज़र",
  "ResponseEntity": "रिस्पॉन्स एंटिटी", "LifecycleException": "लाइफ़साइकल एक्सेप्शन", "WebConfig": "वेब कॉन्फ़िग",
  "tomcat-embed-jasper": "टॉमकैट एम्बेड जैस्पर", "tomcat-embed-core": "टॉमकैट एम्बेड कोर", "spring-webmvc": "स्प्रिंग वेब एमवीसी",
  "jackson-databind": "जैक्सन डेटाबाइंड", "spring-boot-starter-web": "स्प्रिंग बूट स्टार्टर वेब",
  "addServletMappingDecoded": "ऐड सर्वलेट मैपिंग डिकोडेड", "addResourceHandlers": "ऐड रिसोर्स हैंडलर्स", "getConnector": "गेट कनेक्टर",
  "src/main/webapp": "सोर्स मेन वेबऐप", "WEB-INF": "वेब इन्फ़", "home.jsp": "होम जेएसपी", "style.css": "स्टाइल सीएसएस",
  "localhost:8080": "लोकलहोस्ट आठ हज़ार अस्सी", "localhost": "लोकलहोस्ट", "8080": "आठ हज़ार अस्सी",
  // words and concepts
  "Spring MVC": "स्प्रिंग एमवीसी", "Spring Boot": "स्प्रिंग बूट", "Spring Core": "स्प्रिंग कोर", "Spring Web MVC": "स्प्रिंग वेब एमवीसी",
  "Model View Controller": "मॉडल व्यू कंट्रोलर", "IoC": "आईओसी", "JSP": "जेएसपी", "JSON": "जेसन", "HTTP": "एचटीटीपी", "HTML": "एचटीएमएल",
  "REST API": "रेस्ट एपीआई", "REST": "रेस्ट", "API": "एपीआई", "URL": "यूआरएल", "CSS": "सीएसएस", "XML": "एक्सएमएल", "POJO": "पोजो",
  "Maven": "मेवन", "IntelliJ": "इंटेलीजे", "Postman": "पोस्टमैन", "Jackson": "जैक्सन", "Jasper": "जैस्पर", "Tomcat": "टॉमकैट",
  "Servlets": "सर्वलेट्स", "Servlet": "सर्वलेट", "servlets": "सर्वलेट्स", "servlet": "सर्वलेट", "Controllers": "कंट्रोलर्स", "Controller": "कंट्रोलर",
  "controllers": "कंट्रोलर्स", "controller": "कंट्रोलर", "Service": "सर्विस", "Repository": "रिपॉज़िटरी", "Student": "स्टूडेंट", "Model": "मॉडल",
  "View": "व्यू", "model": "मॉडल", "view": "व्यू", "Context": "कॉन्टेक्स्ट", "Connector": "कनेक्टर", "Tomcat()": "टॉमकैट",
  "GET": "गेट", "POST": "पोस्ट", "PUT": "पुट", "DELETE": "डिलीट", "Boot": "बूट", "Spring": "स्प्रिंग", "Java": "जावा", "JDK": "जेडीके",
  "Hello": "हैलो", "World": "वर्ल्ड", "hello": "हैलो", "home": "होम", "greet": "ग्रीट", "message": "मैसेज", "name": "नेम", "email": "ईमेल",
  "id": "आईडी", "Aditya": "आदित्य", "Rohit": "रोहित", "HashMap": "हैशमैप", "JPA": "जेपीए", "JDBC": "जेडीबीसी", "Vue": "व्यू", "React": "रिएक्ट",
  "JavaScript": "जावास्क्रिप्ट", "Initializr": "इनिशियलाइज़र", "IDE": "आईडीई", "Jar": "जार", "JAR": "जार", "WAR": "वार", "pom": "पॉम",
  "bean": "बीन", "beans": "बीन्स", "request": "रिक्वेस्ट", "requests": "रिक्वेस्ट्स", "response": "रिस्पॉन्स", "endpoint": "एंडपॉइंट",
  "endpoints": "एंडपॉइंट्स", "mapping": "मैपिंग", "prefix": "प्रीफ़िक्स", "suffix": "सफ़िक्स", "await": "अवेट", "main": "मेन", "Main": "मेन",
  "Lombok": "लोमबोक", "port": "पोर्ट", "Port": "पोर्ट", "Spring Boot को": "स्प्रिंग बूट को", "Hindi": "हिंदी", "JSP,": "जेएसपी,",
};

Object.assign(SAY, {
  "MVC": "एमवीसी", "M,": "एम,", "V": "वी", "C": "सी", "CRUD": "क्रड", "createUser": "क्रिएट यूज़र", "PATCH": "पैच", "External": "एक्सटर्नल",
  "Embedded": "एम्बेडेड", "Long": "लॉन्ग", "getters": "गेटर्स", "setters": "सेटर्स", "entity": "एंटिटी", "studentDB": "स्टूडेंट डीबी", "save": "सेव",
  "findById": "फाइंड बाय आईडी", "findAll": "फाइंड ऑल", "Students": "स्टूडेंट्स", "@Autowired": "ऑटोवायर्ड", "createStudent": "क्रिएट स्टूडेंट",
  "getStudent": "गेट स्टूडेंट", "getAllStudent": "गेट ऑल स्टूडेंट", "OK": "ओके", "Not": "नॉट", "Found": "फाउंड", "by": "बाय", "all": "ऑल", "Run": "रन",
  "base": "बेस", "doc": "डॉक", "addContext": "ऐड कॉन्टेक्स्ट", "register": "रजिस्टर", "addServlet": "ऐड सर्वलेट", "start": "स्टार्ट", "throws": "थ्रोज़",
  "getServer": "गेट सर्वर", "Vue.js": "व्यू डॉट जेएस", "String": "स्ट्रिंग", "views": "व्यूज़", "assets": "एसेट्स", "implements": "इम्प्लीमेंट्स",
  "addWebapp": "ऐड वेबऐप", "APIs": "एपीआईज़", "React": "रिएक्ट",
});

const KEYS = Object.keys(SAY).sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
// a term is replaced only where it is not part of a longer Latin word
const REGEXES = KEYS.map((k) => [new RegExp(`(?<![A-Za-z0-9@])${esc(k)}(?![A-Za-z0-9])`, "g"), SAY[k]]);

/** English words that reached the voice text without a Hindi spelling: the build fails on any (see the main script). */
const MISSING = new Map();
const noteMissing = (out, where) => {
  for (const w of out.match(/[A-Za-z@][A-Za-z0-9_.@\-/]*/g) || []) if (!MISSING.has(w)) MISSING.set(w, where);
};

/** The caption text with every English term spelled the Hindi way. Anything left over is recorded in MISSING. */
function speak(text) {
  let out = text;
  for (const [re, to] of REGEXES) out = out.replace(re, to);
  noteMissing(out, text);
  return out.replace(/\s+/g, " ").trim();
}

function add(text, vis = {}) {
  const v = { pose: POSES[pi++ % POSES.length], mood: "neutral", accent: "gold", setting: curSetting, ...vis };
  if (chapterPending) { v.chapter = chapterPending; chapterPending = null; }
  const ttsText = vis.ttsText ? vis.ttsText : speak(text);
  if (vis.ttsText) noteMissing(vis.ttsText, vis.ttsText);
  delete v.ttsText;
  scenes.push({ i: scenes.length, text, ttsText, ...v });
}
const chapter = (name, setting) => { chapterPending = name; curSetting = setting; };

const code = (title, language, lines, o = {}) => ({ code: { title, language, lines, ...o } });
const term = (lines, title = "Run") => ({ terminal: { title, lines } });
const flow = (nodes, active, packet) => ({ flow: { nodes, active, packet } });
const steps = (items, current) => ({ steps: { items, current } });
const scene = (background, items, arrows = []) => ({ scene: { background, items, arrows } });
const quiz = (question, options, answer, revealAt = 0.65) => ({ quiz: { question, options, answer, revealAt } });
const alert = (kind, title, detail) => ({ alert: { kind, title, detail } });
const compare = (mode, cards) => ({ compare: { mode, cards } });
const browser = (url, kind, lines, heading) => ({ browser: { url, kind, lines, heading } });
const table = (name, columns, rows, highlightRow) => ({ table: { name, columns, rows, highlightRow } });

// Progressive code: revealFrom is the length of the common prefix with the previous snapshot of the same file.
const lastCode = {};
function snap(title, language, lines, o = {}) {
  const prev = lastCode[title] || [];
  let k = 0;
  while (k < prev.length && k < lines.length && prev[k] === lines[k]) k++;
  lastCode[title] = lines;
  return code(title, language, lines, { revealFrom: Math.min(k, lines.length - 1), animate: "type", ...o });
}

module.exports = { MISSING, scenes, add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap, speak, SAY };
