// Chapters 1-2: the problem before the controller, and what a filter is.
// Captions are English; the second string of every add() is the Hindi narration (Devanagari only).
const L = require("./lib");
const { add, ask, chapter, flow, steps, alert, compare, browser, scene } = L;

const LAYERS = ["Client", "Controller", "Service", "Repository"];
const FULL = ["Client", "DispatcherServlet", "Controller", "Service", "Repository"];
const TASKS = ["Log the request", "Authenticate the user", "Create a request ID"];
const SOLID = ["Single Responsibility", "Open / Closed", "Liskov Substitution", "Interface Segregation", "Dependency Inversion"];
const WITH_FILTER = ["Client", "Filter", "DispatcherServlet", "Controller", "Service + Repo"];

module.exports = () => {
  // ═══════════════ 1 · The problem before the controller ═══════════════
  chapter("1 · The problem before the controller", "stage");
  add("Welcome back, Coder Army. Today we study filters, a very important topic in Spring Boot.",
    "वापस स्वागत है, कोडर आर्मी। आज हम पढ़ेंगे फ़िल्टर्स, जो स्प्रिंग बूट का एक बहुत ही ज़रूरी टॉपिक है।", { pose: "present", mood: "excited" });
  add("Almost every real application uses filters. Interceptors are used a lot too, and they come in the next video.",
    "असली एप्लीकेशन में फ़िल्टर्स लगभग हर जगह इस्तेमाल होते हैं। इंटरसेप्टर्स भी बहुत इस्तेमाल होते हैं, और वो हम अगले वीडियो में देखेंगे।", { pose: "point" });
  add("So let us understand this topic properly. It is simple, and it is a lot of fun.",
    "तो चलिए, इस टॉपिक को अच्छी तरह समझते हैं। ये बहुत आसान है, और बहुत मज़ेदार भी।", { pose: "present", mood: "happy" });
  add("We already know the layers. A request goes from the client to the controller, then the service, then the repository.",
    "लेयर्स हम पहले से जानते हैं। रिक्वेस्ट क्लाइंट से कंट्रोलर तक जाती है, फिर सर्विस, और फिर रिपॉज़िटरी तक।", { pose: "point", ...flow(LAYERS, 3, "request") });
  add("And the response comes back the same way: repository, service, controller, client.",
    "और रिस्पॉन्स उसी रास्ते से वापस आता है। रिपॉज़िटरी से सर्विस, सर्विस से कंट्रोलर, और कंट्रोलर से क्लाइंट।", { pose: "present", ...flow(LAYERS, 0, "response") });
  add("Before the controller there is also the DispatcherServlet. It decides which controller handles which request.",
    "कंट्रोलर से पहले डिस्पैचर सर्वलेट भी होता है। वही तय करता है कि कौन सी रिक्वेस्ट किस कंट्रोलर को जाएगी।", { pose: "point", ...flow(FULL, 1, "request") });
  add("That is the whole architecture we know so far. Now let us look at a problem.",
    "अब तक का पूरा आर्किटेक्चर यही है। अब एक प्रॉब्लम देखते हैं।", { pose: "think" });
  add("A GET request arrives at slash api slash students, on localhost, port eight zero eight zero.",
    "मान लीजिए स्टूडेंट्स के लिए एक गेट रिक्वेस्ट आती है, लोकलहोस्ट के आठ हज़ार अस्सी पोर्ट पर।", { pose: "present", ...browser("GET localhost:8080/api/students", "json", ["Host: localhost:8080", "Accept: application/json"]) });
  add("Before we entertain it, we are asked to do a few things first.",
    "और आपसे कहा जाता है, कि रिक्वेस्ट को हाथ लगाने से पहले कुछ काम करने हैं।", { pose: "point", ...steps(TASKS, 0) });
  add("First, log the request. Print it on the screen, or write it to a file.",
    "पहला काम, रिक्वेस्ट को लॉग करना। उसे स्क्रीन पर प्रिंट करना है, या फ़ाइल में लिखना है।", { pose: "present", ...steps(TASKS, 0) });
  add("Second, authenticate the user. Someone who has not signed in must not be able to hit this API. Maybe they need a token.",
    "दूसरा काम, यूज़र को ऑथेंटिकेट करना। जो यूज़र साइन इन नहीं है, वो इस एपीआई को हिट न कर पाए। हो सकता है उसके पास कोई टोकन होना चाहिए।", { pose: "point", ...steps(TASKS, 1) });
  add("Third, create a request ID, a unique number. The first request gets 1001, the next one gets 1002.",
    "तीसरा काम, रिक्वेस्ट आईडी बनाना, यानी एक यूनिक नंबर। पहली रिक्वेस्ट को एक हज़ार एक मिलेगा, अगली को एक हज़ार दो।", { pose: "present", ...steps(TASKS, 2) });
  add("None of this is business logic. These tasks must happen even before the business logic.",
    "इनमें से कोई भी काम बिज़नेस लॉजिक नहीं है। ये सब बिज़नेस लॉजिक से भी पहले होना चाहिए।", { pose: "shrug" });
  add("And after the response is built, there is more work: add the request ID to the response, or some extra headers.",
    "और जब रिस्पॉन्स बन जाता है, तब भी काम बचा है। रिस्पॉन्स में रिक्वेस्ट आईडी जोड़नी है, या कुछ एक्स्ट्रा हेडर्स लगाने हैं।",
    { pose: "point", ...steps(["Before: log, authenticate, request ID", "In the middle: our business logic", "After: add request ID to response"], 2) });
  add("So where should all this work live? Thinking from first principles, the controller comes to mind.",
    "तो ये सारा काम कहाँ होना चाहिए? सबसे पहले हमारे दिमाग में कंट्रोलर आता है।", { pose: "think", props: [{ type: "question" }] });
  add("In the controller we can log, authenticate, and make the request ID. Then call the service for the business logic.",
    "कंट्रोलर में हम लॉग कर सकते हैं, ऑथेंटिकेट कर सकते हैं, रिक्वेस्ट आईडी बना सकते हैं, और उसके बाद सर्विस को बुला सकते हैं।", { pose: "present", ...flow(["Client", "Controller + log, auth", "Service", "Repository"], 1, "request") });
  add("But imagine fifty APIs, or many more. Will we go into every controller and repeat the same work?",
    "लेकिन सोचिए, हमारे पास पचास एपीआई हैं, या उससे भी ज़्यादा। क्या हम हर कंट्रोलर में जाकर यही काम बार बार लिखेंगे?", { pose: "shrug", mood: "worried", ...alert("warning", "50 controllers, same code", "The same logging and auth, copied everywhere") });
  add("We could put it in one separate class, and let every controller call it.",
    "हम एक अलग क्लास बना सकते हैं, और हर कंट्रोलर से उसे बुला सकते हैं।", { pose: "point" });
  add("But then every controller needs an object of that class. The controller is still tightly coupled to infrastructure code.",
    "लेकिन फिर हर कंट्रोलर को उस क्लास का ऑब्जेक्ट बनाना पड़ेगा। कंट्रोलर फिर भी इंफ्रास्ट्रक्चर के कोड से कसकर जुड़ा रहेगा।", { pose: "present", mood: "worried" });
  add("Logging, authentication, a request ID: this is infrastructure and security logic. It is not the controller's job.",
    "लॉगिंग, ऑथेंटिकेशन, रिक्वेस्ट आईडी, ये सब इंफ्रास्ट्रक्चर और सिक्योरिटी का काम है। ये कंट्रोलर का काम नहीं है।", { pose: "point", mood: "angry" });
  add("Remember the Single Responsibility Principle, the first of SOLID: a class should have only one responsibility.",
    "सिंगल रिस्पॉन्सिबिलिटी प्रिंसिपल याद है ना? सॉलिड का पहला नियम, कि एक क्लास की सिर्फ़ एक ज़िम्मेदारी होनी चाहिए।", { pose: "present", ...steps(SOLID, 0) });
  add("The controller's job is only to receive the API request and pass it to the service. No business logic, no infra logic.",
    "कंट्रोलर का काम बस इतना है, कि एपीआई रिक्वेस्ट ले और सर्विस लेयर को दे दे। न बिज़नेस लॉजिक, न इंफ्रा लॉजिक।", { pose: "point" });
  add("We already moved validation to exception handling, and business logic to the service layer.",
    "वैलिडेशन के लिए हमने एक्सेप्शन हैंडलिंग इस्तेमाल की थी, और बिज़नेस लॉजिक के लिए सर्विस लेयर।", { pose: "smug", mood: "happy" });
  add("For this extra work on requests and responses, we use a very interesting concept called a filter.",
    "और रिक्वेस्ट और रिस्पॉन्स पर इस एक्स्ट्रा काम के लिए, हम एक बहुत मज़ेदार कॉन्सेप्ट इस्तेमाल करेंगे, जिसका नाम है फ़िल्टर।", { pose: "present", mood: "excited", props: [{ type: "bulb" }] });

  // ═══════════════ 2 · What is a filter? ═══════════════
  chapter("2 · What is a filter?", "server");
  add("Where does a filter fit? Right before the DispatcherServlet.",
    "फ़िल्टर कहाँ लगता है? डिस्पैचर सर्वलेट से बिल्कुल पहले।", { pose: "point", ...flow(WITH_FILTER, 1, "request") });
  add("Any request from the client hits the filter first. The filter does its work, and only then the request goes to the DispatcherServlet.",
    "क्लाइंट की हर रिक्वेस्ट सबसे पहले फ़िल्टर से टकराती है। फ़िल्टर अपना काम करता है, और उसके बाद ही रिक्वेस्ट डिस्पैचर सर्वलेट के पास जाती है।", { pose: "present", ...flow(WITH_FILTER, 2, "request") });
  add("Then the usual path follows: controller, service, repository, and back up again.",
    "उसके बाद वही रास्ता चलता है, कंट्रोलर, सर्विस, रिपॉज़िटरी, और फिर वापस ऊपर।", { pose: "point", ...flow(WITH_FILTER, 4, "request") });
  add("On the way back, the response passes the DispatcherServlet, then the filter once more, and only then reaches the client.",
    "वापसी में रिस्पॉन्स डिस्पैचर सर्वलेट से निकलकर एक बार फिर फ़िल्टर से गुज़रता है, और तभी क्लाइंट तक पहुँचता है।", { pose: "present", ...flow(WITH_FILTER, 1, "response") });
  add("So the filter works on the request on the way in, and on the response on the way out.",
    "यानी फ़िल्टर आते हुए रिक्वेस्ट पर काम करता है, और जाते हुए रिस्पॉन्स पर।", { pose: "smug", ...steps(["Request in: filter work", "Controller, service, repository", "Response out: filter work"], 0) });
  add("Nothing else changes. We just add one new layer, and it filters incoming requests and outgoing responses.",
    "बाकी कुछ नहीं बदलता। हम बस एक नई लेयर जोड़ रहे हैं, जो आने वाली रिक्वेस्ट और जाने वाले रिस्पॉन्स को फ़िल्टर करती है।", { pose: "present", mood: "happy" });
  add("Remember what the DispatcherServlet does: it builds the HttpServletRequest and HttpServletResponse objects.",
    "याद रखिए डिस्पैचर सर्वलेट क्या करता है। वो एचटीटीपी सर्वलेट रिक्वेस्ट और एचटीटीपी सर्वलेट रिस्पॉन्स ऑब्जेक्ट्स बनाता है।", { pose: "think" });
  add("It also maps the JSON body to a Java object with Jackson, and reads the method, the endpoint, the headers and the parameters.",
    "वो जैक्सन से जेसन बॉडी को जावा ऑब्जेक्ट में बदलता है, और मेथड, एंडपॉइंट, हेडर्स और पैरामीटर्स को भी समझता है।", { pose: "present" });
  add("The filter runs before all of that. So the request it sees is a raw request.",
    "फ़िल्टर इन सबसे भी पहले चलता है। इसलिए उसे जो रिक्वेस्ट मिलती है, वो बिल्कुल कच्ची होती है।", { pose: "point", ...steps(["Filter sees a raw request", "DispatcherServlet builds the objects", "HandlerMapping picks a controller"], 0) });
  add("The DispatcherServlet has not even decided which controller will be called. The filter has no clue about it.",
    "डिस्पैचर सर्वलेट ने अभी तय भी नहीं किया है कि कौन सा कंट्रोलर चलेगा। फ़िल्टर को इसका बिल्कुल अंदाज़ा नहीं होता।", { pose: "shrug" });
  add("Interceptors sit after the DispatcherServlet but before the controller, so they know which controller is called.",
    "इंटरसेप्टर्स डिस्पैचर सर्वलेट के बाद, पर कंट्रोलर से पहले होते हैं। इसलिए उन्हें पता होता है कि कौन सा कंट्रोलर बुलाया जाएगा।", { pose: "point",
      ...compare("versus", [{ title: "Filter", points: ["Before DispatcherServlet", "Comes from Servlets", "Does not know the controller"] }, { title: "Interceptor", points: ["After DispatcherServlet", "Comes from Spring", "Knows the controller"] }]) });
  add("So in a filter we do general tasks that are common for every controller. Let us see what they are.",
    "इसलिए फ़िल्टर में हम ऐसे आम काम करते हैं, जो हर कंट्रोलर के लिए एक जैसे हों। चलिए देखते हैं, वो क्या हैं।", { pose: "present" });
  add("First, logging: the URL, the method, or even the body, written to a file. But never log sensitive data like card details.",
    "पहला, लॉगिंग। यूआरएल, मेथड, या पूरी बॉडी भी फ़ाइल में लिख सकते हैं। पर कार्ड डिटेल्स जैसा संवेदनशील डेटा कभी लॉग मत करिए।", { pose: "point", ...steps(["Logging", "Authentication", "Headers and encoding", "Timing"], 0) });
  add("Second, authentication and security checks. If there is no token in the headers, the user is not authenticated.",
    "दूसरा, ऑथेंटिकेशन और सिक्योरिटी चेक। अगर हेडर्स में टोकन नहीं है, तो मान लीजिए यूज़र ऑथेंटिकेटेड नहीं है।", { pose: "present", ...steps(["Logging", "Authentication", "Headers and encoding", "Timing"], 1) });
  add("And a filter can stop a request from going any further, and send the answer straight back to the client.",
    "और फ़िल्टर रिक्वेस्ट को आगे जाने से रोक भी सकता है, और जवाब सीधा क्लाइंट को वापस भेज सकता है।", { pose: "point", mood: "excited", ...alert("error", "401 Unauthorized", "Stopped in the filter, the controller never ran") });
  add("Third, changing the response: always attach a request ID header, so the user can quote it later if they need logs.",
    "तीसरा, रिस्पॉन्स में बदलाव। हमेशा एक रिक्वेस्ट आईडी हेडर जोड़ दीजिए, ताकि यूज़र को बाद में लॉग चाहिए हों, तो वो ये आईडी बता सके।", { pose: "present", ...steps(["Logging", "Authentication", "Headers and encoding", "Timing"], 2) });
  add("A third party integration does exactly this: they give you a request ID, and you pull the logs for it.",
    "थर्ड पार्टी इंटीग्रेशन में ऐसा ही होता है। वो आपको रिक्वेस्ट आईडी देते हैं, और आप उसी से उनके लॉग निकाल लेते हैं।", { pose: "point" });
  add("Changing the incoming request itself is not advised. For data changes use DTOs. Altering the original request in a filter is usually wrong.",
    "आने वाली रिक्वेस्ट को ही बदलना सही नहीं माना जाता। डेटा बदलना हो, तो डीटीओ इस्तेमाल करिए। फ़िल्टर में ओरिजिनल रिक्वेस्ट का ढाँचा बदलना आम तौर पर गलत है।", { pose: "shrug", mood: "worried" });
  add("You can also set the character encoding here, for example always UTF-8.",
    "आप यहाँ कैरेक्टर एन्कोडिंग भी सेट कर सकते हैं, जैसे हमेशा यूटीएफ आठ।", { pose: "present" });
  add("A filter can read headers, cookies and authentication info. It can block a request, or let it continue.",
    "फ़िल्टर हेडर्स, कुकीज़ और ऑथेंटिकेशन की जानकारी पढ़ सकता है। वो रिक्वेस्ट को रोक सकता है, या आगे जाने दे सकता है।", { pose: "point" });
  add("It can also measure the total time: from entering the filter to coming back. This is the turnaround time.",
    "वो पूरा समय भी नाप सकता है। फ़िल्टर में घुसने से लेकर वापस आने तक, जिसे टर्नअराउंड टाइम भी कहते हैं।", { pose: "present", ...steps(["Logging", "Authentication", "Headers and encoding", "Timing"], 3) });
  add("And since the filter sits first, it even sees requests that never reach a controller: a logo image, the error endpoint, the favicon.",
    "और क्योंकि फ़िल्टर सबसे पहले बैठा है, वो उन रिक्वेस्ट्स को भी देखता है जो कंट्रोलर तक कभी पहुँचती ही नहीं। जैसे लोगो इमेज, एरर एंडपॉइंट, और फ़ैविकॉन।", { pose: "point",
      ...browser("localhost:8080/static/logo.png", "page", ["Static file", "No controller involved", "Filter still sees it"], "Static resource") });
  ask("Which of these is a good job for a filter?",
    ["Saving a student in the database", "Checking the auth token of every request", "Choosing which controller runs", "Building the JSON body of a response"], 1,
    "A token check is common to every request, and a filter sees the request before any controller. Saving is service work, and choosing the controller is the DispatcherServlet's job.",
    { q: "इनमें से कौन सा काम फ़िल्टर के लिए सही है? ए, डेटाबेस में स्टूडेंट सेव करना। बी, हर रिक्वेस्ट का ऑथ टोकन जाँचना। सी, कौन सा कंट्रोलर चलेगा ये चुनना। या डी, रिस्पॉन्स की जेसन बॉडी बनाना।",
      a: "टोकन की जाँच हर रिक्वेस्ट के लिए एक जैसी है, और फ़िल्टर रिक्वेस्ट को किसी भी कंट्रोलर से पहले देखता है। सेव करना सर्विस का काम है, और कंट्रोलर चुनना डिस्पैचर सर्वलेट का।" });
};
