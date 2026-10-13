// Chapter 6: an AuthenticationFilter - token header, 401, X-API-KEY, an error body written from the filter.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, alert, compare, browser, table, snap } = L;

const A_HEAD = [
  "@Component",
  "public class AuthenticationFilter implements Filter {",
  "  @Override",
  "  public void doFilter(ServletRequest request,",
  "      ServletResponse response, FilterChain chain)",
  "      throws IOException, ServletException {",
  "    HttpServletRequest httpRequest =",
  "        (HttpServletRequest) request;",
  "    HttpServletResponse httpResponse =",
  "        (HttpServletResponse) response;",
];
const A_TOKEN = [
  "String token = httpRequest.getHeader(\"token\");",
  "",
  "if (token == null || !token.equals(\"12345\")) {",
  "  httpResponse.setStatus(",
  "      HttpServletResponse.SC_UNAUTHORIZED);",
  "  return;",
  "}",
  "",
  "chain.doFilter(request, response);",
];
const A_KEY = [
  "String apiKey = httpRequest.getHeader(\"X-API-KEY\");",
  "",
  "if (apiKey == null || !apiKey.equals(\"secret123\")) {",
  "  httpResponse.setStatus(",
  "      HttpServletResponse.SC_UNAUTHORIZED);",
  "  httpResponse.setContentType(\"application/json\");",
  "  httpResponse.getWriter().write(",
  "      \"{\\\"message\\\":\\\"Invalid or missing API key\\\"}\");",
  "  return;",
  "}",
];
const STAGES = ["Logging", "Authentication", "Request ID", "Request time", "Error response"];

module.exports = () => {
  chapter("6 · Authentication in a filter", "server");
  add("The second use case: authentication. Every request must carry a header named token, with a value we agree on, one two three four five.",
    "दूसरा उपयोग, ऑथेंटिकेशन। हर रिक्वेस्ट के साथ टोकन नाम का एक हेडर आना चाहिए, जिसकी वैल्यू हमने तय की है, एक दो तीन चार पाँच।",
    { pose: "present", ...browser("POST localhost:8080/api/students", "json", ["token: 12345"], "Request header") });
  add("In real life there is a separate API that generates the token, and we use JWT tokens. We will see that in Spring Security.",
    "असली ज़िंदगी में टोकन बनाने के लिए एक अलग एपीआई होती है, और हम जेडब्ल्यूटी टोकन इस्तेमाल करते हैं। वो हम स्प्रिंग सिक्योरिटी में देखेंगे।",
    { pose: "point" });
  add("For now, a simple rule: send the right token and you are legitimate. Otherwise, we block you.",
    "अभी के लिए एक सीधा नियम। सही टोकन भेजो तो आप सही यूज़र हो। वरना हम आपको रोक देंगे।",
    { pose: "smug" });
  add("We create a new class, AuthenticationFilter. And in LoggingFilter we comment out @Component, so only the new filter runs.",
    "हम एक नई क्लास बनाते हैं, ऑथेंटिकेशन फ़िल्टर। और लॉगिंग फ़िल्टर में कंपोनेंट एनोटेशन कमेंट कर देते हैं, ताकि सिर्फ़ नया फ़िल्टर चले।",
    { pose: "point", ...snap("AuthenticationFilter.java", "java", A_HEAD, { highlight: [0, 1] }) });
  add("First, we read the header named token, with httpRequest dot getHeader.",
    "सबसे पहले हम टोकन नाम का हेडर पढ़ते हैं, एचटीटीपी रिक्वेस्ट डॉट गेट हेडर से।",
    { pose: "present", ...snap("Auth check", "java", A_TOKEN, { highlight: [0] }) });
  add("If the token is null, or it does not equal one two three four five, the user must not go any further.",
    "अगर टोकन नल है, या एक दो तीन चार पाँच के बराबर नहीं है, तो यूज़र को आगे नहीं जाने देना है।",
    { pose: "point", ...snap("Auth check", "java", A_TOKEN, { highlight: [2] }) });
  add("We set the status to SC_UNAUTHORIZED, which is 401, and then we return.",
    "हम स्टेटस सेट करते हैं, एससी अनऑथराइज़्ड, यानी चार सौ एक, और उसके बाद रिटर्न कर देते हैं।",
    { pose: "present", ...snap("Auth check", "java", A_TOKEN, { highlight: [3, 4, 5] }) });
  add("Returning means the chain is never called. The request does not travel any further, and the client gets the answer right here.",
    "रिटर्न का मतलब है, चेन कभी बुलाई ही नहीं गई। रिक्वेस्ट आगे नहीं बढ़ती, और क्लाइंट को जवाब यहीं मिल जाता है।",
    { pose: "point", ...flow(["Client", "AuthenticationFilter", "DispatcherServlet"], 1, "401") });
  add("If everything is fine, we call chain dot doFilter, and the legitimate user moves ahead.",
    "अगर सब ठीक है, तो हम चेन डॉट डू फ़िल्टर बुलाते हैं, और सही यूज़र आगे बढ़ जाता है।",
    { pose: "present", ...snap("Auth check", "java", A_TOKEN, { highlight: [8] }) });
  add("We run it, and the wrong token still gives 200. Why? We forgot @Component on the new filter, so Spring never created it.",
    "हम ऐप चलाते हैं, और गलत टोकन पर भी दो सौ आ रहा है। क्यों? नए फ़िल्टर पर कंपोनेंट लगाना भूल गए, इसलिए स्प्रिंग ने उसे बनाया ही नहीं।",
    { pose: "facepalm", mood: "confused", ...alert("error", "Filter never created", "@Component is missing") });
  add("We add @Component, restart, and test again. The right token returns Done. The wrong one returns 401 Unauthorized.",
    "कंपोनेंट लगाते हैं, रीस्टार्ट करते हैं, और फिर टेस्ट करते हैं। सही टोकन पर डन आता है। गलत टोकन पर चार सौ एक अनऑथराइज़्ड।",
    { pose: "celebrate", mood: "happy", ...table("Postman results", ["token", "Result"], [["12345", "200 Done"], ["1234", "401 Unauthorized"]], 1) });
  add("That is our simple authentication filter. So far one filter logged, and the other authenticated.",
    "ये हमारा सिंपल ऑथेंटिकेशन फ़िल्टर है। अब तक एक फ़िल्टर ने लॉग किया, और दूसरे ने ऑथेंटिकेट।",
    { pose: "smug" });

  add("Now a trickier one: send an error response body from the filter. Say every client must also send an API key.",
    "अब एक और मुश्किल बात। फ़िल्टर से ही एरर रिस्पॉन्स की बॉडी भेजना। मान लीजिए हर क्लाइंट को एक एपीआई की भी भेजनी है।",
    { pose: "present", mood: "excited" });
  add("We read a header named X-API-KEY. Header names are case-insensitive, so lowercase works too.",
    "हम एक्स एपीआई की नाम का हेडर पढ़ते हैं। हेडर के नाम केस इनसेंसिटिव होते हैं, तो छोटे अक्षर भी चलेंगे।",
    { pose: "point", ...snap("API key check", "java", A_KEY, { highlight: [0] }) });
  add("If the key is null, or it is not secret123, we answer 401 again. But this time with a JSON body.",
    "अगर की नल है, या सीक्रेट एक सौ तेईस नहीं है, तो हम फिर से चार सौ एक भेजते हैं। लेकिन इस बार जेसन बॉडी के साथ।",
    { pose: "present", ...snap("API key check", "java", A_KEY, { highlight: [2, 3, 4] }) });
  add("We set the content type to application slash json, then write the body with getWriter dot write, and return.",
    "हम कंटेंट टाइप सेट करते हैं, एप्लीकेशन स्लैश जेसन, फिर गेट राइटर डॉट राइट से बॉडी लिखते हैं, और रिटर्न कर देते हैं।",
    { pose: "point", ...snap("API key check", "java", A_KEY, { highlight: [5, 6, 7, 8] }) });
  add("The message says: Invalid or missing API key. You can find all these methods in the servlet videos.",
    "मैसेज है, इनवैलिड ऑर मिसिंग एपीआई की। ये सारे मेथड आपको सर्वलेट वाले वीडियो में मिल जाएँगे।",
    { pose: "present", ...browser("401 Unauthorized", "json", ["{", "  \"message\": \"Invalid or missing API key\"", "}"], "Response body") });
  add("A bug from the lecture: the condition used equals where it needed not equals, so even the right key was rejected.",
    "लेक्चर की एक गलती। कंडीशन में नॉट इक्वल्स चाहिए था, पर इक्वल्स लग गया था, इसलिए सही की भी रिजेक्ट हो रही थी।",
    { pose: "facepalm", mood: "confused", ...compare("beforeAfter", [{ title: "Wrong", points: ["apiKey.equals(...)", "right key rejected"] }, { title: "Right", points: ["!apiKey.equals(...)", "wrong key rejected"] }]) });
  add("After the fix, the right key and the right token pass. A wrong key returns Invalid or missing API key.",
    "ठीक करने के बाद, सही की और सही टोकन पास हो जाते हैं। गलत की पर इनवैलिड ऑर मिसिंग एपीआई की आता है।",
    { pose: "celebrate", mood: "happy" });
  add("Sending an error body from a filter is not a usual practice. But it is fine when a required key is missing and we stop early.",
    "फ़िल्टर से एरर बॉडी भेजना आम तरीका नहीं है। लेकिन जब कोई ज़रूरी की ग़ायब हो और हमें जल्दी रुकना हो, तब ये ठीक है।",
    { pose: "shrug" });
  add("So far, a filter gave us five things: logging, authentication, a request ID, the request time, and an error response.",
    "अब तक फ़िल्टर ने हमें पाँच चीज़ें दीं। लॉगिंग, ऑथेंटिकेशन, रिक्वेस्ट आईडी, रिक्वेस्ट टाइम, और एरर रिस्पॉन्स।",
    { pose: "present", mood: "excited", ...steps(STAGES, 4) });
};
