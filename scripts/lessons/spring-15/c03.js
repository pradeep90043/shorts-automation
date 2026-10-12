// Chapters 7-8: request body, path variable, query parameter, the return trip, and the final architecture diagram.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const WAYS = ["रिक्वेस्ट बॉडी (JSON)", "पाथ वेरिएबल", "क्वेरी पैरामीटर"];
const USER_CLASS = ["public class User {", "  private int id;", "  private String name;", "}"];

module.exports = () => {
  // ═══════════════ 7 · Where the data comes from ═══════════════
  chapter("7 · डेटा कैसे पहुँचता है", "classroom");
  add("अब देखते हैं कि क्लाइंट का डेटा Controller तक कैसे पहुँचता है। तीन तरीके हैं।", { pose: "present", ...steps(WAYS, 0) });
  add("पहला तरीका, रिक्वेस्ट बॉडी। POST, PUT या PATCH के साथ JSON भेजा जाता है।", { pose: "point", ...browser("POST /users", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\"", "}"]) });
  add("इस JSON को Java ऑब्जेक्ट में कौन बदलता है? DispatcherServlet, Jackson लाइब्रेरी की मदद से।", { pose: "present", ...flow(["JSON", "Jackson", "User ऑब्जेक्ट"], 2, "id=1, name") });
  add("मान लीजिए हमारी क्लास में id और name नाम के दो फ़ील्ड हैं।", { pose: "point", ...snap("User.java", "java", USER_CLASS, { highlight: [1, 2] }) });
  add("JSON की कीज़ और क्लास के फ़ील्ड्स के नाम मिलते हैं, इसलिए ऑब्जेक्ट अपने आप भर जाता है।", { pose: "smug", mood: "happy", ...compare("versus", [{ title: "JSON", points: ["id: 1", "name: Aditya"] }, { title: "User ऑब्जेक्ट", points: ["id = 1", "name = Aditya"] }]) });
  add("दूसरा तरीका, पाथ वेरिएबल। जैसे एंडपॉइंट पर लिखा है /users/1।", { pose: "present", ttsText: "दूसरा तरीका, पाथ वेरिएबल। जैसे एंडपॉइंट पर लिखा है यूज़र्स स्लैश एक।", ...steps(WAYS, 1) });
  add("HandlerMapping इसे /users/{id} वाले पैटर्न से मिलाता है, और एक को id में बाँध देता है।", { pose: "point", ttsText: "हैंडलर मैपिंग इसे यूज़र्स स्लैश आईडी वाले पैटर्न से मिलाता है, और एक को आईडी में बाँध देता है।", ...table("पाथ वेरिएबल", ["रिक्वेस्ट", "पैटर्न", "id"], [["/users/1", "/users/{id}", "1"]], 0) });
  add("अंदर ये काम HandlerMethodArgumentResolver करता है। नाम लंबा है, याद मत रखिए।", { pose: "shrug", mood: "happy" });
  add("तीसरा तरीका, क्वेरी पैरामीटर। जैसे /users?id=1, यानी प्रश्नचिह्न के बाद id।", { pose: "present", ttsText: "तीसरा तरीका, क्वेरी पैरामीटर। जैसे यूज़र्स के बाद प्रश्नचिह्न लगाकर आईडी बराबर एक।", ...steps(WAYS, 2) });
  add("इसके लिए Spring को कुछ करना ही नहीं पड़ता, क्योंकि Tomcat इसे पहले ही सँभाल चुका होता है।", { pose: "point", ...flow(["Tomcat", "HttpServletRequest"], 1, "id=1") });
  add("क्वेरी पैरामीटर Tomcat ने रिक्वेस्ट ऑब्जेक्ट में रख दिया था, वहीं से मिल जाता है।", { pose: "present", mood: "happy" });
  add("तीनों तरीकों में काम कौन करता है, एक नज़र में देखिए।", { pose: "point", ...table("किसका काम", ["डेटा", "कौन सँभालता है"], [["रिक्वेस्ट बॉडी", "DispatcherServlet + Jackson"], ["पाथ वेरिएबल", "HandlerMapping"], ["क्वेरी पैरामीटर", "Tomcat"]], 0) });
  add("अब वापसी का सफ़र। Controller अपना काम Service को देता है, Service Repository को।", { pose: "present", ...flow(["Controller", "Service", "Repository", "Database"], 3, "रिक्वेस्ट") });
  add("Repository डेटाबेस से डेटा लाता है, और जवाब उल्टी दिशा में लौटता है।", { pose: "point", ...flow(["Controller", "Service", "Repository", "Database"], 0, "जवाब") });
  add("Controller जवाब का ऑब्जेक्ट DispatcherServlet को लौटा देता है।", { pose: "present", ...flow(["Tomcat", "DispatcherServlet", "Controller"], 1, "Java ऑब्जेक्ट") });
  add("DispatcherServlet उस Java ऑब्जेक्ट को वापस JSON में बदलता है।", { pose: "point", ...flow(["Java ऑब्जेक्ट", "Jackson", "JSON"], 2, "बदलाव") });
  add("फिर JSON और स्टेटस कोड को HttpServletResponse में भर देता है।", { pose: "present", ...flow(["DispatcherServlet", "HttpServletResponse"], 1, "200 + JSON") });
  add("Tomcat भरा हुआ रिस्पॉन्स उठाता है, और क्लाइंट को भेज देता है।", { pose: "present", mood: "happy", ...flow(["Client", "Tomcat", "DispatcherServlet"], 0, "जवाब") });
  add("ये इसलिए चलता है, कि Servlet के मेथड void हैं, और रिस्पॉन्स ऑब्जेक्ट सबके बीच साझा है।", { pose: "smug", ttsText: "ये इसलिए चलता है, कि सर्वलेट के मेथड वॉइड हैं, और रिस्पॉन्स ऑब्जेक्ट सबके बीच साझा है।" });
  add("यानी DispatcherServlet, Tomcat और Controller के बीच की पहली परत है।", { pose: "present", ...flow(["Tomcat", "DispatcherServlet", "Controller"], 1, "") });
  add("और सही मेथड चुनने के लिए वो HandlerMapping को इस्तेमाल करता है।", { pose: "point", ...flow(["DispatcherServlet", "HandlerMapping", "Controller"], 2, "") });

  // ═══════════════ 8 · The final diagram ═══════════════
  chapter("8 · पूरा आर्किटेक्चर एक नज़र में", "stage");
  add("अब सब जोड़कर पूरा नक्शा देखते हैं। पहला कदम, क्लाइंट रिक्वेस्ट भेजता है।", { pose: "present", mood: "excited", ...flow(["Client", "Tomcat", "DispatcherServlet"], 1, "GET /users") });
  add("Tomcat पोर्ट 8080 पर सुनता है, और रिक्वेस्ट व रिस्पॉन्स ऑब्जेक्ट्स बनाता है।", { pose: "point", ttsText: "टॉमकैट पोर्ट आठ हज़ार अस्सी पर सुनता है, और रिक्वेस्ट व रिस्पॉन्स ऑब्जेक्ट्स बनाता है।", ...flow(["Client", "Tomcat", "DispatcherServlet"], 1, "req + res") });
  add("वो दोनों ऑब्जेक्ट्स सीधे DispatcherServlet को दे दिए जाते हैं।", { pose: "present", ...flow(["Client", "Tomcat", "DispatcherServlet"], 2, "req + res") });
  add("DispatcherServlet HandlerMapping से पूछता है: कौन सा Controller और कौन सा मेथड?", { pose: "point", ...flow(["DispatcherServlet", "HandlerMapping"], 1, "कौन सा मेथड?") });
  add("HandlerMapping अपनी टेबल देखकर जवाब देता है।", { pose: "present", ...flow(["DispatcherServlet", "HandlerMapping"], 0, "UserController.get") });
  add("IoC कंटेनर बगल से बीन्स की जानकारी देता रहता है, जिससे ये टेबल बनी थी।", { pose: "point", ...flow(["IoC कंटेनर", "HandlerMapping", "टेबल"], 2, "बीन्स") });
  add("DispatcherServlet ज़रूरी जाँच और JSON का बदलाव करके Controller मेथड को बुलाता है।", { pose: "present", ...flow(["DispatcherServlet", "Controller", "Service", "Repository"], 1, "मेथड कॉल") });
  add("Controller से Service, Service से Repository, और Repository से डेटाबेस।", { pose: "point", ...flow(["DispatcherServlet", "Controller", "Service", "Repository"], 3, "") });
  add("जवाब उसी रास्ते लौटता है और Controller से DispatcherServlet तक पहुँचता है।", { pose: "present", ...flow(["DispatcherServlet", "Controller", "Service", "Repository"], 0, "जवाब") });
  add("DispatcherServlet उसे JSON बनाकर HttpServletResponse में भर देता है।", { pose: "point", ...flow(["Tomcat", "DispatcherServlet"], 1, "JSON") });
  add("आख़िर में Tomcat वही रिस्पॉन्स लेकर क्लाइंट तक पहुँचा देता है।", { pose: "present", mood: "happy", ...flow(["Client", "Tomcat", "DispatcherServlet"], 0, "200 OK") });
  add("दस कदमों की ये पूरी यात्रा ही Spring MVC का आर्किटेक्चर है।", { pose: "celebrate", mood: "excited", ...steps(["Client → Tomcat", "Tomcat → DispatcherServlet", "HandlerMapping से मेथड", "Controller → Service → Repository", "JSON बनकर क्लाइंट तक"], 4) });
  add("दो और सवाल, ताकि ये पक्का हो जाए।", { pose: "think" });
  add("JSON को Java ऑब्जेक्ट कौन बनाता है?", { pose: "point", ...quiz("रिक्वेस्ट बॉडी के JSON को Java ऑब्जेक्ट में कौन बदलता है?", ["Tomcat अपने आप", "HandlerMapping", "DispatcherServlet, Jackson की मदद से", "Repository"], 2) });
  add("सही जवाब तीसरा। Tomcat सिर्फ़ रिक्वेस्ट पढ़ता है, JSON का बदलाव DispatcherServlet का काम है।", { pose: "celebrate", mood: "happy" });
  add("अब दूसरा सवाल। क्वेरी पैरामीटर Spring पहुँचने से पहले ही कहाँ रखा जा चुका होता है?", { pose: "think" });
  add("क्वेरी पैरामीटर किसके पास पहले से होता है?", { pose: "point", ...quiz("क्वेरी पैरामीटर Spring से पहले कौन सँभाल चुका होता है?", ["HandlerMapping", "Tomcat, HttpServletRequest में", "Jackson", "ViewResolver"], 1) });
  add("सही जवाब दूसरा। Tomcat ने उसे HttpServletRequest में पहले ही रख दिया था।", { pose: "celebrate", mood: "happy" });
  add("सिद्धांत पूरा हुआ। अब इसे बिना Spring Boot के खुद बनाकर चलाते हैं।", { pose: "present", mood: "excited", props: [{ type: "rocket" }] });
};
