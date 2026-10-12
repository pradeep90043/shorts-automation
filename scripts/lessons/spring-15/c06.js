// Chapters 14-16: MVC (Model, View, Controller), the JSP demo, recap and what comes next.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const MVC = ["Model: डेटा ले जाने वाला ऑब्जेक्ट", "View: HTML या JSP पेज", "Controller: रिक्वेस्ट सँभालने वाली परत"];
const HELLO = [
  "@Controller",
  "public class HelloController {",
  "  @GetMapping(\"/\")",
  "  public String showHomePage(Model model) {",
  "    model.addAttribute(\"message\", \"Enter your name\");",
  "    return \"home\";",
  "  }",
  "}",
];
const GREET = [
  "  @PostMapping(\"/greet\")",
  "  public String greetUser(Model model,",
  "      @RequestParam String name) {",
  "    model.addAttribute(\"message\", \"Hello, \" + name);",
  "    return \"home\";",
  "  }",
];
const JSP = ["<h1>Spring MVC JSP Demo</h1>", "<p>${message}</p>", "<form action=\"/greet\" method=\"post\">", "  <input type=\"text\" name=\"name\"", "         placeholder=\"Enter your name\">", "  <button type=\"submit\">Submit</button>", "</form>"];
const RESOLVER = ["@Bean", "public ViewResolver viewResolver() {", "  // prefix: /WEB-INF/views/", "  // suffix: .jsp", "  return resolver;", "}"];
const JSP_STEPS = ["Controller व्यू का नाम लौटाता है", "ViewResolver पूरा पाथ बनाता है", "Jasper JSP को चलाता है", "Tomcat HTML भेज देता है"];

module.exports = () => {
  // ═══════════════ 14 · MVC ═══════════════
  chapter("14 · MVC यानी M, V, C", "classroom");
  add("अब तक हमने सिर्फ़ REST API बनाई। पर Spring MVC वेब पेज भी बनाता है।", { pose: "present", ...compare("versus", [{ title: "REST API", points: ["डेटा JSON में"] }, { title: "वेब पेज", points: ["HTML या JSP पेज", "यही View है"] }]) });
  add("MVC का मतलब है Model, View और Controller।", { pose: "point", mood: "excited", ...steps(MVC, 0) });
  add("Controller वो परत है जो HTTP रिक्वेस्ट और एंडपॉइंट्स सँभालती है।", { pose: "present", ...steps(MVC, 2) });
  add("View वो HTML या JSP पेज है, जो यूज़र को फ्रंट एंड पर दिखता है।", { pose: "point", ...steps(MVC, 1) });
  add("और Model एक ऑब्जेक्ट है, जो Controller से View तक डेटा ले जाता है। डायनेमिक पेज इसी से बनते हैं।", { pose: "present", ...flow(["Controller", "Model", "View (JSP)"], 2, "डेटा") });
  add("Model को एक थैले की तरह सोचिए। Controller उसमें डेटा रखता है, पेज उसे निकालकर दिखाता है।", { pose: "smug", mood: "happy", props: [{ type: "bulb" }] });
  add("JSP आज थोड़ा पुराना है। आज के फ्रंट एंड React और Vue.js जैसे टूल्स से बनते हैं।", { pose: "shrug" });
  add("फिर भी पुराने प्रोजेक्ट्स में JSP मिलता है, और नाम MVC वही रहता है। चलिए, एक डेमो बनाते हैं।", { pose: "point", mood: "happy" });

  // ═══════════════ 15 · The JSP demo ═══════════════
  chapter("15 · JSP डेमो", "office");
  add("नया खाली प्रोजेक्ट बनाइए, नाम रखिए jsp-demo। डिपेंडेंसी लगभग वही हैं।", { pose: "present", ttsText: "नया खाली प्रोजेक्ट बनाइए, नाम रखिए जेएसपी डेमो। डिपेंडेंसी लगभग वही हैं।", ...steps(["spring-webmvc", "tomcat-embed-core", "tomcat-embed-jasper (नई)"], 2) });
  add("Jackson अब नहीं चाहिए, क्योंकि हम JSON नहीं लौटा रहे। उसकी जगह चाहिए tomcat-embed-jasper।", { pose: "point", ...alert("success", "tomcat-embed-jasper", "Tomcat का JSP इंजन, वही वर्ज़न जो Tomcat कोर का है") });
  add("Jasper Tomcat का JSP इंजन है। इसका वर्ज़न Tomcat कोर के बराबर रखना होता है।", { pose: "present", mood: "happy" });
  add("अब HelloController बनाइए। इस बार @RestController नहीं, @Controller लगाइए।", { pose: "point", ...snap("HelloController.java", "java", HELLO.slice(0, 2), { highlight: [0] }) });
  add("स्लैश पर GET आए, तो showHomePage चले। उसे Model मिलता है।", { pose: "present", ttsText: "स्लैश पर गेट आए, तो शो होम पेज चले। उसे मॉडल मिलता है।", ...snap("HelloController.java", "java", HELLO.slice(0, 4), { highlight: [2, 3] }) });
  add("Model में message नाम से \"Enter your name\" रखते हैं, और \"home\" लौटा देते हैं।", { pose: "point", ttsText: "मॉडल में मैसेज नाम से इंटर योर नेम रखते हैं, और होम लौटा देते हैं।", ...snap("HelloController.java", "java", HELLO, { highlight: [4, 5] }) });
  add("ध्यान रखिए। @Controller में लौटाई गई String टेक्स्ट नहीं, एक व्यू का नाम होती है।", { pose: "smug", mood: "excited", ...alert("warning", "return \"home\" का मतलब", "टेक्स्ट \"home\" नहीं, व्यू का नाम होता है") });
  add("Spring MVC ये इसलिए समझता है, क्योंकि क्लास पर @Controller लगा है।", { pose: "present" });
  add("दूसरा एंडपॉइंट, POST पर greet। फ़ॉर्म का डेटा यहाँ क्वेरी पैरामीटर बनकर आता है।", { pose: "point", ttsText: "दूसरा एंडपॉइंट, पोस्ट पर ग्रीट। फ़ॉर्म का डेटा यहाँ क्वेरी पैरामीटर बनकर आता है।", ...snap("HelloController.java", "java", GREET, { highlight: [0, 2] }) });
  add("इसे हम @RequestParam से पकड़ते हैं। फ़ॉर्म की इनपुट का नाम और पैरामीटर का नाम एक ही होना चाहिए।", { pose: "present", ...snap("HelloController.java", "java", GREET, { highlight: [2] }) });
  add("Model में अब message बनता है \"Hello\" और नाम, और फिर वही home पेज लौटता है।", { pose: "point", ttsText: "मॉडल में अब मैसेज बनता है हैलो और नाम, और फिर वही होम पेज लौटता है।", ...snap("HelloController.java", "java", GREET, { highlight: [3, 4] }) });
  add("अब पेज बनाते हैं। फ़ोल्डर होगा src/main/webapp/WEB-INF/views, और फ़ाइल home.jsp।", { pose: "present", ...steps(["src/main/webapp", "WEB-INF/views/home.jsp", "assets/style.css"], 1) });
  add("स्टाइल के लिए assets फ़ोल्डर में style.css भी रखते हैं।", { pose: "point", ...steps(["src/main/webapp", "WEB-INF/views/home.jsp", "assets/style.css"], 2) });
  add("home.jsp एक सादा HTML पेज है। ऊपर शीर्षक, और उसके नीचे message छपता है।", { pose: "present", ...snap("home.jsp", "xml", JSP.slice(0, 2), { highlight: [0, 1] }) });
  add("message की जगह Model का डेटा आ जाता है। यही डायनेमिक पेज बनाता है।", { pose: "point", mood: "happy", ...snap("home.jsp", "xml", JSP.slice(0, 2), { highlight: [1] }) });
  add("उसके नीचे एक फ़ॉर्म है, जो POST करता है greet पर, एक इनपुट बॉक्स के साथ, जिसका नाम name है।", { pose: "present", ttsText: "उसके नीचे एक फ़ॉर्म है, जो पोस्ट करता है ग्रीट पर, एक इनपुट बॉक्स के साथ, जिसका नाम नेम है।", ...snap("home.jsp", "xml", JSP, { highlight: [2, 3] }) });
  add("पेज तैयार है। पर अब सवाल है कि \"home\" नाम से ये फ़ाइल मिलेगी कैसे?", { pose: "think", mood: "confused", props: [{ type: "question" }] });
  add("इसके लिए WebConfig में कुछ और जोड़ना होगा। पहले, क्लास में implements WebMvcConfigurer।", { pose: "point", ...snap("WebConfig.java", "java", ["@Configuration", "@ComponentScan(basePackages = \"com.example\")", "@EnableWebMvc", "public class WebConfig", "    implements WebMvcConfigurer {", "}"], { highlight: [3, 4] }) });
  add("फिर addResourceHandlers को ओवरराइड करना होता है, ताकि style.css जैसी फ़ाइलें ब्राउज़र को मिल सकें।", { pose: "present", ...snap("WebConfig.java", "java", ["@Override", "public void addResourceHandlers(", "    ResourceHandlerRegistry registry) {", "  // assets फ़ोल्डर की फ़ाइलें खोलो, जैसे style.css", "}"], { highlight: [1] }) });
  add("ये हिस्सा कॉपी करके रख लीजिए, इसे रटने की कोई ज़रूरत नहीं।", { pose: "shrug", mood: "happy" });
  add("अब सबसे अहम चीज़, एक ViewResolver बीन। इसमें एक प्रीफ़िक्स और एक सफ़िक्स तय होता है।", { pose: "point", mood: "excited", ...snap("WebConfig.java", "java", RESOLVER, { highlight: [2, 3] }) });
  add("प्रीफ़िक्स है /WEB-INF/views/, और सफ़िक्स है .jsp।", { pose: "present", ttsText: "प्रीफ़िक्स है वेब इन्फ़ स्लैश व्यूज़ स्लैश, और सफ़िक्स है डॉट जेएसपी।", ...table("ViewResolver", ["हिस्सा", "मान"], [["प्रीफ़िक्स", "/WEB-INF/views/"], ["व्यू का नाम", "home"], ["सफ़िक्स", ".jsp"]], 0) });
  add("Controller ने \"home\" लौटाया, तो ViewResolver तीनों को जोड़ देता है।", { pose: "point", ttsText: "कंट्रोलर ने होम लौटाया, तो व्यू रिज़ॉल्वर तीनों को जोड़ देता है।", ...table("ViewResolver", ["हिस्सा", "मान"], [["प्रीफ़िक्स", "/WEB-INF/views/"], ["व्यू का नाम", "home"], ["सफ़िक्स", ".jsp"]], 1) });
  add("नतीजा: /WEB-INF/views/home.jsp, यानी ठीक हमारी फ़ाइल।", { pose: "celebrate", mood: "happy", ttsText: "नतीजा: वेब इन्फ़ स्लैश व्यूज़ स्लैश होम डॉट जेएसपी, यानी ठीक हमारी फ़ाइल।", ...table("ViewResolver", ["हिस्सा", "मान"], [["पूरा पाथ", "/WEB-INF/views/home.jsp"]], 0) });
  add("Spring Boot ये ViewResolver अपने आप बना देता है, सिर्फ़ Spring MVC में हाथ से बनाना पड़ता है।", { pose: "smug", ...compare("versus", [{ title: "सिर्फ़ Spring MVC", points: ["ViewResolver हाथ से"] }, { title: "Spring Boot", points: ["ViewResolver अपने आप"] }]) });
  add("अब main मेथड में दो बदलाव। पहला, addContext की जगह addWebapp।", { pose: "point", ...snap("Main.java", "java", ["Context context =", "  tomcat.addWebapp(contextPath, baseDoc);"], { highlight: [1] }) });
  add("दूसरा, Spring कंटेनर बनाने से पहले JasperInitializer जोड़ना, ताकि Tomcat JSP चला सके।", { pose: "present", ...snap("Main.java", "java", ["context.addServletContainerInitializer(", "    new JasperInitializer(), Set.of());"], { highlight: [0, 1] }) });
  add("एक और लाइन चाहिए, ताकि JSP पेज DispatcherServlet के बजाय अलग से चलें।", { pose: "point", ...alert("warning", "JSP पेज अलग से", "DispatcherServlet सिर्फ़ Controllers को रिक्वेस्ट देता है") });
  add("वजह ये है कि DispatcherServlet स्लैश वाली सारी रिक्वेस्ट ले लेता है।", { pose: "present", ttsText: "वजह ये है कि डिस्पैचर सर्वलेट स्लैश वाली सारी रिक्वेस्ट ले लेता है।" });
  add("अब चलाइए और ब्राउज़र में localhost:8080 खोलिए। फ़ॉर्म दिखता है, ऊपर Enter your name के साथ।", { pose: "present", mood: "excited", ttsText: "अब चलाइए और ब्राउज़र में लोकलहोस्ट आठ हज़ार अस्सी खोलिए। फ़ॉर्म दिखता है, ऊपर इंटर योर नेम के साथ।", ...browser("localhost:8080", "page", ["Spring MVC JSP Demo", "Enter your name", "[ नाम लिखिए ]   [ Submit ]"], "Spring MVC JSP Demo") });
  add("नाम में Aditya लिखकर सबमिट कीजिए, तो पेज पर दिखता है: Hello Aditya।", { pose: "celebrate", mood: "happy", ttsText: "नाम में आदित्य लिखकर सबमिट कीजिए, तो पेज पर दिखता है: हैलो आदित्य।", ...browser("localhost:8080/greet", "page", ["Spring MVC JSP Demo", "Hello, Aditya", "[ नाम लिखिए ]   [ Submit ]"], "Spring MVC JSP Demo") });
  add("Rohit लिखिए तो Hello Rohit। वही पेज, नया डेटा।", { pose: "present", ttsText: "रोहित लिखिए तो हैलो रोहित। वही पेज, नया डेटा।", ...browser("localhost:8080/greet", "page", ["Spring MVC JSP Demo", "Hello, Rohit", "[ नाम लिखिए ]   [ Submit ]"], "Spring MVC JSP Demo") });
  add("पीछे क्या हुआ? Controller ने Model में message रखा और व्यू का नाम लौटाया।", { pose: "point", ...steps(JSP_STEPS, 0) });
  add("ViewResolver ने उससे पूरा पाथ बनाया, और Jasper ने JSP को चलाकर HTML बना दिया।", { pose: "present", ...steps(JSP_STEPS, 2) });
  add("आख़िर में Tomcat वही HTML ब्राउज़र को भेज देता है। JSP यानी वो HTML पेज, जिसमें Java कोड जुड़ सकता है।", { pose: "smug", mood: "happy", ...steps(JSP_STEPS, 3) });
  add("आज के समय में Spring MVC ज़्यादातर REST APIs के लिए इस्तेमाल होता है, फिर भी नाम MVC ही है।", { pose: "shrug", mood: "happy" });
  add("एक सवाल। रुककर सोचिए।", { pose: "think" });
  add("@Controller में return home का क्या मतलब है?", { pose: "point", ttsText: "कंट्रोलर में होम लौटाने का क्या मतलब है?", ...quiz("@Controller में return \"home\" का क्या मतलब है?", ["क्लाइंट को टेक्स्ट home भेजा जाएगा", "व्यू का नाम, ViewResolver इसे JSP पाथ बनाएगा", "यूज़र को home पाथ पर रीडायरेक्ट करना", "एक एरर आएगा"], 1) });
  add("सही जवाब दूसरा। ये व्यू का नाम है, और ViewResolver इसे JSP के पाथ में बदलता है।", { pose: "celebrate", mood: "happy" });

  // ═══════════════ 16 · Recap and next ═══════════════
  chapter("16 · सारांश और आगे", "stage");
  add("चलिए, आज की पूरी यात्रा दोहराते हैं। पहला, पुराने Servlets में हर Servlet वही दोहराव करता था।", { pose: "present", ...steps(["पुराने Servlets: दोहराव", "DispatcherServlet: एक दरवाज़ा", "HandlerMapping: मैपिंग टेबल", "बिना Boot का पूरा ऐप", "JSP और MVC"], 0) });
  add("दूसरा, DispatcherServlet सारी रिक्वेस्ट लेकर दोहराव वाला काम एक जगह करता है।", { pose: "point", ...steps(["पुराने Servlets: दोहराव", "DispatcherServlet: एक दरवाज़ा", "HandlerMapping: मैपिंग टेबल", "बिना Boot का पूरा ऐप", "JSP और MVC"], 1) });
  add("तीसरा, HandlerMapping बीन्स स्कैन करके मैपिंग टेबल बनाता है।", { pose: "present", ...steps(["पुराने Servlets: दोहराव", "DispatcherServlet: एक दरवाज़ा", "HandlerMapping: मैपिंग टेबल", "बिना Boot का पूरा ऐप", "JSP और MVC"], 2) });
  add("चौथा, बिना Boot के हमने Tomcat, WebConfig और DispatcherServlet खुद जोड़े।", { pose: "point", ...steps(["पुराने Servlets: दोहराव", "DispatcherServlet: एक दरवाज़ा", "HandlerMapping: मैपिंग टेबल", "बिना Boot का पूरा ऐप", "JSP और MVC"], 3) });
  add("और पाँचवाँ, MVC में Model डेटा ले जाता है, और ViewResolver नाम से JSP ढूँढता है।", { pose: "present", ...steps(["पुराने Servlets: दोहराव", "DispatcherServlet: एक दरवाज़ा", "HandlerMapping: मैपिंग टेबल", "बिना Boot का पूरा ऐप", "JSP और MVC"], 4) });
  add("तो Spring Boot असल में क्या है? Spring MVC के ऊपर एक ऑटो कॉन्फ़िगरेशन लेयर।", { pose: "smug", mood: "excited", ...flow(["Spring Boot", "Spring MVC", "Servlets", "Tomcat"], 1, "") });
  add("इसीलिए Boot बना, क्योंकि Spring MVC में बॉयलरप्लेट बहुत ज़्यादा है।", { pose: "present", mood: "happy" });
  add("अब आपकी बारी। StudentController में एक और एंडपॉइंट जोड़िए, और ट्रेस कीजिए कि रिक्वेस्ट कहाँ से गुज़रती है।", { pose: "point", mood: "excited", props: [{ type: "rocket" }] });
  add("अगला कदम: हम सीधे Spring Boot पर जाएँगे, उसके फ़ीचर्स और असली प्रोजेक्ट्स के साथ।", { pose: "present", mood: "excited", ...steps(["Spring Core ✓", "Spring MVC ✓", "आंतरिक आर्किटेक्चर ✓", "अब: Spring Boot"], 3) });
  add("अगर कुछ समझ न आया हो, तो कमेंट में पूछिए। और अगला वीडियो मिस मत कीजिए।", { pose: "celebrate", mood: "happy" });
};
