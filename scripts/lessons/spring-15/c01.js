// Chapters 1-3: the hook, what Spring MVC is, the missing piece between Tomcat and the Controller.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const HELLO = ["@RestController", "public class HelloController {", "  @GetMapping(\"/hello\")", "  public String hello() {", "    return \"Hi\";", "  }", "}"];
const STACK = ["Spring Boot", "Spring MVC", "Servlets", "Tomcat"];

module.exports = () => {
  // ═══════════════ 1 · The hook ═══════════════
  chapter("1 · वो जादू जो दिखता नहीं", "stage");
  add("आपने Controller में @GetMapping लिखा, और रिक्वेस्ट सही मेथड तक पहुँच गई।", { pose: "present", mood: "excited", ...snap("HelloController.java", "java", HELLO, { highlight: [2] }) });
  add("लेकिन ये पहुँची कैसे? Controller तो किसी पोर्ट पर सुनता ही नहीं।", { pose: "think", mood: "confused", props: [{ type: "question" }], ...flow(["Client", "Tomcat", "???", "Controller"], 2, "GET hello") });
  add("बीच में कोई तो है, जो रिक्वेस्ट को सही मेथड तक छोड़ता है।", { pose: "point", ...flow(["Client", "Tomcat", "???", "Controller"], 3, "GET hello") });
  add("आज हम उसी छिपे हुए आर्किटेक्चर को पूरा खोलकर देखेंगे।", { pose: "present", mood: "excited" });
  add("इसका नाम है Spring MVC, और यही Spring Boot की असली नींव है।", { pose: "point", ...flow(STACK, 1, "") });
  add("सच ये है कि Spring Boot, Spring MVC के ऊपर बस एक ऑटो कॉन्फ़िगरेशन लेयर है।", { pose: "smug", ...compare("versus", [{ title: "Spring MVC", points: ["असली वेब फ्रेमवर्क", "Controller, मैपिंग, JSON"] }, { title: "Spring Boot", points: ["ऑटो कॉन्फ़िगरेशन", "सब कुछ पहले से सेट"] }]) });
  add("एक बार MVC समझ लिया, तो Spring Boot का अंदर का सारा आर्किटेक्चर खुल जाएगा।", { pose: "present", mood: "happy", props: [{ type: "bulb" }] });
  add("आज के सफ़र में पाँच पड़ाव हैं। पहला, पुराने Servlets की दिक्कत।", { pose: "point", ...steps(["पुराने Servlets की दिक्कत", "DispatcherServlet", "HandlerMapping", "बिना Boot का पूरा ऐप", "JSP और MVC"], 0) });
  add("दूसरा, DispatcherServlet। तीसरा, HandlerMapping।", { pose: "present", ...steps(["पुराने Servlets की दिक्कत", "DispatcherServlet", "HandlerMapping", "बिना Boot का पूरा ऐप", "JSP और MVC"], 2) });
  add("फिर हम बिना Spring Boot के, खुद एक पूरा वेब ऐप बनाएँगे।", { pose: "present", mood: "excited", ...steps(["पुराने Servlets की दिक्कत", "DispatcherServlet", "HandlerMapping", "बिना Boot का पूरा ऐप", "JSP और MVC"], 3) });
  add("और आख़िर में देखेंगे, कि MVC के M, V और C का मतलब क्या है।", { pose: "point", ...steps(["पुराने Servlets की दिक्कत", "DispatcherServlet", "HandlerMapping", "बिना Boot का पूरा ऐप", "JSP और MVC"], 4) });

  // ═══════════════ 2 · What Spring MVC is ═══════════════
  chapter("2 · Spring MVC क्या है", "classroom");
  add("Spring MVC का असली नाम है Spring Web MVC। ये Spring का आधिकारिक वेब फ्रेमवर्क है।", { pose: "present", ...steps(["Spring Core: IoC और बीन्स", "Spring MVC: वेब का हिस्सा", "Spring Boot: ऑटो कॉन्फ़िगरेशन"], 1) });
  add("वेब ऐप दो तरह के होते हैं। पहला, REST API, जो डेटा JSON में लौटाती है।", { pose: "point", ...compare("versus", [{ title: "REST API", points: ["JSON जवाब", "ऐप या React इस्तेमाल करता है"] }, { title: "वेब पेज ऐप", points: ["HTML या JSP पेज", "ब्राउज़र सीधे दिखाता है"] }]) });
  add("दूसरा, ऐसा ऐप जो क्लाइंट को सीधे HTML या JSP पेज लौटाता है।", { pose: "present", ...compare("versus", [{ title: "REST API", points: ["JSON जवाब", "ऐप या React इस्तेमाल करता है"] }, { title: "वेब पेज ऐप", points: ["HTML या JSP पेज", "ब्राउज़र सीधे दिखाता है"] }]) });
  add("दोनों के लिए एनोटेशन्स आते हैं Spring MVC से, Spring Boot से नहीं।", { pose: "smug", ...steps(["@Controller", "@RestController", "@RequestMapping", "@GetMapping, @PostMapping"], 3) });
  add("@Controller, @RestController, @RequestMapping, @GetMapping, ये सब Spring MVC के हैं।", { pose: "point", ...steps(["@Controller", "@RestController", "@RequestMapping", "@GetMapping, @PostMapping"], 1) });
  add("Spring Boot बस इतना करता है, कि इसे इस्तेमाल करना आसान बना देता है।", { pose: "present", mood: "happy" });
  add("पिछले CRUD प्रोजेक्ट में हमने सीधे Controller, Service और Repository लिखे थे।", { pose: "present", ...flow(["Controller", "Service", "Repository", "Database"], 3, "डेटा") });
  add("कोई कॉन्फ़िगरेशन नहीं, कोई सर्वर सेटअप नहीं। सब कुछ Spring Boot ने कर दिया था।", { pose: "shrug", mood: "happy" });
  add("अगर आप सिर्फ़ Spring MVC लें, तो ये सब हाथ से करना पड़ता है।", { pose: "point", mood: "worried" });
  add("Tomcat खुद चालू करना होगा, DispatcherServlet खुद बनाना होगा, और डिपेंडेंसी खुद जोड़नी होंगी।", { pose: "present", ...steps(["Tomcat खुद चालू करो", "DispatcherServlet खुद बनाओ", "डिपेंडेंसी खुद जोड़ो", "सब कॉन्फ़िगर करो"], 3) });
  add("यही सारा काम Spring Boot छिपा लेता है। इसे कहते हैं एब्सट्रैक्शन।", { pose: "smug", mood: "smug" });

  // ═══════════════ 3 · The missing piece ═══════════════
  chapter("3 · Tomcat और Controller के बीच", "server");
  add("क्लाइंट ने रिक्वेस्ट भेजी, GET /hello, और वो सीधे HelloController तक पहुँच गई।", { pose: "present", ttsText: "क्लाइंट ने रिक्वेस्ट भेजी, गेट स्लैश हैलो, और वो सीधे हैलो कंट्रोलर तक पहुँच गई।", ...flow(["Client", "Tomcat", "HelloController"], 2, "GET hello") });
  add("पर रुकिए। रिक्वेस्ट सुनता कौन है? Tomcat, जो पोर्ट 8080 पर बैठा है।", { pose: "point", ttsText: "पर रुकिए। रिक्वेस्ट सुनता कौन है? टॉमकैट, जो पोर्ट आठ हज़ार अस्सी पर बैठा है।", ...browser("localhost:8080", "page", ["Tomcat सर्वर", "पोर्ट 8080 पर सुनता है", "हर रिक्वेस्ट यहीं आती है"], "सर्वर") });
  add("Tomcat एक Servlet कंटेनर है, और वो सिर्फ़ Servlets से बात करता है।", { pose: "present", ...flow(["Client", "Tomcat", "Servlet"], 2, "रिक्वेस्ट") });
  add("लेकिन HelloController कोई Servlet नहीं है। वो एक साधारण Java क्लास है।", { pose: "point", mood: "confused", ...alert("warning", "HelloController ≠ Servlet", "Tomcat इसे सीधे नहीं बुला सकता") });
  add("तो सवाल ये है: GET /hello को hello मेथड से जोड़ा किसने?", { pose: "think", ttsText: "तो सवाल ये है: गेट स्लैश हैलो को हैलो मेथड से जोड़ा किसने?", props: [{ type: "question" }] });
  add("इसी सवाल का जवाब है आज का पूरा वीडियो। चलिए, पुरानी दुनिया से शुरू करते हैं।", { pose: "present", mood: "excited" });
};
