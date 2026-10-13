// Chapters 3-4: the demo project, the Filter interface, and the FilterChain with a first LoggingFilter.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, alert, compare, browser, snap } = L;

const POM = ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-web</artifactId>", "</dependency>"];
const CONTROLLER = [
  "@RestController",
  "@RequestMapping(\"/api/students\")",
  "public class StudentController {",
  "  private final StudentService studentService;",
  "",
  "  @PostMapping",
  "  public ResponseEntity<String> createStudent() {",
  "    studentService.createStudent();",
  "    return ResponseEntity.ok(\"Done\");",
  "  }",
  "}",
];
const SERVICE = [
  "@Service",
  "public class StudentService {",
  "  public void createStudent() {",
  "    System.out.println(\"Student Created\");",
  "  }",
  "}",
];
const CHAIN3 = ["Client", "Filter 1", "Filter 2", "Filter 3", "DispatcherServlet"];
const BACK = ["Client", "Filter 1", "Filter 2", "Filter 3", "DispatcherServlet"];

const FILTER_V0 = ["@Component", "public class LoggingFilter implements Filter {", "", "}"];
const FILTER_V1 = [
  "@Component",
  "public class LoggingFilter implements Filter {",
  "  @Override",
  "  public void doFilter(ServletRequest request,",
  "      ServletResponse response, FilterChain chain)",
  "      throws IOException, ServletException {",
  "  }",
  "}",
];
const FILTER_V2 = [
  "public void doFilter(ServletRequest request,",
  "    ServletResponse response, FilterChain chain)",
  "    throws IOException, ServletException {",
  "  System.out.println(",
  "      \"Request entered in LoggingFilter\");",
  "  chain.doFilter(request, response);",
  "  System.out.println(",
  "      \"Exiting in LoggingFilter\");",
  "}",
];

module.exports = () => {
  // ═══════════════ 3 · The demo project and the Filter interface ═══════════════
  chapter("3 · Our first filter", "classroom");
  add("Time to code. In Spring Initializr we name the project FilterDemo, choose Java 21, and add one dependency: Spring Web.",
    "अब कोड की बारी। स्प्रिंग इनिशियलाइज़र में हम प्रोजेक्ट का नाम फ़िल्टर डेमो रखते हैं, जावा इक्कीस चुनते हैं, और सिर्फ़ एक डिपेंडेंसी जोड़ते हैं, स्प्रिंग वेब।",
    { pose: "present", ...snap("pom.xml", "xml", POM, { revealFrom: 0 }) });
  add("We open the empty project in IntelliJ, and build what we already know: a controller, a service, and a repository package.",
    "खाली प्रोजेक्ट को इंटेलीजे में खोलते हैं, और वही बनाते हैं जो हम पहले से जानते हैं। कंट्रोलर, सर्विस, और रिपॉज़िटरी के पैकेज।",
    { pose: "point", ...steps(["controller", "service", "repository", "filter"], 2) });
  add("A StudentController, mapped to slash api slash students, with a POST method called createStudent.",
    "एक स्टूडेंट कंट्रोलर, जो स्लैश एपीआई स्लैश स्टूडेंट्स पर मैप है, और उसमें एक पोस्ट मेथड, क्रिएट स्टूडेंट।",
    { pose: "present", ...snap("StudentController.java", "java", CONTROLLER, { highlight: [5, 6] }) });
  add("The service just prints Student Created. We are not doing any real business logic. We only need to understand the flow.",
    "सर्विस बस स्टूडेंट क्रिएटेड प्रिंट करती है। हम कोई असली बिज़नेस लॉजिक नहीं कर रहे। हमें सिर्फ़ फ़्लो समझना है।",
    { pose: "point", ...snap("StudentService.java", "java", SERVICE, { highlight: [3] }) });
  add("The controller gets the service through the constructor, calls createStudent, and returns ok with the text Done.",
    "कंट्रोलर कंस्ट्रक्टर से सर्विस लेता है, क्रिएट स्टूडेंट बुलाता है, और ओके के साथ डन लौटा देता है।",
    { pose: "present", ...snap("StudentController.java", "java", CONTROLLER, { highlight: [7, 8] }) });
  add("We run the app and send a POST in Postman. We get Done, and the console prints Student Created.",
    "ऐप चलाते हैं, और पोस्टमैन में पोस्ट रिक्वेस्ट भेजते हैं। जवाब में डन आता है, और कंसोल में स्टूडेंट क्रिएटेड प्रिंट होता है।",
    { pose: "smug", ...term(["POST /api/students", "200 OK  Done", "Student Created"], "Postman and console") });
  add("Now we create a new package called filter, and a class in it named LoggingFilter.",
    "अब हम एक नया पैकेज बनाते हैं, फ़िल्टर, और उसमें एक क्लास, लॉगिंग फ़िल्टर।",
    { pose: "point", ...steps(["controller", "service", "repository", "filter"], 3) });
  add("We put @Component on top, so that the IoC container manages it as a bean.",
    "ऊपर कंपोनेंट एनोटेशन लगाते हैं, ताकि आईओसी कंटेनर इसे एक बीन की तरह सँभाले।",
    { pose: "present", ...snap("LoggingFilter.java", "java", FILTER_V0, { highlight: [0] }) });
  add("And we implement the interface Filter. Careful: choose the one from jakarta dot servlet.",
    "और हम फ़िल्टर इंटरफ़ेस इम्प्लीमेंट करते हैं। ध्यान रखिए, जकार्ता डॉट सर्वलेट वाला फ़िल्टर चुनना है।",
    { pose: "point", ...snap("LoggingFilter.java", "java", FILTER_V0, { highlight: [1] }) });
  add("A filter is not a Spring invention. It comes from Servlets, and that is why the package says jakarta dot servlet.",
    "फ़िल्टर स्प्रिंग ने नहीं बनाया है। ये सर्वलेट्स से आता है, और इसीलिए पैकेज का नाम जकार्ता डॉट सर्वलेट है।",
    { pose: "present", ...alert("warning", "Not a Spring class", "Filter lives in jakarta.servlet") });
  add("In Spring Boot 2 or 1 the import says javax. From Spring Boot 3 onward, it is always jakarta.",
    "स्प्रिंग बूट दो या एक में इम्पोर्ट जावैक्स होता था। स्प्रिंग बूट तीन से आगे, हमेशा जकार्ता मिलेगा।",
    { pose: "point", ...compare("beforeAfter", [{ title: "Spring Boot 2 and 1", points: ["import javax.servlet.Filter"] }, { title: "Spring Boot 3 and up", points: ["import jakarta.servlet.Filter"] }]) });
  add("Filter is an interface with only three methods: init, doFilter, and destroy. They are the lifecycle of a filter.",
    "फ़िल्टर एक इंटरफ़ेस है, जिसमें सिर्फ़ तीन मेथड हैं। इनिट, डू फ़िल्टर, और डिस्ट्रॉय। यही फ़िल्टर का लाइफ़साइकल है।",
    { pose: "present", ...steps(["init: filter is created", "doFilter: every request", "destroy: filter is removed"], 1) });
  add("Init runs once when the filter is created, just like the servlet lifecycle. Destroy runs when it goes away.",
    "इनिट एक बार चलता है, जब फ़िल्टर बनता है, बिल्कुल सर्वलेट के लाइफ़साइकल की तरह। और डिस्ट्रॉय तब चलता है, जब फ़िल्टर हटता है।",
    { pose: "point", ...steps(["init: filter is created", "doFilter: every request", "destroy: filter is removed"], 0) });
  add("The method we really work with is doFilter. It is called whenever a request reaches the filter.",
    "जिस मेथड पर हम असल में काम करते हैं, वो है डू फ़िल्टर। जब भी कोई रिक्वेस्ट फ़िल्टर तक आती है, यही बुलाया जाता है।",
    { pose: "present", mood: "excited", ...steps(["init: filter is created", "doFilter: every request", "destroy: filter is removed"], 1) });
  add("Init and destroy are default methods with an empty body. The only mandatory one is doFilter.",
    "इनिट और डिस्ट्रॉय खाली बॉडी वाले डिफ़ॉल्ट मेथड हैं। ज़रूरी सिर्फ़ डू फ़िल्टर है।",
    { pose: "smug" });
  add("So we implement doFilter. It takes a ServletRequest, a ServletResponse, and a FilterChain.",
    "तो हम डू फ़िल्टर इम्प्लीमेंट करते हैं। वो तीन चीज़ें लेता है, एक सर्वलेट रिक्वेस्ट, एक सर्वलेट रिस्पॉन्स, और एक फ़िल्टर चेन।",
    { pose: "point", ...snap("LoggingFilter.java", "java", FILTER_V1, { highlight: [3, 4] }) });
  add("Servlets were not built only for HTTP, so ServletRequest and ServletResponse are generic. Filters are generic too.",
    "सर्वलेट्स सिर्फ़ एचटीटीपी के लिए नहीं बने थे, इसलिए सर्वलेट रिक्वेस्ट और सर्वलेट रिस्पॉन्स जेनेरिक हैं। फ़िल्टर्स भी जेनेरिक हैं।",
    { pose: "present", ...flow(["ServletRequest", "HttpServletRequest"], 1, "extends") });
  add("For HTTP, Java gave us HttpServletRequest and HttpServletResponse. So inside a filter we cast the generic objects to the HTTP ones.",
    "एचटीटीपी के लिए जावा ने हमें एचटीटीपी सर्वलेट रिक्वेस्ट और एचटीटीपी सर्वलेट रिस्पॉन्स दिए हैं। इसलिए फ़िल्टर के अंदर हम जेनेरिक ऑब्जेक्ट्स को एचटीटीपी वाले में कास्ट करते हैं।",
    { pose: "point", ...code("Cast to HTTP", "java", ["HttpServletRequest httpRequest =", "    (HttpServletRequest) request;", "HttpServletResponse httpResponse =", "    (HttpServletResponse) response;"], { highlight: [1, 3] }) });
  add("Ninety percent of the time we handle HTTP, so this cast is routine.",
    "नब्बे प्रतिशत समय हम एचटीटीपी ही सँभालते हैं, इसलिए ये कास्ट करना आम बात है।",
    { pose: "shrug", mood: "happy" });

  // ═══════════════ 4 · The FilterChain ═══════════════
  chapter("4 · The FilterChain", "server");
  add("Now, the FilterChain. Can we have only one filter between the client and the DispatcherServlet? No. We can have a whole chain.",
    "अब बात फ़िल्टर चेन की। क्या क्लाइंट और डिस्पैचर सर्वलेट के बीच सिर्फ़ एक ही फ़िल्टर हो सकता है? नहीं। हम फ़िल्टर्स की पूरी चेन बना सकते हैं।",
    { pose: "present", ...flow(CHAIN3, 0, "request") });
  add("The request goes from the client to Filter 1, then Filter 2, then Filter 3, and finally the DispatcherServlet.",
    "रिक्वेस्ट क्लाइंट से फ़िल्टर एक में जाती है, फिर फ़िल्टर दो, फिर फ़िल्टर तीन, और आख़िर में डिस्पैचर सर्वलेट में।",
    { pose: "point", ...flow(CHAIN3, 4, "request") });
  add("When the response comes back, it follows the same format in reverse: Filter 3, Filter 2, Filter 1, and the client.",
    "जब रिस्पॉन्स वापस आता है, तो वो उसी रास्ते से उल्टा चलता है। फ़िल्टर तीन, फ़िल्टर दो, फ़िल्टर एक, और फिर क्लाइंट।",
    { pose: "present", ...flow(BACK, 0, "response") });
  add("The job of the FilterChain is to tell the next filter: I have done my work, now it is your turn.",
    "फ़िल्टर चेन का काम है अगले फ़िल्टर को बताना, कि मैंने अपना काम कर लिया, अब तुम्हारी बारी है।",
    { pose: "point", mood: "excited" });
  add("We do that with one call: chain dot doFilter, passing the request and the response.",
    "हम ये एक कॉल से करते हैं। चेन डॉट डू फ़िल्टर, जिसमें रिक्वेस्ट और रिस्पॉन्स पास करते हैं।",
    { pose: "present", ...code("Pass it on", "java", ["chain.doFilter(request, response);"], { highlight: [0] }) });
  add("This call means: run the doFilter of whichever filter comes next in the chain.",
    "इस कॉल का मतलब है, चेन में जो भी फ़िल्टर अगला है, उसका डू फ़िल्टर चला दो।",
    { pose: "point" });
  add("If there is no next filter, the chain itself calls the DispatcherServlet. We do not have to handle that.",
    "अगर अगला कोई फ़िल्टर नहीं है, तो चेन ख़ुद डिस्पैचर सर्वलेट को बुला लेती है। ये हमें सँभालना नहीं पड़ता।",
    { pose: "present", ...flow(CHAIN3, 3, "chain.doFilter") });
  add("FilterChain is an interface too. Its implementation checks: is there a next filter? If yes, call it. If not, call the servlet.",
    "फ़िल्टर चेन भी एक इंटरफ़ेस है। उसका इम्प्लीमेंटेशन देखता है, कि अगला फ़िल्टर है क्या? अगर है, तो उसे बुलाओ। नहीं है, तो सर्वलेट को।",
    { pose: "point" });
  add("Remember this: if a filter never calls chain dot doFilter, the request stops right there.",
    "ये याद रखिए। अगर कोई फ़िल्टर चेन डॉट डू फ़िल्टर कभी बुलाता ही नहीं, तो रिक्वेस्ट वहीं रुक जाती है।",
    { pose: "point", mood: "worried", ...alert("warning", "No chain.doFilter call", "The request never goes any further") });
  add("Let us write the first version. Print Request entered in LoggingFilter, call the chain, then print Exiting.",
    "पहला वर्ज़न लिखते हैं। रिक्वेस्ट एंटर्ड इन लॉगिंग फ़िल्टर प्रिंट करो, चेन बुलाओ, और फिर एग्ज़िटिंग प्रिंट करो।",
    { pose: "present", ...snap("LoggingFilter.java", "java", FILTER_V2, { highlight: [3, 4, 5] }) });
  add("The code after the chain call runs when the response comes back. It works like recursion: execution resumes where it left off.",
    "चेन कॉल के बाद वाला कोड तब चलता है, जब रिस्पॉन्स वापस आता है। ये रिकर्शन जैसा है। एक्ज़ीक्यूशन वहीं से आगे बढ़ता है जहाँ से छोड़ा था।",
    { pose: "point", ...snap("LoggingFilter.java", "java", FILTER_V2, { highlight: [6, 7] }) });
  add("The request goes client, filter, servlet, controller, service. Then it travels back up the same way, to the filter again.",
    "रिक्वेस्ट क्लाइंट से फ़िल्टर, सर्वलेट, कंट्रोलर, सर्विस तक जाती है। फिर उसी रास्ते से वापस, और एक बार फिर फ़िल्टर तक आती है।",
    { pose: "present", ...flow(["Client", "Filter", "DispatcherServlet", "Controller", "Service"], 4, "request") });
  add("We run it, and hit the API. The console shows: entered, then Student Created from the service, then exiting.",
    "ऐप चलाकर एपीआई हिट करते हैं। कंसोल में पहले एंटर्ड आता है, फिर सर्विस का स्टूडेंट क्रिएटेड, और फिर एग्ज़िटिंग।",
    { pose: "smug", mood: "happy", ...term(["Request entered in LoggingFilter", "Student Created", "Exiting in LoggingFilter"], "Console") });
  add("So our filter logic works correctly. But this was a very basic example. Let us make it more real.",
    "तो हमारा फ़िल्टर सही चल रहा है। लेकिन ये बहुत बेसिक उदाहरण था। अब इसे थोड़ा असली बनाते हैं।",
    { pose: "present", mood: "excited" });
};
