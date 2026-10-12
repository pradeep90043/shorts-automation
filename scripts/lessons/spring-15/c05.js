// Chapters 11-13: WebConfig and the main method (what Spring Boot hides), running and testing, @Controller vs @RestController.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const WEBCONFIG = ["@Configuration", "@ComponentScan(basePackages = \"com.example\")", "@EnableWebMvc", "public class WebConfig {", "}"];
const MAIN_STEPS = ["Tomcat बनाओ, पोर्ट 8080", "Context path और base doc", "Spring कंटेनर बनाओ", "DispatcherServlet जोड़ो", "Servlet को \"/\" से जोड़ो", "Tomcat चालू करो"];
const M1 = ["Tomcat tomcat = new Tomcat();", "tomcat.setPort(8080);", "tomcat.getConnector();", "", "String contextPath = \"\";", "String baseDoc =", "  new File(\"src/main/webapp\").getAbsolutePath();", "Context context =", "  tomcat.addContext(contextPath, baseDoc);"];
const M2 = ["AnnotationConfigWebApplicationContext springContext =", "    new AnnotationConfigWebApplicationContext();", "springContext.register(WebConfig.class);", "", "DispatcherServlet dispatcherServlet =", "    new DispatcherServlet(springContext);", "Tomcat.addServlet(context, \"dispatcherServlet\",", "    dispatcherServlet);", "context.addServletMappingDecoded(\"/\",", "    \"dispatcherServlet\");"];
const M3 = ["tomcat.start();", "System.out.println(\"Tomcat started on port 8080\");", "tomcat.getServer().await();"];

module.exports = () => {
  // ═══════════════ 11 · What Spring Boot hides ═══════════════
  chapter("11 · जो Spring Boot छिपाता है", "office");
  add("पहला हिस्सा, WebConfig। ये एक कॉन्फ़िगरेशन क्लास है।", { pose: "present", ...snap("WebConfig.java", "java", WEBCONFIG, { highlight: [0, 3] }) });
  add("इस पर तीन एनोटेशन लगते हैं। पहला @Configuration।", { pose: "point", ...snap("WebConfig.java", "java", WEBCONFIG, { highlight: [0] }) });
  add("दूसरा @ComponentScan, जो बताता है कि बीन्स कहाँ ढूँढने हैं।", { pose: "present", ...snap("WebConfig.java", "java", WEBCONFIG, { highlight: [1] }) });
  add("ये Repository, Service और Controller को ढूँढकर IoC कंटेनर में उनके बीन्स बना देता है।", { pose: "point", ...flow(["@ComponentScan", "Repository, Service, Controller", "IoC कंटेनर"], 2, "बीन्स") });
  add("तीसरा @EnableWebMvc। इसी से @RequestBody, @GetMapping और @PostMapping चालू होते हैं।", { pose: "present", ...snap("WebConfig.java", "java", WEBCONFIG, { highlight: [2] }) });
  add("इसके बिना ये एनोटेशन्स लगे तो रहेंगे, पर कुछ करेंगे नहीं।", { pose: "smug", mood: "worried", ...alert("warning", "@EnableWebMvc के बिना", "एनोटेशन्स चालू ही नहीं होते") });
  add("Spring Boot में यही सब @SpringBootApplication करता है, जिसके अंदर @EnableAutoConfiguration है।", { pose: "point", ...compare("versus", [{ title: "सिर्फ़ Spring MVC", points: ["@Configuration", "@ComponentScan", "@EnableWebMvc"] }, { title: "Spring Boot", points: ["@SpringBootApplication", "बाकी सब अपने आप"] }]) });
  add("अब दूसरा हिस्सा, main मेथड। यहाँ छह काम खुद करने होंगे।", { pose: "present", ...steps(MAIN_STEPS, 0) });
  add("पहला, Tomcat का ऑब्जेक्ट बनाओ और पोर्ट 8080 रखो।", { pose: "point", ttsText: "पहला, टॉमकैट का ऑब्जेक्ट बनाओ और पोर्ट आठ हज़ार अस्सी रखो।", ...snap("Main.java", "java", M1.slice(0, 3), { highlight: [0, 1] }) });
  add("फिर getConnector बुलाओ। असल में यही कनेक्टर उस पोर्ट पर सुनता है।", { pose: "present", ...snap("Main.java", "java", M1.slice(0, 3), { highlight: [2] }) });
  add("दूसरा, कॉन्टेक्स्ट पाथ। Tomcat में कई ऐप रह सकते हैं, हर ऐप का एक कॉन्टेक्स्ट पाथ होता है।", { pose: "point", ...scene("lab", [{ asset: "server", x: 18, y: 52, size: 40, label: "Tomcat" }, { asset: "laptop", x: 50, y: 28, size: 26, label: "App1", tint: "blue" }, { asset: "laptop", x: 50, y: 55, size: 26, label: "App2", tint: "green" }, { asset: "laptop", x: 50, y: 82, size: 26, label: "App3", tint: "gold" }]) });
  add("हमारा ऐप Tomcat के अंदर ही है और अकेला है, इसलिए कॉन्टेक्स्ट पाथ खाली रखते हैं।", { pose: "present", ...snap("Main.java", "java", M1.slice(0, 5), { highlight: [4] }) });
  add("साथ में एक base doc चाहिए, यानी एक असली फ़ोल्डर, जिसका पाथ src/main/webapp है।", { pose: "point", ...snap("Main.java", "java", M1.slice(0, 7), { highlight: [5, 6] }) });
  add("कॉन्टेक्स्ट पाथ खाली हो, तब भी Tomcat को एक असली फ़ोल्डर चाहिए। इसलिए खाली फ़ोल्डर बना लीजिए।", { pose: "shrug", mood: "worried", ...alert("warning", "Tomcat को असली फ़ोल्डर चाहिए", "src/main/webapp बना लीजिए, खाली चलेगा") });
  add("इन दोनों से addContext बुलाओ, और हमें मिलता है एक Context ऑब्जेक्ट।", { pose: "present", ...snap("Main.java", "java", M1, { highlight: [7, 8] }) });
  add("तीसरा, Spring का IoC कंटेनर। यहाँ AnnotationConfigWebApplicationContext चाहिए।", { pose: "point", ...snap("Main.java", "java", M2.slice(0, 2), { highlight: [0, 1] }) });
  add("AnnotationConfigApplicationContext वाला कंटेनर कंपाइलर नहीं मानेगा। वो Spring Core का है।", { pose: "smug", ...compare("versus", [{ title: "Spring Core", points: ["AnnotationConfig", "ApplicationContext"] }, { title: "वेब ऐप", points: ["AnnotationConfig", "WebApplicationContext"] }]) });
  add("कंटेनर वही है, बस वेब के लिए उसका इम्प्लीमेंटेशन अलग है।", { pose: "present", mood: "happy" });
  add("इसमें register से WebConfig जोड़ दो, ताकि वो सारा स्कैनिंग शुरू कर सके।", { pose: "point", ...snap("Main.java", "java", M2.slice(0, 3), { highlight: [2] }) });
  add("चौथा, DispatcherServlet का ऑब्जेक्ट बनाओ, और उसे Spring कंटेनर दे दो।", { pose: "present", ...snap("Main.java", "java", M2.slice(0, 6), { highlight: [4, 5] }) });
  add("कंटेनर देना ज़रूरी है, वरना HandlerMapping बीन्स को स्कैन ही नहीं कर पाएगा।", { pose: "point", mood: "worried", ...alert("warning", "कंटेनर के बिना", "HandlerMapping को Controllers नहीं मिलेंगे") });
  add("इसे addServlet से Tomcat में जोड़ते हैं: कॉन्टेक्स्ट, एक नाम, और Servlet का ऑब्जेक्ट।", { pose: "present", ...snap("Main.java", "java", M2.slice(0, 8), { highlight: [6, 7] }) });
  add("पाँचवाँ, मैपिंग। स्लैश का मतलब है कि हर रिक्वेस्ट इसी Servlet के पास जाएगी।", { pose: "point", ttsText: "पाँचवाँ, मैपिंग। स्लैश का मतलब है कि हर रिक्वेस्ट इसी सर्वलेट के पास जाएगी।", ...snap("Main.java", "java", M2, { highlight: [8, 9] }) });
  add("हर पाथ स्लैश से ही शुरू होता है, इसलिए एक ही मैपिंग सब कुछ DispatcherServlet तक पहुँचा देती है।", { pose: "present", ...flow(["हर रिक्वेस्ट", "Tomcat", "DispatcherServlet"], 2, "/ से शुरू") });
  add("छठा, Tomcat चालू करो। start बुलाओ, और LifecycleException के लिए throws लगा दो।", { pose: "point", ...snap("Main.java", "java", M3.slice(0, 1), { highlight: [0] }) });
  add("एक संदेश भी छाप देते हैं। Spring Boot ये अपने आप लॉग कर देता है, यहाँ हाथ से करना है।", { pose: "present", ...snap("Main.java", "java", M3.slice(0, 2), { highlight: [1] }) });
  add("आख़िर में getServer().await(), ताकि सर्वर बंद न हो और सुनता रहे।", { pose: "point", ...snap("Main.java", "java", M3, { highlight: [2] }) });
  add("ये छह कदम हैं जो Spring Boot आपके लिए चुपचाप कर देता है।", { pose: "smug", mood: "happy", ...steps(MAIN_STEPS, 5) });

  // ═══════════════ 12 · Run and test ═══════════════
  chapter("12 · चलाकर देखते हैं", "office");
  add("अब चलाते हैं। कंसोल में लिखा आता है: Tomcat started on port 8080।", { pose: "present", mood: "excited", ttsText: "अब चलाते हैं। कंसोल में लिखा आता है: टॉमकैट स्टार्टेड ऑन पोर्ट आठ हज़ार अस्सी।", ...term(["Tomcat started on port 8080"], "Console") });
  add("Postman से POST भेजते हैं, बॉडी में id, नाम और ईमेल के साथ।", { pose: "point", ...browser("POST localhost:8080/students", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"email\": \"aditya@gmail.com\"", "}"]) });
  add("जवाब में 200 OK आता है, और वही Student वापस मिलता है।", { pose: "present", mood: "happy", ...browser("200 OK", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\"", "}"]) });
  add("एक और Student, Rohit, id दो के साथ भेजते हैं। ये भी बन जाता है।", { pose: "point", ...browser("POST localhost:8080/students", "json", ["{", "  \"id\": 2,", "  \"name\": \"Rohit\"", "}"]) });
  add("अब GET। पहले id से एक Student माँगते हैं, तो Aditya मिलता है।", { pose: "present", ...browser("GET localhost:8080/students/1", "json", ["{ \"id\": 1, \"name\": \"Aditya\" }"]) });
  add("id दो पर Rohit मिलता है। पाथ वेरिएबल ठीक काम कर रहा है।", { pose: "point", mood: "happy", ...browser("GET localhost:8080/students/2", "json", ["{ \"id\": 2, \"name\": \"Rohit\" }"]) });
  add("और बिना id के GET पर दोनों Students की पूरी लिस्ट आती है।", { pose: "present", ...browser("GET localhost:8080/students", "json", ["[", "  { \"id\": 1, \"name\": \"Aditya\" },", "  { \"id\": 2, \"name\": \"Rohit\" }", "]"]) });
  add("एक बात याद रखिए। ऐप दोबारा चलाने पर HashMap खाली हो जाता है, इसलिए डेटा फिर से भेजना पड़ता है।", { pose: "shrug", mood: "worried", ...alert("warning", "डेटा सिर्फ़ मेमोरी में है", "ऐप रीस्टार्ट = HashMap खाली") });
  add("पाथ वेरिएबल में अगर दिक्कत आए, तो @PathVariable में नाम साफ़ लिख दीजिए।", { pose: "point", ...snap("StudentController.java", "java", ["@GetMapping(\"/{id}\")", "public ResponseEntity<Student> getStudent(", "    @PathVariable(\"id\") Long id) {"], { highlight: [2] }) });
  add("पूरा ऐप चल गया, पर देखिए इसके लिए कितनी तैयारी करनी पड़ी।", { pose: "present", mood: "excited" });
  add("Spring Boot में बस spring-boot-starter-web जोड़ते हैं, और Tomcat अपने आप 8080 पर चल पड़ता है।", { pose: "smug", ttsText: "स्प्रिंग बूट में बस स्प्रिंग बूट स्टार्टर वेब जोड़ते हैं, और टॉमकैट अपने आप आठ हज़ार अस्सी पर चल पड़ता है।", ...compare("versus", [{ title: "सिर्फ़ Spring MVC", points: ["WebConfig + base package", "Tomcat खुद चालू", "main में पूरा बॉयलरप्लेट"] }, { title: "Spring Boot", points: ["एक starter", "सब कुछ अपने आप"] }]) });

  // ═══════════════ 13 · @Controller vs @RestController ═══════════════
  chapter("13 · @Controller बनाम @RestController", "classroom");
  add("एक छोटा प्रयोग। StudentController पर @RestController की जगह @Controller लगाइए।", { pose: "present", ...snap("StudentController.java", "java", ["@Controller", "@RequestMapping(\"/students\")", "public class StudentController {"], { highlight: [0] }) });
  add("अब हर उस मेथड पर @ResponseBody लगाना पड़ेगा, जो डेटा लौटाता है।", { pose: "point", ...snap("StudentController.java", "java", ["@PostMapping", "@ResponseBody", "public ResponseEntity<Student> createAStudent(", "    @RequestBody Student studentRequest) {"], { highlight: [1] }) });
  add("ऐसा करने पर ऐप पहले जैसा ही चलता है। POST और GET दोनों ठीक काम करते हैं।", { pose: "present", mood: "happy" });
  add("तो फ़र्क क्या हुआ? @RestController असल में @Controller और @ResponseBody का जोड़ है।", { pose: "smug", ...compare("versus", [{ title: "@RestController", points: ["=", "@Controller", "+ @ResponseBody"] }, { title: "मतलब", points: ["हर मेथड सीधा डेटा लौटाता है", "JSON बनकर क्लाइंट तक"] }]) });
  add("एक सवाल। रुककर सोचिए।", { pose: "think" });
  add("@RestController क्या है?", { pose: "point", ...quiz("@RestController असल में क्या है?", ["@Controller + @ResponseBody", "@Controller + @Service", "@Component + @RequestMapping", "@Repository + @Controller"], 0) });
  add("सही जवाब पहला। @RestController का मतलब है @Controller और @ResponseBody, दोनों एक साथ।", { pose: "celebrate", mood: "happy" });
};
