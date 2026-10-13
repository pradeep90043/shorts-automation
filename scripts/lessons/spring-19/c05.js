// Chapters 7-8: chaining two filters with @Order, one responsibility per filter, and the recap.
const L = require("./lib");
const { add, ask, chapter, code, flow, steps, alert, compare, table, snap } = L;

const AUTH_ORDER = ["@Component", "@Order(1)", "public class AuthenticationFilter", "    implements Filter {"];
const LOG_ORDER = ["@Component", "@Order(2)", "public class LoggingFilter", "    implements Filter {"];
const TWO = ["Client", "AuthenticationFilter", "LoggingFilter", "DispatcherServlet", "Controller"];

module.exports = () => {
  chapter("7 · Chaining filters with @Order", "cloud");
  add("Now let us combine both filters, instead of switching one off and the other on.",
    "अब दोनों फ़िल्टर्स को साथ में जोड़ते हैं, बजाय इसके कि एक बंद करें और दूसरा चालू।",
    { pose: "present", mood: "excited" });
  add("We want authentication first, obviously. If the token and the API key are correct, it calls the next filter, which is logging.",
    "हमें ऑथेंटिकेशन पहले चाहिए, ये तो साफ़ है। अगर टोकन और एपीआई की सही हैं, तो वो अगला फ़िल्टर बुलाता है, यानी लॉगिंग।",
    { pose: "point", ...flow(TWO, 1, "request") });
  add("Logging sets the request ID, calls the chain, and only then does the DispatcherServlet run.",
    "लॉगिंग रिक्वेस्ट आईडी सेट करता है, चेन बुलाता है, और उसके बाद ही डिस्पैचर सर्वलेट चलता है।",
    { pose: "present", ...flow(TWO, 3, "request") });
  add("How do we set this order? With the @Order annotation. Authentication gets order one.",
    "ये क्रम हम कैसे तय करते हैं? ऑर्डर एनोटेशन से। ऑथेंटिकेशन को ऑर्डर एक मिलता है।",
    { pose: "point", ...snap("AuthenticationFilter.java", "java", AUTH_ORDER, { highlight: [1] }) });
  add("And the LoggingFilter gets order two. We uncomment its @Component too.",
    "और लॉगिंग फ़िल्टर को ऑर्डर दो मिलता है। उसका कंपोनेंट एनोटेशन भी अनकमेंट कर देते हैं।",
    { pose: "present", ...snap("LoggingFilter.java", "java", LOG_ORDER, { highlight: [1] }) });
  add("That is all we had to do. We restart, and both components are active.",
    "बस इतना ही करना था। रीस्टार्ट करते हैं, और दोनों कंपोनेंट एक्टिव हैं।",
    { pose: "smug" });
  add("With the correct token and the correct secret, we get Done. A wrong secret gives unauthorized. A wrong token, unauthorized again.",
    "सही टोकन और सही सीक्रेट पर डन मिलता है। गलत सीक्रेट पर अनऑथराइज़्ड। गलत टोकन पर भी अनऑथराइज़्ड।",
    { pose: "present", ...table("Both filters active", ["token", "API key", "Result"], [["12345", "secret123", "200 Done"], ["12345", "wrong", "401"], ["wrong", "secret123", "401"]], 0) });
  add("The code runs only when everything is correct. We combined two filters, and we can add order three, order four, and more.",
    "कोड तभी चलता है जब सब कुछ सही हो। हमने दो फ़िल्टर्स जोड़े, और हम ऑर्डर तीन, ऑर्डर चार, और भी जोड़ सकते हैं।",
    { pose: "point", mood: "happy" });
  add("Try to keep one responsibility per filter. A logging filter should only log. Do not stuff authentication into it.",
    "कोशिश करिए कि हर फ़िल्टर की सिर्फ़ एक ज़िम्मेदारी हो। लॉगिंग फ़िल्टर सिर्फ़ लॉग करे। उसमें ऑथेंटिकेशन मत भरिए।",
    { pose: "present", ...compare("versus", [{ title: "Master filter", points: ["Logs and authenticates", "Hard to test and change"] }, { title: "One job each", points: ["AuthenticationFilter", "LoggingFilter"], winner: true }]) });
  add("You could do everything in one filter, and then you would not need a chain. The chain exists so work can be separated.",
    "आप सब कुछ एक ही फ़िल्टर में भी कर सकते थे, तब चेन की ज़रूरत ही नहीं पड़ती। चेन इसीलिए है, ताकि काम अलग अलग रखा जा सके।",
    { pose: "point" });
  add("What if we skip @Order and keep both components? The chain is still created, but Spring decides the order.",
    "अगर हम ऑर्डर एनोटेशन न लगाएँ, और दोनों कंपोनेंट रखें, तो क्या होगा? चेन तब भी बनेगी, पर क्रम स्प्रिंग तय करेगा।",
    { pose: "think", props: [{ type: "question" }] });
  add("It may not be the same every time. On one machine authentication comes first, on another, logging does.",
    "हो सकता है हर बार एक जैसा न हो। किसी मशीन पर ऑथेंटिकेशन पहले आए, और किसी पर लॉगिंग।",
    { pose: "shrug", mood: "worried", ...alert("warning", "Order not guaranteed", "Always set @Order on chained filters") });
  ask("Two filters have no @Order. What happens when requests arrive?",
    ["Spring refuses to start", "The chain is built, but the order is not guaranteed", "The filter with the shorter name runs first"], 1,
    "Without @Order the chain still works. But Spring decides the order, so you cannot rely on it.",
    { q: "दो फ़िल्टर्स पर ऑर्डर एनोटेशन नहीं है। रिक्वेस्ट आने पर क्या होगा? ए, स्प्रिंग स्टार्ट ही नहीं होगा। बी, चेन बनेगी, पर क्रम की कोई गारंटी नहीं। या सी, छोटे नाम वाला फ़िल्टर पहले चलेगा।",
      a: "ऑर्डर के बिना भी चेन काम करती है। पर क्रम स्प्रिंग तय करता है, इसलिए उस पर भरोसा नहीं किया जा सकता।" });

  chapter("8 · Recap", "classroom");
  add("Let us recap. A filter sits before the DispatcherServlet and works on the request going in and the response coming out.",
    "चलिए दोहराते हैं। फ़िल्टर डिस्पैचर सर्वलेट से पहले बैठता है, और आती हुई रिक्वेस्ट और जाते हुए रिस्पॉन्स पर काम करता है।",
    { pose: "present", ...flow(["Client", "Filter", "DispatcherServlet", "Controller"], 1, "request") });
  add("It comes from Servlets, not from Spring. You implement jakarta dot servlet dot Filter, and write the logic in doFilter.",
    "ये सर्वलेट्स से आता है, स्प्रिंग से नहीं। आप जकार्ता डॉट सर्वलेट डॉट फ़िल्टर इम्प्लीमेंट करते हैं, और लॉजिक डू फ़िल्टर में लिखते हैं।",
    { pose: "point", ...steps(["Filter interface from jakarta.servlet", "Logic goes in doFilter", "chain.doFilter passes it on"], 1) });
  add("Calling chain dot doFilter hands the request to the next filter, and finally to the DispatcherServlet. Skip it, and the request stops.",
    "चेन डॉट डू फ़िल्टर बुलाने से रिक्वेस्ट अगले फ़िल्टर को, और आख़िर में डिस्पैचर सर्वलेट को मिलती है। न बुलाओ, तो रिक्वेस्ट वहीं रुक जाती है।",
    { pose: "present", ...steps(["Filter interface from jakarta.servlet", "Logic goes in doFilter", "chain.doFilter passes it on"], 2) });
  add("Use filters for work common to every request: logging, authentication, request IDs, timing, and headers.",
    "फ़िल्टर्स का इस्तेमाल उस काम के लिए करिए जो हर रिक्वेस्ट के लिए एक जैसा हो। लॉगिंग, ऑथेंटिकेशन, रिक्वेस्ट आईडी, टाइमिंग, और हेडर्स।",
    { pose: "point", ...steps(["Logging", "Authentication", "Request ID", "Timing", "Headers"], 4) });
  add("Set the headers before the chain call, put your logs in a finally block, and use @Order for a predictable chain.",
    "हेडर्स चेन कॉल से पहले सेट करिए, लॉग्स फ़ाइनली ब्लॉक में रखिए, और चेन का क्रम पक्का रखने के लिए ऑर्डर एनोटेशन लगाइए।",
    { pose: "smug", mood: "happy" });
  add("Filters and interceptors are both used a lot. Filters come from Servlets, interceptors from Spring. We will see interceptors next.",
    "फ़िल्टर्स और इंटरसेप्टर्स, दोनों बहुत इस्तेमाल होते हैं। फ़िल्टर्स सर्वलेट्स से आते हैं, और इंटरसेप्टर्स स्प्रिंग से। इंटरसेप्टर्स हम अगले वीडियो में देखेंगे।",
    { pose: "present" });
  add("If you enjoyed this video, please like it, leave a comment, and share your learning on Twitter and LinkedIn.",
    "अगर आपको ये वीडियो पसंद आया, तो प्लीज़ इसे लाइक करिए, कमेंट करिए, और अपनी सीख ट्विटर और लिंक्डइन पर शेयर करिए।",
    { pose: "celebrate", mood: "happy" });
  add("That is all for this video. See you in the next one. Until then, thank you so much.",
    "इस वीडियो में बस इतना ही। मिलते हैं अगले वीडियो में। तब तक के लिए, बहुत बहुत धन्यवाद।",
    { pose: "present", mood: "happy" });
};
