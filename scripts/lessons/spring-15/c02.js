// Chapters 4-6: how plain Servlets worked, the DispatcherServlet idea, HandlerMapping.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const CHORES = ["पैरामीटर जाँचना", "JSON से Java ऑब्जेक्ट", "रिस्पॉन्स बनाना", "Java से JSON", "एक्सेप्शन हैंडलिंग"];
const SERVLET_MAP = ["Tomcat में:", "/users  →  UserServlet", "/orders  →  OrderServlet", "/payments  →  PaymentServlet"];

module.exports = () => {
  // ═══════════════ 4 · The old way ═══════════════
  chapter("4 · पुराने Servlets की दिक्कत", "server");
  add("पहले देखते हैं कि बिना Spring के चीज़ें कैसे चलती थीं।", { pose: "present" });
  add("Tomcat के अंदर कई Servlets रहते हैं: UserServlet, OrderServlet और PaymentServlet।", { pose: "point", ...scene("lab", [{ asset: "server", x: 18, y: 52, size: 40, label: "Tomcat" }, { asset: "gear", x: 50, y: 30, size: 28, label: "UserServlet", tint: "blue" }, { asset: "gear", x: 50, y: 56, size: 28, label: "OrderServlet", tint: "green" }, { asset: "gear", x: 50, y: 82, size: 28, label: "PaymentServlet", tint: "gold" }]) });
  add("हर रिक्वेस्ट सबसे पहले Tomcat के पास आती है।", { pose: "present", ...flow(["Client", "Tomcat"], 1, "रिक्वेस्ट") });
  add("Tomcat उसे पढ़ता है: एंडपॉइंट क्या है, मेथड क्या है, पैरामीटर कौन से हैं।", { pose: "point", ...browser("GET /users?id=1", "page", ["मेथड: GET", "एंडपॉइंट: /users", "पैरामीटर: id = 1"], "Tomcat रिक्वेस्ट पढ़ता है") });
  add("फिर वो दो ऑब्जेक्ट बनाता है: HttpServletRequest और HttpServletResponse।", { pose: "present", ...steps(["HttpServletRequest", "HttpServletResponse"], 0) });
  add("Tomcat के पास एक मैपिंग होती है, जो बताती है कि कौन सा एंडपॉइंट किस Servlet का है।", { pose: "point", ...term(SERVLET_MAP, "Tomcat की मैपिंग") });
  add("वो दोनों ऑब्जेक्ट उसी Servlet को थमा देता है, जो एंडपॉइंट से मैच हुआ।", { pose: "present", ...flow(["Client", "Tomcat", "UserServlet"], 2, "req + res") });
  add("Servlet रिक्वेस्ट से इनपुट पढ़ता है, और जवाब रिस्पॉन्स ऑब्जेक्ट में लिख देता है।", { pose: "point", ...snap("UserServlet.java", "java", ["protected void doGet(HttpServletRequest req,", "                     HttpServletResponse res) {", "  // req से पढ़ो, res में लिखो", "}"], { highlight: [0, 1] }) });
  add("ध्यान दीजिए, doGet और doPost कुछ वापस नहीं करते। वो void हैं।", { pose: "smug", ttsText: "ध्यान दीजिए, डू गेट और डू पोस्ट कुछ वापस नहीं करते। वो वॉइड हैं।", ...snap("UserServlet.java", "java", ["protected void doGet(HttpServletRequest req,", "                     HttpServletResponse res) {", "  // req से पढ़ो, res में लिखो", "}"], { highlight: [0] }) });
  add("फिर भी जवाब क्लाइंट तक पहुँचता है, क्योंकि रिस्पॉन्स का रेफ़रेंस Tomcat के पास भी है।", { pose: "present", ...flow(["Client", "Tomcat", "Servlet"], 0, "रिस्पॉन्स") });
  add("आख़िर में Tomcat भरा हुआ रिस्पॉन्स लेकर क्लाइंट को HTTP जवाब भेज देता है।", { pose: "present", mood: "happy", ...flow(["Client", "Tomcat"], 0, "HTTP जवाब") });
  add("सुनने में ठीक लगता है। पर इसमें एक बड़ी दिक्कत छिपी है।", { pose: "think", mood: "worried" });
  add("हर Servlet को बिज़नेस लॉजिक के साथ-साथ ये सारे काम भी करने पड़ते हैं।", { pose: "point", ...steps(CHORES, 0) });
  add("पहला, आए हुए रिक्वेस्ट पैरामीटर्स की जाँच करना।", { pose: "present", ...steps(CHORES, 0) });
  add("दूसरा, रिक्वेस्ट बॉडी के JSON को Java ऑब्जेक्ट में बदलना।", { pose: "present", ...steps(CHORES, 1) });
  add("तीसरा, जवाब बनाना: स्टेटस कोड, बॉडी, सब कुछ।", { pose: "point", ...steps(CHORES, 2) });
  add("चौथा, Java ऑब्जेक्ट को वापस JSON में बदलना।", { pose: "present", ...steps(CHORES, 3) });
  add("और पाँचवाँ, एक्सेप्शन को सँभालना।", { pose: "point", ...steps(CHORES, 4) });
  add("अगर सौ Servlets हों, तो यही सारा कोड सौ बार दोहराया जाएगा।", { pose: "shrug", mood: "worried", ...alert("warning", "सौ Servlets, सौ बार वही कोड", "बिज़नेस लॉजिक से अलग, बार-बार") });
  add("तभी Spring ने सोचा: ये सारा दोहराव एक ही जगह क्यों न हो?", { pose: "think", props: [{ type: "bulb" }] });

  // ═══════════════ 5 · The DispatcherServlet ═══════════════
  chapter("5 · एक ही दरवाज़ा: DispatcherServlet", "server");
  add("Spring का जवाब है: Tomcat वैसा ही रहेगा, पर रिक्वेस्ट सिर्फ़ एक Servlet को जाएगी।", { pose: "present", mood: "excited", ...flow(["Client", "Tomcat", "DispatcherServlet"], 2, "हर रिक्वेस्ट") });
  add("उस इकलौते Servlet का नाम है DispatcherServlet।", { pose: "point", mood: "happy", ...flow(["Client", "Tomcat", "DispatcherServlet"], 2, "") });
  add("अब सारा दोहराव वाला काम वही सँभालता है, पूरे ऐप के लिए, एक ही जगह।", { pose: "present", ...steps(CHORES, 4) });
  add("पैरामीटर की जाँच, JSON से Java, जवाब बनाना, Java से JSON, और एक्सेप्शन हैंडलिंग।", { pose: "point", ...steps(CHORES, 2) });
  add("और Servlets की जगह अब Controllers आ गए। यहाँ हम Servlets से नहीं, Controllers से खेलते हैं।", { pose: "smug", ...compare("beforeAfter", [{ title: "पहले", points: ["UserServlet", "OrderServlet", "PaymentServlet"] }, { title: "अब", points: ["UserController", "OrderController", "PaymentController"] }]) });
  add("UserServlet की जगह UserController, OrderServlet की जगह OrderController।", { pose: "present", ...compare("beforeAfter", [{ title: "पहले", points: ["UserServlet", "OrderServlet", "PaymentServlet"] }, { title: "अब", points: ["UserController", "OrderController", "PaymentController"] }]) });
  add("कौन सी रिक्वेस्ट किस Controller के पास जाएगी, ये तय करता है DispatcherServlet।", { pose: "point", ...flow(["Tomcat", "DispatcherServlet", "UserController"], 2, "रिक्वेस्ट") });
  add("Controller में एंडपॉइंट वाले मेथड होते हैं, जैसे यूज़र बनाने वाला createUser।", { pose: "present", ...snap("UserController.java", "java", ["@RestController", "public class UserController {", "  @PostMapping(\"/users\")", "  public User createUser(@RequestBody User user) {", "    // यूज़र बनाओ", "  }", "}"], { highlight: [2, 3] }) });
  add("Controller सीधे Tomcat से कभी बात नहीं करता। बीच में हमेशा DispatcherServlet रहता है।", { pose: "point", ...flow(["Tomcat", "DispatcherServlet", "Controller"], 1, "") });
  add("अब समझिए @RequestBody का जादू। JSON को Java ऑब्जेक्ट बनाने का काम पहले हो चुका होता है।", { pose: "smug", mood: "excited", ...snap("UserController.java", "java", ["@RestController", "public class UserController {", "  @PostMapping(\"/users\")", "  public User createUser(@RequestBody User user) {", "    // यूज़र बनाओ", "  }", "}"], { highlight: [3] }) });
  add("वो कोई जादू नहीं है। DispatcherServlet ने पहले ही बदलाव कर दिया था।", { pose: "present", mood: "happy" });
  add("तो DispatcherServlet एक फ्रंट डोर है: सारी रिक्वेस्ट इसी से अंदर आती हैं।", { pose: "present", ...scene("room", [{ asset: "globe", x: 18, y: 52, size: 36, label: "Client" }, { asset: "server", x: 50, y: 52, size: 40, label: "DispatcherServlet", tint: "gold" }, { asset: "laptop", x: 82, y: 52, size: 36, label: "Controllers" }], [{ from: [30, 52], to: [40, 52] }, { from: [60, 52], to: [72, 52] }]) });
  add("अब एक छोटा सवाल। रुककर सोचिए।", { pose: "think", mood: "excited" });
  add("DispatcherServlet को आख़िर बनाया क्यों गया?", { pose: "point", ...quiz("Spring में एक ही DispatcherServlet क्यों रखा गया?", ["Tomcat में सिर्फ़ एक Servlet चल सकता है", "दोहराव वाला काम एक जगह करने के लिए", "ताकि पोर्ट आपस में न टकराएँ", "क्योंकि Servlets बहुत धीमे होते हैं"], 1) });
  add("सही जवाब है दूसरा। सारा दोहराव एक जगह, ताकि हर Controller सिर्फ़ अपना काम करे।", { pose: "celebrate", mood: "happy", ...compare("versus", [{ title: "बिना DispatcherServlet", points: ["हर Servlet में वही कोड"] }, { title: "DispatcherServlet के साथ", points: ["दोहराव एक जगह", "Controller सिर्फ़ अपना काम"] }]) });

  // ═══════════════ 6 · HandlerMapping ═══════════════
  chapter("6 · HandlerMapping: मैपिंग टेबल", "classroom");
  add("DispatcherServlet खुद सिर्फ़ एक एंट्री पॉइंट है। काम के लिए वो कई कंपोनेंट्स इस्तेमाल करता है।", { pose: "present", ...flow(["Tomcat", "DispatcherServlet", "HandlerMapping"], 2, "") });
  add("उनमें सबसे पहला है HandlerMapping।", { pose: "point", mood: "excited" });
  add("HandlerMapping एक मैपिंग टेबल बनाता है: कौन सा एंडपॉइंट और HTTP मेथड, किस Controller मेथड के पास जाएगा।", { pose: "present", ...table("HandlerMapping की टेबल", ["HTTP मेथड", "एंडपॉइंट", "Controller मेथड"], [["GET", "/students", "getAllStudents"], ["POST", "/students", "createStudent"]], 0) });
  add("जैसे, GET /students जाएगा StudentController के getAllStudents में।", { pose: "point", ttsText: "जैसे, गेट स्लैश स्टूडेंट्स जाएगा स्टूडेंट कंट्रोलर के गेट ऑल स्टूडेंट्स में।", ...table("HandlerMapping की टेबल", ["HTTP मेथड", "एंडपॉइंट", "Controller मेथड"], [["GET", "/students", "getAllStudents"], ["POST", "/students", "createStudent"]], 0) });
  add("और POST /students जाएगा createStudent में। बस इतनी सी टेबल है।", { pose: "present", ttsText: "और पोस्ट स्लैश स्टूडेंट्स जाएगा क्रिएट स्टूडेंट में। बस इतनी सी टेबल है।", ...table("HandlerMapping की टेबल", ["HTTP मेथड", "एंडपॉइंट", "Controller मेथड"], [["GET", "/students", "getAllStudents"], ["POST", "/students", "createStudent"]], 1) });
  add("अब सवाल ये है कि ये टेबल बनती कैसे है? क्रम समझना बहुत ज़रूरी है।", { pose: "think", mood: "excited" });
  add("पहले IoC कंटेनर सारे बीन्स बनाता है: Controller, Service और Repository।", { pose: "present", ...steps(["IoC कंटेनर बीन्स बनाता है", "HandlerMapping Controllers स्कैन करता है", "मैपिंग टेबल तैयार"], 0) });
  add("@Controller और @RestController के अंदर @Component होता है, इसलिए ये भी बीन बनते हैं।", { pose: "point", ...steps(["@Component", "@Controller, @RestController", "@Service, @Repository"], 1) });
  add("बीन्स बनने के बाद HandlerMapping सारे Controller बीन्स को स्कैन करता है।", { pose: "present", ...steps(["IoC कंटेनर बीन्स बनाता है", "HandlerMapping Controllers स्कैन करता है", "मैपिंग टेबल तैयार"], 1) });
  add("वो ढूँढता है उन मेथड्स को, जिन पर @GetMapping, @PostMapping, @PutMapping या @DeleteMapping लगा है।", { pose: "point", ...snap("StudentController.java", "java", ["@GetMapping(\"/students\")", "@PostMapping(\"/students\")", "@PutMapping(\"/students/{id}\")", "@DeleteMapping(\"/students/{id}\")"], { highlight: [0, 1, 2, 3] }) });
  add("हर मिले हुए मेथड से टेबल में एक पंक्ति बन जाती है। टेबल तैयार।", { pose: "present", mood: "happy", ...steps(["IoC कंटेनर बीन्स बनाता है", "HandlerMapping Controllers स्कैन करता है", "मैपिंग टेबल तैयार"], 2) });
  add("तो एक सवाल: Controller का ऑब्जेक्ट बनाता कौन है? IoC कंटेनर।", { pose: "think", ...flow(["IoC कंटेनर", "Controller बीन"], 1, "बनाता है") });
  add("और उस Controller के मेथड को बुलाता कौन है? DispatcherServlet।", { pose: "point", ...flow(["DispatcherServlet", "Controller बीन"], 1, "बुलाता है") });
  add("रिक्वेस्ट आने पर DispatcherServlet HandlerMapping से पूछता है: ये किसके पास जाए?", { pose: "present", ...flow(["DispatcherServlet", "HandlerMapping"], 1, "कौन सा मेथड?") });
  add("HandlerMapping टेबल देखता है, और Controller व मेथड का नाम बता देता है।", { pose: "point", ...flow(["DispatcherServlet", "HandlerMapping"], 0, "Controller + मेथड") });
  add("DispatcherServlet अंदर से और भी कंपोनेंट्स इस्तेमाल करता है, पर उनके नाम याद रखने की ज़रूरत नहीं।", { pose: "shrug", mood: "happy" });
  add("बस दो नाम याद रखिए: DispatcherServlet और HandlerMapping।", { pose: "present", mood: "excited", ...steps(["DispatcherServlet: एंट्री पॉइंट", "HandlerMapping: मैपिंग टेबल"], 1) });
  add("अब एक और सवाल। रुककर सोचिए।", { pose: "think" });
  add("HandlerMapping की टेबल कब बनती है?", { pose: "point", ...quiz("HandlerMapping की मैपिंग टेबल कब बनती है?", ["हर रिक्वेस्ट आने पर नए सिरे से", "Tomcat शुरू होने से भी पहले", "बीन्स बनने के बाद, Controllers स्कैन करके", "जब Postman से रिक्वेस्ट भेजी जाए"], 2) });
  add("सही जवाब तीसरा। पहले बीन्स बनते हैं, फिर Controllers स्कैन होकर टेबल बनती है।", { pose: "celebrate", mood: "happy", ...steps(["IoC कंटेनर बीन्स बनाता है", "HandlerMapping Controllers स्कैन करता है", "मैपिंग टेबल तैयार"], 2) });
};
