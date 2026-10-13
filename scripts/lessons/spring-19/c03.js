// Chapter 5: a real LoggingFilter - request body, method and URI, request ID, response time, try/finally.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, alert, compare, browser, table, snap } = L;

const DTO = [
  "public class Student {",
  "  private Long id;",
  "  private String name;",
  "  private String email;",
  "  // getters and setters",
  "}",
];
const CTRL_BODY = [
  "@PostMapping",
  "public ResponseEntity<String> createStudent(",
  "    @RequestBody Student student) {",
  "  studentService.createStudent(student);",
  "  return ResponseEntity.ok(\"Done\");",
  "}",
];
const V_CAST = [
  "public void doFilter(ServletRequest request,",
  "    ServletResponse response, FilterChain chain)",
  "    throws IOException, ServletException {",
  "  HttpServletRequest httpRequest =",
  "      (HttpServletRequest) request;",
  "  HttpServletResponse httpResponse =",
  "      (HttpServletResponse) response;",
  "",
  "  chain.doFilter(request, response);",
  "}",
];
const V_INCOMING = [
  "  HttpServletRequest httpRequest =",
  "      (HttpServletRequest) request;",
  "  HttpServletResponse httpResponse =",
  "      (HttpServletResponse) response;",
  "",
  "  System.out.println(\"Incoming request: \"",
  "      + httpRequest.getMethod() + \" \"",
  "      + httpRequest.getRequestURI());",
  "",
  "  chain.doFilter(request, response);",
];
const V_STATUS = [
  "  System.out.println(\"Incoming request: \"",
  "      + httpRequest.getMethod() + \" \"",
  "      + httpRequest.getRequestURI());",
  "",
  "  chain.doFilter(request, response);",
  "",
  "  System.out.println(\"Response status: \"",
  "      + httpResponse.getStatus());",
];
const V_ID = [
  "  String requestId =",
  "      UUID.randomUUID().toString();",
  "  httpResponse.setHeader(",
  "      \"X-Request-Id\", requestId);",
  "",
  "  chain.doFilter(request, response);",
  "",
  "  System.out.println(\"Response status: \"",
  "      + httpResponse.getStatus());",
];
const V_TIME = [
  "  long start = System.currentTimeMillis();",
  "  httpResponse.setHeader(",
  "      \"X-Request-Id\", requestId);",
  "",
  "  chain.doFilter(request, response);",
  "",
  "  long duration =",
  "      System.currentTimeMillis() - start;",
  "  System.out.println(\"API response time: \"",
  "      + duration + \" ms\");",
];
const V_FINALLY = [
  "  long start = System.currentTimeMillis();",
  "  try {",
  "    chain.doFilter(request, response);",
  "  } finally {",
  "    long duration =",
  "        System.currentTimeMillis() - start;",
  "    System.out.println(\"Status: \"",
  "        + httpResponse.getStatus());",
  "    System.out.println(\"API response time: \"",
  "        + duration + \" ms\");",
  "  }",
];

module.exports = () => {
  chapter("5 · A real LoggingFilter", "stage");
  add("Let us make it better. Now the user sends a body: an id, a name, and an email.",
    "अब इसे बेहतर बनाते हैं। अब यूज़र एक बॉडी भेजता है। एक आईडी, एक नेम, और एक ईमेल।",
    { pose: "present", ...browser("POST localhost:8080/api/students", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"email\": \"ad@gmail.com\"", "}"]) });
  add("We create a simple Student class in a dto package: id, name, email, with getters and setters. Spring does not manage it.",
    "डीटीओ पैकेज में एक सिंपल स्टूडेंट क्लास बनाते हैं, आईडी, नेम, ईमेल, गेटर्स और सेटर्स के साथ। इसे स्प्रिंग नहीं सँभालता।",
    { pose: "point", ...snap("Student.java", "java", DTO, { highlight: [1, 2, 3] }) });
  add("The controller takes it with @RequestBody, and the service prints the name and the email.",
    "कंट्रोलर इसे रिक्वेस्ट बॉडी से लेता है, और सर्विस नेम और ईमेल प्रिंट करती है।",
    { pose: "present", ...snap("StudentController.java", "java", CTRL_BODY, { highlight: [2, 3] }) });
  add("Now back to the real work: logging a request in the filter. We start by casting to the HTTP request and response.",
    "अब असली काम पर लौटते हैं, फ़िल्टर में रिक्वेस्ट को लॉग करना। शुरुआत एचटीटीपी रिक्वेस्ट और रिस्पॉन्स में कास्ट करके करते हैं।",
    { pose: "point", ...snap("LoggingFilter.java", "java", V_CAST, { highlight: [3, 4, 5, 6] }) });
  add("Then we print the incoming request: which method it is, and the request URI, which is the endpoint that was called.",
    "फिर आने वाली रिक्वेस्ट प्रिंट करते हैं। कौन सा मेथड है, और रिक्वेस्ट यूआरआई क्या है, यानी कौन सा एंडपॉइंट बुलाया गया।",
    { pose: "present", ...snap("LoggingFilter.java", "java", V_INCOMING, { highlight: [5, 6, 7] }) });
  add("In a real app we would write this to a log file with a logging library. For now, the console is enough.",
    "असली ऐप में हम इसे लॉगिंग लाइब्रेरी से फ़ाइल में लिखते। अभी के लिए कंसोल काफ़ी है।",
    { pose: "shrug" });
  add("After the chain call, when the work is done, we log the response status with httpResponse dot getStatus.",
    "चेन कॉल के बाद, जब सारा काम हो चुका है, हम एचटीटीपी रिस्पॉन्स डॉट गेट स्टेटस से रिस्पॉन्स स्टेटस लॉग करते हैं।",
    { pose: "point", ...snap("LoggingFilter.java", "java", V_STATUS, { highlight: [6, 7] }) });
  add("We run it. First the incoming POST request, then the service prints Student Created with the name and email, and finally status 200.",
    "ऐप चलाते हैं। पहले आने वाली पोस्ट रिक्वेस्ट, फिर सर्विस का स्टूडेंट क्रिएटेड नेम और ईमेल के साथ, और आख़िर में स्टेटस दो सौ।",
    { pose: "smug", mood: "happy", ...term(["Incoming request: POST /api/students", "Student Created Aditya ad@gmail.com", "Response status: 200"], "Console") });
  add("A great use case for a filter: every call is logged in one single place.",
    "फ़िल्टर का एक शानदार इस्तेमाल। हर कॉल एक ही जगह पर लॉग हो जाती है।",
    { pose: "present", mood: "excited" });

  add("Next, the request ID. For every request we generate a new UUID, and send the same ID back to the user.",
    "अब रिक्वेस्ट आईडी। हर रिक्वेस्ट के लिए हम एक नई यूयूआईडी बनाते हैं, और वही आईडी यूज़र को वापस भेजते हैं।",
    { pose: "point", ...snap("LoggingFilter.java", "java", V_ID, { highlight: [0, 1] }) });
  add("The ID is unique for this one API call. Send it again, and a different ID is generated.",
    "ये आईडी इस एक एपीआई कॉल के लिए यूनिक है। दोबारा भेजेंगे, तो दूसरी आईडी बनेगी।",
    { pose: "present" });
  add("We put it in a response header with setHeader, named X-Request-Id.",
    "हम इसे रिस्पॉन्स हेडर में रखते हैं, सेट हेडर से, एक्स रिक्वेस्ट आईडी नाम से।",
    { pose: "point", ...snap("LoggingFilter.java", "java", V_ID, { highlight: [2, 3] }) });
  add("Tomorrow, if the client needs logs, they send us this ID, and we find every log line of that request.",
    "कल अगर क्लाइंट को लॉग चाहिए, तो वो हमें ये आईडी भेजेगा, और हम उस रिक्वेस्ट की सारी लॉग लाइनें निकाल लेंगे।",
    { pose: "present", ...flow(["Client", "Request ID", "Log file"], 2, "find logs") });
  add("Why do we set the header before calling the chain? We could do it after, but there is a problem.",
    "हमने हेडर चेन बुलाने से पहले क्यों सेट किया? हम इसे बाद में भी कर सकते थे, लेकिन उसमें एक दिक्कत है।",
    { pose: "think", props: [{ type: "question" }] });
  add("When the response comes back to the filter, it is already committed. Committed means read-only. You cannot add anything.",
    "जब रिस्पॉन्स वापस फ़िल्टर तक आता है, तब वो पहले ही कमिट हो चुका होता है। कमिट का मतलब है रीड ओनली। आप उसमें कुछ जोड़ नहीं सकते।",
    { pose: "point", mood: "worried", ...alert("warning", "Response is committed", "Headers can no longer be added after the chain") });
  add("So the standard practice is to add it before the chain call, while we still hold the response object.",
    "इसलिए आम तरीका यही है कि इसे चेन कॉल से पहले जोड़ दें, जब रिस्पॉन्स ऑब्जेक्ट हमारे हाथ में है।",
    { pose: "present", mood: "smug" });
  add("In Postman, the response headers now carry x-request-id. Every send gives a new one.",
    "पोस्टमैन में अब रिस्पॉन्स हेडर्स में एक्स रिक्वेस्ट आईडी आ रही है। हर बार भेजने पर नई आईडी मिलती है।",
    { pose: "smug", ...browser("Response headers", "json", ["x-request-id: 3f9a1c2e-7b4d-4e0a-9c11", "x-request-id: a82d51f0-1c6e-4b7f-8e23", "x-request-id: 5e07c9b4-9a3d-42f1-b6a8"], "Every call is different") });

  add("One last thing: the total time of the request. As soon as the filter is called, we take the current time with System dot currentTimeMillis.",
    "आख़िरी चीज़, रिक्वेस्ट का पूरा समय। जैसे ही फ़िल्टर बुलाया जाता है, हम सिस्टम डॉट करंट टाइम मिलिस से अभी का समय ले लेते हैं।",
    { pose: "point", ...snap("LoggingFilter.java", "java", V_TIME, { highlight: [0] }) });
  add("After the chain returns, we subtract the start time from the current time. That is the duration of the whole request.",
    "चेन के लौटने के बाद, हम अभी के समय में से शुरू का समय घटा देते हैं। यही पूरी रिक्वेस्ट का समय है।",
    { pose: "present", ...snap("LoggingFilter.java", "java", V_TIME, { highlight: [6, 7] }) });
  add("That includes the servlet, the controller, the service, and the database. So it is a good indicator of the API response time.",
    "इसमें सर्वलेट, कंट्रोलर, सर्विस और डेटाबेस, सब शामिल है। इसलिए ये एपीआई के रिस्पॉन्स टाइम का अच्छा पैमाना है।",
    { pose: "point", ...flow(["Filter", "Servlet", "Controller", "Service", "Database"], 4, "timed") });
  add("Our app is very fast, with no database. We see about forty three milliseconds.",
    "हमारा ऐप बहुत तेज़ है, क्योंकि डेटाबेस नहीं है। हमें लगभग तैंतालीस मिलीसेकंड दिखते हैं।",
    { pose: "smug", ...term(["Response status: 200", "API response time: 43 ms"], "Console") });
  add("To imitate a slow database call, we add Thread dot sleep for two thousand milliseconds in the service.",
    "धीमी डेटाबेस कॉल की नक़ल करने के लिए, हम सर्विस में दो हज़ार मिलीसेकंड का थ्रेड स्लीप डाल देते हैं।",
    { pose: "point", ...code("StudentService.java", "java", ["public void createStudent(Student s) {", "  try {", "    Thread.sleep(2000);", "  } catch (Exception e) { }", "  System.out.println(\"Student Created\");", "}"], { highlight: [2] }) });
  add("Now the response time is about two and a half seconds. All of that, measured by our one filter.",
    "अब रिस्पॉन्स टाइम लगभग ढाई सेकंड है। और ये सब हमारे एक ही फ़िल्टर ने नाप लिया।",
    { pose: "present", mood: "excited", ...term(["Response status: 200", "API response time: 2550 ms"], "Console") });
  add("A good practice we were missing: do not call chain dot doFilter bare. Put it inside a try block, and the logging in finally.",
    "एक अच्छी आदत जो हमसे अब तक छूट रही थी। चेन डॉट डू फ़िल्टर को सीधे मत बुलाइए। उसे ट्राई ब्लॉक में रखिए, और लॉगिंग फ़ाइनली में।",
    { pose: "point", ...snap("LoggingFilter.java", "java", V_FINALLY, { highlight: [1, 2, 3] }) });
  add("Why? If any layer throws an exception, the code after the chain would never run, and we would lose our log.",
    "क्यों? अगर किसी भी लेयर में एक्सेप्शन आ गया, तो चेन के बाद वाला कोड कभी चलेगा ही नहीं, और हमारा लॉग खो जाएगा।",
    { pose: "think", mood: "worried" });
  add("Finally always runs, whether an exception happened or not. So that is the right place for the response status and the duration.",
    "फ़ाइनली हमेशा चलता है, चाहे एक्सेप्शन आए या न आए। इसलिए रिस्पॉन्स स्टेटस और ड्यूरेशन के लिए यही सही जगह है।",
    { pose: "present", ...snap("LoggingFilter.java", "java", V_FINALLY, { highlight: [3, 4, 5, 6, 7, 8, 9] }) });
  ask("Where should the status log go so it runs even if an exception is thrown?",
    ["Before chain.doFilter", "In a finally block after it", "Inside the controller", "In the init method"], 1,
    "A finally block always runs. Code placed right after the chain call is skipped when an exception passes through.",
    { q: "रिस्पॉन्स स्टेटस का लॉग कहाँ होना चाहिए, ताकि कंट्रोलर में एक्सेप्शन आने पर भी वो चले? ए, चेन डू फ़िल्टर से पहले। बी, उसके बाद फ़ाइनली ब्लॉक में। सी, कंट्रोलर के अंदर। या डी, इनिट मेथड में।",
      a: "फ़ाइनली ब्लॉक हमेशा चलता है। चेन कॉल के ठीक बाद रखा हुआ कोड, एक्सेप्शन आने पर छूट जाता है।" });
};
