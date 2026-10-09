// Generates the plan-only JSON for the 15-minute English tutorial:
// "Spring Boot application.properties, @Value, @ConfigurationProperties & Runners" (Spring Boot Full Course #10)
// Sources: the lecture transcript, the course repo (adityatandon15/Spring-Framework-Full-Course, Lecture 10 code)
// and the lecture notes. Class names, keys, values and outputs come from them.
//   node spring-10-properties-runners.js out.json
const fs = require("fs");

const scenes = [];
let curSetting = "stage";
let chapterPending = null;
let pi = 0;
const POSES = ["present", "point", "think", "smug", "idle", "present", "point", "shrug"];

function add(text, vis = {}) {
  const v = { pose: POSES[pi++ % POSES.length], mood: "neutral", accent: "gold", setting: curSetting, ...vis };
  if (chapterPending) { v.chapter = chapterPending; chapterPending = null; }
  scenes.push({ i: scenes.length, text, ...v });
}
const chapter = (name, setting) => { chapterPending = name; curSetting = setting; };

const code = (title, language, lines, o = {}) => ({ code: { title, language, lines, ...o } });
const term = (lines, title = "Run") => ({ terminal: { title, lines } });
const flow = (nodes, active, packet) => ({ flow: { nodes, active, packet } });
const steps = (items, current) => ({ steps: { items, current } });
const scene = (background, items, arrows = []) => ({ scene: { background, items, arrows } });
const quiz = (question, options, answer, revealAt = 0.65) => ({ quiz: { question, options, answer, revealAt } });
const alert = (kind, title, detail) => ({ alert: { kind, title, detail } });
const compare = (mode, cards) => ({ compare: { mode, cards } });
const browser = (url, kind, lines, heading) => ({ browser: { url, kind, lines, heading } });
const table = (name, columns, rows) => ({ table: { name, columns, rows } });

// ── shared code snapshots (progressive building repeats the earlier lines) ──
const PROPS_BASE = ["spring.application.name=demo"];
const PROPS_VALUE = [...PROPS_BASE, "paymentGateway.type=paytm", "paymentGateway.retry-count=5"];
const PROPS_ALL = [...PROPS_VALUE, "payment-property.type=paytm", "payment-property.retry-count=5", "payment-property.enabled=true", "payment-property.timeout=3000"];
const MAIN_CTX = ["public static void main(String[] args) {", "  ApplicationContext context =", "    SpringApplication.run(DemoApplication.class, args);"];
const GW_FETCH = ["  PaymentGateway paymentGateway =", "    context.getBean(PaymentGateway.class);"];
const STEPS_CONFIG = ["application.properties", "application.yml", "Environment variables", "Command-line arguments", "System properties", "External config files"];

// ═══════════════════════ 1 · The problem ═══════════════════════
chapter("1 · The problem", "stage");
add("Imagine your payment provider is hard-coded inside a Java class.", { pose: "point", mood: "worried", ...code("PaymentGateway.java", "java", ["private String type = \"Razorpay\";", "private int retryCount = 3;"], { highlight: [0], animate: "type" }) });
add("Tomorrow the business wants to switch to another provider.", { pose: "shocked", mood: "shocked", ...compare("versus", [{ title: "Hard-coded", points: ["Change the Java code", "Recompile and rebuild", "Redeploy"] }, { title: "Configured", points: ["Edit one line", "Restart the app"], winner: true }]) });
add("With hard-coding, that means four steps for a single word.", { pose: "facepalm", mood: "sad", ...steps(["Change the Java code", "Recompile the project", "Rebuild the application", "Redeploy it"], 3) });
add("Many values change over time or between environments, and should not live in business logic.", { pose: "present", ...steps(["Payment provider name", "Retry count and timeout", "Feature enabled or disabled", "Database URL and API key", "Server port", "External service URL"], 0) });
add("A provider name, a timeout, a feature flag, a database address, an API key.", { pose: "point", ...steps(["Payment provider name", "Retry count and timeout", "Feature enabled or disabled", "Database URL and API key", "Server port", "External service URL"], 3) });
add("These belong outside the main code. That is where configuration files come in.", { pose: "smug", mood: "happy" });
add("There is a cleaner way, and it starts with one small file.", { pose: "smug", mood: "happy", props: [{ type: "bulb" }], callouts: ["ONE SMALL FILE"] });
add("Today: application.properties, the Value annotation, and ConfigurationProperties.", { pose: "present", ...steps(["application.properties", "@Value", "@ConfigurationProperties", "Runner interfaces"], 0) });
add("Then we will run code at startup, without touching the container ourselves.", { pose: "point", ...steps(["application.properties", "@Value", "@ConfigurationProperties", "Runner interfaces"], 3) });
add("By the end, you will bind a whole configuration file to a Java class.", { pose: "celebrate", mood: "excited", ...flow(["Config file", "Spring Boot", "Java class"], 2, "values") });

// ═══════════════════════ 2 · Where we are ═══════════════════════
chapter("2 · Where we are", "classroom");
add("Last time we saw how Spring Boot hides the IoC container and dependency injection.", { pose: "present", ...steps(["Annotation config", "XML config", "Spring Boot core"], 2) });
add("We started with annotation-based configuration, then moved on to XML-based configuration.", { pose: "point", ...flow(["Annotations", "XML", "Spring Boot"], 2, "config") });
add("Now we are strengthening the Spring Boot core, one concept at a time.", { pose: "smug" });
add("One habit we want to drop: pulling beans out of the context by hand.", { pose: "point", mood: "worried", ...code("DemoApplication.java", "java", ["context.getBean(PaymentGateway.class);"], { highlight: [0] }) });
add("Spring Boot wants annotations and auto-configuration. So how do we run our code directly?", { pose: "think", mood: "confused", props: [{ type: "question" }] });

// ═══════════════════════ 3 · Project setup ═══════════════════════
chapter("3 · Project setup", "office");
add("Start from an empty project generated with Spring Initializr.", { pose: "present", ...browser("start.spring.io", "page", ["Project: Maven   Language: Java", "Spring Boot: 4.1.0", "Group: in.strikes   Artifact: demo", "Package: in.strikes.demo", "Java: 21   Dependencies: none"], "Spring Initializr") });
add("We pick Maven, Java 21, Boot four point one, and no dependencies.", { pose: "point", ...browser("start.spring.io", "page", ["Project: Maven   Language: Java", "Spring Boot: 4.1.0", "Group: in.strikes   Artifact: demo", "Package: in.strikes.demo", "Java: 21   Dependencies: none"], "Spring Initializr") });
add("In pom.xml, there are just two dependencies: the starter, and the test starter.", { pose: "point", ...code("pom.xml", "xml", ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter</artifactId>", "</dependency>", "<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-test</artifactId>", "  <scope>test</scope>", "</dependency>"], { highlight: [2, 6], animate: "type" }) });
add("The same file shows the parent is Spring Boot starter parent, version four point one.", { pose: "point", ...code("pom.xml", "xml", ["<parent>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-parent</artifactId>", "  <version>4.1.0</version>", "</parent>", "<properties>", "  <java.version>21</java.version>", "</properties>"], { highlight: [3, 6], animate: "type" }) });
add("Spring Boot version four point one, running on Java 21.", { pose: "smug" });
add("Here is the main class, DemoApplication.", { pose: "present", ...code("DemoApplication.java", "java", ["package in.strikes.demo;", "", "@SpringBootApplication", "public class DemoApplication {", "  public static void main(String[] args) {", "    SpringApplication.run(DemoApplication.class, args);", "  }", "}"], { highlight: [5], animate: "type" }) });
add("In the resources folder lives application.properties, the heart of this lesson.", { pose: "present", ...code("application.properties", "properties", PROPS_BASE, { highlight: [0], animate: "type" }) });
add("By default it has one line: the application name is demo. We leave it.", { pose: "smug" });
add("Print Hello World in main, and run, to confirm everything works.", { pose: "think", ...code("DemoApplication.java", "java", ["public static void main(String[] args) {", "  SpringApplication.run(DemoApplication.class, args);", "  System.out.println(\"Hello World\");", "}"], { highlight: [2], revealFrom: 2, animate: "type" }) });
add("Spring starts, Hello World appears, and we are ready to build.", { pose: "celebrate", mood: "happy", ...term(["Hello World"]) });

// ═══════════════════════ 4 · A class with settings ═══════════════════════
chapter("4 · A class with settings", "office");
add("Create a class called PaymentGateway. Real gateways are many: Razorpay, Paytm, and more.", { pose: "present", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "}"], { animate: "type" }) });
add("It needs a field for the type of gateway.", { pose: "think", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "  private String type;", "}"], { highlight: [1], revealFrom: 1, animate: "type" }) });
add("And an integer: how many times to retry a failed payment.", { pose: "present", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "  private String type;", "  private int retryCount;", "}"], { highlight: [2], revealFrom: 2, animate: "type" }) });
add("Generate getters and setters. For now, this is just a plain Java object.", { pose: "idle", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "  private String type;", "  private int retryCount;", "  public String getType() { return type; }", "  public void setType(String type) { this.type = type; }", "  // getRetryCount and setRetryCount too", "}"], { highlight: [3, 4], revealFrom: 3 }) });
add("Add Component, and Spring scans and manages it as a bean.", { pose: "point", mood: "happy", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  // fields, getters and setters", "}"], { highlight: [0], animate: "type" }) });
add("In main, keep the context in a variable, so we can fetch the bean.", { pose: "think", ...code("DemoApplication.java", "java", MAIN_CTX, { highlight: [1, 2], animate: "type" }) });
add("Not a good habit, but we will improve it very soon.", { pose: "smug", mood: "smug" });
add("The context holds every bean, and only one PaymentGateway bean exists.", { pose: "present", ...flow(["SpringApplication.run", "ApplicationContext", "PaymentGateway bean"], 2, "getBean") });
add("So we simply ask the context for a bean of the PaymentGateway class.", { pose: "point", ...code("DemoApplication.java", "java", [...MAIN_CTX, ...GW_FETCH], { highlight: [3, 4], revealFrom: 3, animate: "type" }) });
add("Fetch the PaymentGateway bean, set the type to paytm, and the retry count to five.", { pose: "present", ...code("DemoApplication.java", "java", [...MAIN_CTX, ...GW_FETCH, "  paymentGateway.setType(\"paytm\");", "  paymentGateway.setRetryCount(5);"], { highlight: [5, 6], revealFrom: 3, animate: "type" }) });
add("Print both values, and we get paytm and five. Basic setting and getting.", { pose: "celebrate", mood: "happy", ...term(["paytm", "5"]) });
add("Now suppose the live application needs a different provider.", { pose: "worried", mood: "worried", ...scene("night", [{ asset: "money", x: 28, y: 52, size: 44, tint: "green", label: "paytm" }, { asset: "money", x: 72, y: 52, size: 44, tint: "blue", label: "razorpay" }], [{ from: [42, 52], to: [58, 52] }]) });
add("You edit the Java, recompile, merge, and push again. For one value.", { pose: "facepalm", mood: "sad" });
add("Settings change often, while business logic stays stable, so they should live apart.", { pose: "smug", mood: "happy" });
add("What if the values came from outside, so a config change was enough?", { pose: "think", mood: "confused", ...flow(["Config file", "Spring Boot", "Your Java code"], 2, "values") });

// ═══════════════════════ 5 · Configuration files ═══════════════════════
chapter("5 · Configuration files", "server");
add("That is exactly what application.properties is for.", { pose: "present", mood: "happy", ...code("application.properties", "properties", PROPS_BASE, { highlight: [0] }) });
add("It is a non-Java file: there is no dot java at the end.", { pose: "point", ...scene("lab", [{ asset: "document", x: 30, y: 52, size: 46, label: "application.properties" }, { asset: "cross", x: 72, y: 52, size: 36, label: "not .java" }]) });
add("Inside is a key, an equals sign, and a value, just like a map.", { pose: "present", ...table("properties", ["key", "value"], [["type", "paytm"], ["retry-count", "5"]]) });
add("Careful: this is not the Configuration annotation on a Java class.", { pose: "point", mood: "worried", ...code("AppConfig.java", "java", ["@Configuration", "public class AppConfig {", "  @Bean", "  public PaymentGateway gateway() {", "    return new PaymentGateway();", "  }", "}"], { highlight: [0, 2], animate: "type" }) });
add("That one is a Java class that defines beans. This file is plain configuration.", { pose: "present" });
add("It is special because it supplies values from outside your business logic.", { pose: "present", mood: "excited", ...flow(["application.properties", "Spring Boot", "Your Java code"], 2, "values") });
add("Spring Boot loads it automatically when the application starts.", { pose: "smug", ...scene("lab", [{ asset: "document", x: 28, y: 52, size: 44, label: "properties file" }, { asset: "robot", x: 72, y: 52, size: 44, label: "Spring Boot" }], [{ from: [42, 52], to: [58, 52] }]) });
add("By convention, it lives in the resources folder under source main.", { pose: "point", ...code("src/main/resources", "text", ["src/main/resources/", "  application.properties"], { highlight: [1] }) });
add("Instead of writing the provider name in Java, we write it in the file, and inject it.", { pose: "present", ...compare("beforeAfter", [{ title: "In Java", points: ["private String provider", "  = \"Razorpay\";"] }, { title: "In the file", points: ["payment.provider=Razorpay"] }]) });
add("Spring Boot also supports YAML: the same settings in application.yml.", { pose: "point", ...code("application.yml", "yaml", ["payment:", "  type: paytm", "  retry-count: 5", "  enabled: true", "  timeout: 3000"], { highlight: [2], animate: "type" }) });
add("The difference is only the writing style. Properties is the default.", { pose: "smug" });
add("Both do the same job, so pick one style and stay consistent in a project.", { pose: "present" });
add("A fair question: is a file inside resources really external?", { pose: "think", mood: "confused" });
add("Not quite. Inside src main resources, it is packaged into the final JAR.", { pose: "point", ...flow(["src/main/resources", "Build", "app.jar"], 2, "packaged") });
add("But Spring Boot has externalized configuration: values can come from outside the package.", { pose: "present", ...steps(STEPS_CONFIG, 0) });
add("Properties file, YAML, environment variables, command-line arguments, system properties.", { pose: "point", ...steps(STEPS_CONFIG, 4) });
add("And external config files. Same Java code, different values in each environment.", { pose: "present", ...compare("versus", [{ title: "Development", points: ["provider=TestProvider", "retry-count=1"] }, { title: "Production", points: ["provider=Razorpay", "retry-count=3"], winner: true }]) });
add("The main idea: keep changeable values outside the Java business logic.", { pose: "smug", mood: "happy", callouts: ["CONFIG OUTSIDE CODE"] });
add("So how does Java code ask for these values? Let us see.", { pose: "think", mood: "confused", props: [{ type: "question" }] });

// ═══════════════════════ 6 · The Value annotation ═══════════════════════
chapter("6 · The Value annotation", "office");
add("Add two keys to application.properties, in the same style.", { pose: "present", ...code("application.properties", "properties", PROPS_VALUE, { highlight: [1, 2], revealFrom: 1, animate: "type" }) });
add("The key is paymentGateway.type, equals paytm. Then retry-count, equals five.", { pose: "point", ...code("application.properties", "properties", PROPS_VALUE, { highlight: [1, 2] }) });
add("To read them in Java, Spring gives us a special annotation: Value.", { pose: "present", mood: "excited", callouts: ["@VALUE"] });
add("Start with a constructor that takes both values.", { pose: "idle", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  private String type;", "  private int retryCount;", "  public PaymentGateway(String type, int retryCount) {", "    this.type = type;", "    this.retryCount = retryCount;", "  }", "}"], { highlight: [4], revealFrom: 4, animate: "type" }) });
add("Before each parameter, write Value: a dollar sign, curly braces, then the key.", { pose: "point", ...code("PaymentGateway.java", "java", ["public PaymentGateway(", "  @Value(\"${paymentGateway.type}\")", "  String type,", "  @Value(\"${paymentGateway.retry-count}\")", "  int retryCount) {", "  this.type = type;", "  this.retryCount = retryCount;", "}"], { highlight: [1, 3], animate: "type" }) });
add("The dollar sign and curly braces tell Spring: resolve this property.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Value(\"${paymentGateway.type}\")"], { highlight: [0] }) });
add("Inside the braces is the key, exactly as written in the file.", { pose: "present", ...code("PaymentGateway.java", "java", ["@Value(\"${paymentGateway.type}\")"], { highlight: [0] }) });
add("It means: go to the Spring environment, find that property, and inject its value here.", { pose: "present", ...flow(["@Value key", "Spring Environment", "Constructor"], 2, "paytm") });
add("In main, comment out the setters and print the getters. Run it.", { pose: "idle", ...code("DemoApplication.java", "java", [...MAIN_CTX, ...GW_FETCH, "  // paymentGateway.setType(\"paytm\");", "  System.out.println(paymentGateway.getType());", "  System.out.println(paymentGateway.getRetryCount());"], { highlight: [5, 6], revealFrom: 5 }) });
add("An error appears, and it is a syntax mistake.", { pose: "shocked", mood: "shocked", ...alert("error", "UnsatisfiedDependencyException", "NumberFormatException: cannot convert text to int") });
add("I typed round brackets instead of curly braces. A classic typo.", { pose: "facepalm", mood: "sad", ...code("PaymentGateway.java", "java", ["@Value(\"$(paymentGateway.retry-count)\")", "int retryCount"], { highlight: [0] }) });
add("Fix it: dollar sign, then curly braces around the key.", { pose: "point", mood: "happy", ...code("PaymentGateway.java", "java", ["@Value(\"${paymentGateway.retry-count}\")", "int retryCount"], { highlight: [0], animate: "type" }) });
add("Run again. The warning is gone, and paytm and five print.", { pose: "celebrate", mood: "happy", ...term(["paytm", "5"]) });
add("The values came from the properties file, not from Java code.", { pose: "present", ...flow(["application.properties", "@Value", "PaymentGateway"], 2, "paytm") });
add("Notice the Java class never mentions paytm. Only the file does.", { pose: "smug", mood: "happy" });
add("Value also works directly on fields, just like Autowired.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  @Value(\"${paymentGateway.type}\")", "  private String type;", "  @Value(\"${paymentGateway.retry-count}\")", "  private int retryCount;", "}"], { highlight: [2, 4], animate: "type" }) });
add("Remove the constructor, run again, and the result is identical.", { pose: "smug", ...term(["paytm", "5"]) });
add("It even works on a setter method, so use whichever style you prefer.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Value(\"${paymentGateway.type}\")", "public void setType(String type) {", "  this.type = type;", "}"], { highlight: [0], animate: "type" }) });
add("What if the key does not exist? Spring cannot create the bean.", { pose: "shocked", mood: "shocked", ...alert("error", "BeanCreationException", "Could not resolve placeholder 'paymentGateway.type'") });
add("Look closely: it complains about autowiring. Value really is injection, for simple values.", { pose: "point", ...compare("versus", [{ title: "Autowired", points: ["Injects beans", "Like OrderService"] }, { title: "Value", points: ["Injects simple values", "String, int, boolean"] }]) });
add("Fix it with a default value, written after a colon.", { pose: "point", mood: "happy", ...code("PaymentGateway.java", "java", ["@Value(\"${paymentGateway.type:Razorpay}\")", "private String type;"], { highlight: [0], animate: "type" }) });
add("Use the key if it is available. If not, use the default.", { pose: "present", ...scene("room", [{ asset: "warning", x: 28, y: 52, size: 44, tint: "gold", label: "Key missing" }, { asset: "money", x: 72, y: 52, size: 44, tint: "blue", label: "Razorpay" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Pause and think. The key exists in the file. What happens?", { pose: "think", mood: "confused", ...quiz("The key exists in the file. Which value is used?", ["The file value", "The default value", "An error"], 0) });
add("The file value wins. The default is only a safety net.", { pose: "smug", mood: "happy" });
add("Run it to prove it, and paytm is printed.", { pose: "celebrate", ...term(["paytm"]) });
add("The retry count can have a default too: three.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Value(\"${paymentGateway.retry-count:3}\")", "private int retryCount;"], { highlight: [0], animate: "type" }) });
add("Defaults work on fields, constructors, and setters, and suit optional properties.", { pose: "present" });

// ═══════════════════════ 7 · ConfigurationProperties ═══════════════════════
chapter("7 · ConfigurationProperties", "classroom");
add("Now imagine many related properties, not just two.", { pose: "think", ...code("PaymentGateway.java", "java", ["@Value(\"${payment.provider}\")", "private String provider;", "@Value(\"${payment.retry-count}\")", "private int retryCount;", "@Value(\"${payment.enabled}\")", "private boolean enabled;", "@Value(\"${payment.timeout}\")", "private int timeout;"], { highlight: [0, 2, 4, 6], animate: "type" }) });
add("Value on every field works, but it gets messy, repetitive, and error-prone.", { pose: "shrug", mood: "worried" });
add("You could map the wrong value to the wrong variable.", { pose: "facepalm", mood: "sad" });
add("Pause and think. You have a dozen related settings. What fits best?", { pose: "think", mood: "confused", ...quiz("Many related settings. Which tool fits best?", ["A properties class", "Value on each field", "A runner"], 0) });
add("A class that binds the whole group. Spring Boot gives us ConfigurationProperties.", { pose: "present", mood: "excited", ...code("PaymentProperties.java", "java", ["@ConfigurationProperties(\"payment-property\")"], { highlight: [0], animate: "type" }) });
add("In enterprise apps, you often see such a class reading values from a non-Java file.", { pose: "present", ...scene("room", [{ asset: "document", x: 28, y: 52, size: 42, label: "properties file" }, { asset: "city", x: 72, y: 52, size: 42, label: "Enterprise app" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Create PaymentProperties, add Component, and the annotation with its prefix.", { pose: "point", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(\"paymentProperty\")", "public class PaymentProperties {", "}"], { highlight: [1], animate: "type" }) });
add("The prefix tells Spring which keys belong to this class. But our camel case fails.", { pose: "shocked", mood: "shocked", ...alert("error", "Invalid prefix", "Prefix must be in canonical form") });
add("Canonical form means lower case words, separated by hyphens.", { pose: "point", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(\"payment-property\")", "public class PaymentProperties {", "}"], { highlight: [1], animate: "type" }) });
add("Add four fields: type, retry count, enabled, and timeout.", { pose: "present", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(\"payment-property\")", "public class PaymentProperties {", "  private String type;", "  private int retryCount;", "  private boolean enabled;", "  private int timeout;", "}"], { highlight: [3, 4, 5, 6], revealFrom: 3, animate: "type" }) });
add("Generate getters and setters for all four. Spring uses them to bind the values.", { pose: "idle", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(\"payment-property\")", "public class PaymentProperties {", "  private String type;", "  private int retryCount;", "  private boolean enabled;", "  private int timeout;", "  // getters and setters for all four", "}"], { highlight: [7], revealFrom: 7 }) });
add("Now give each field a value, using the same prefix in application.properties.", { pose: "present", ...code("application.properties", "properties", PROPS_ALL, { highlight: [3, 4, 5, 6], revealFrom: 3, animate: "type" }) });
add("Type is paytm, retry count is five, enabled is true, timeout is three thousand.", { pose: "point", ...code("application.properties", "properties", PROPS_ALL, { highlight: [3, 4, 5, 6] }) });
add("Why does retry-count with a hyphen reach the retryCount field?", { pose: "think", mood: "confused" });
add("Because of relaxed binding: Spring Boot understands several naming styles.", { pose: "present", mood: "excited", ...steps(["retry-count (kebab-case)", "retryCount (camelCase)", "retry_count (underscore)", "RETRY_COUNT (upper case)"], 0) });
add("In Java we use camel case. In properties files we usually use kebab case.", { pose: "point", ...compare("beforeAfter", [{ title: "properties file", points: ["retry-count"] }, { title: "Java field", points: ["retryCount"] }]) });
add("Spring Boot connects both, so each file keeps its own convention.", { pose: "smug", mood: "happy", ...flow(["retry-count", "Spring Boot", "retryCount"], 2, "mapped") });
add("One more convention: a boolean field gets a getter named isEnabled.", { pose: "point", ...code("PaymentProperties.java", "java", ["// wrong", "public boolean getEnabled() { ... }", "// right", "public boolean isEnabled() { ... }"], { highlight: [3], animate: "type" }) });
add("PaymentProperties now reads all four values itself, with no Value annotation.", { pose: "celebrate", mood: "happy", ...scene("lab", [{ asset: "document", x: 28, y: 52, size: 42, label: "properties" }, { asset: "check", x: 72, y: 52, size: 42, label: "Bound" }], [{ from: [42, 52], to: [58, 52] }]) });

const MAPPING = ["payment-property.type: type", "payment-property.retry-count: retryCount", "payment-property.enabled: enabled", "payment-property.timeout: timeout"];
add("Here is the mapping Spring Boot performs, key by key.", { pose: "present", ...steps(MAPPING, 0) });
add("The type key fills type, and the retry-count key fills retryCount.", { pose: "point", ...steps(MAPPING, 1) });
add("Enabled fills enabled, and timeout fills timeout.", { pose: "point", ...steps(MAPPING, 3) });
const MISTAKES = ["Round brackets instead of curly braces", "Camel case in the prefix", "Missing key and no default value", "Boolean getter not named isEnabled"];
add("Before we continue, four mistakes we just made, and you will make them too.", { pose: "present", mood: "happy", ...steps(MISTAKES, 0) });
add("One: round brackets instead of curly braces in the Value annotation.", { pose: "point", ...steps(MISTAKES, 0) });
add("Two: a camel case prefix, when Spring wants lower case with hyphens.", { pose: "point", ...steps(MISTAKES, 1) });
add("Three: a missing key with no default, which stops the bean from being created.", { pose: "point", ...steps(MISTAKES, 2) });
add("Four: a boolean getter that is not named isEnabled.", { pose: "point", ...steps(MISTAKES, 3) });
add("Errors are friendly teachers. Read them, fix them, and move on.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 8 · Injecting the properties ═══════════════════════
chapter("8 · Injecting the properties", "office");
add("Now PaymentGateway should use these values, without reading the file itself.", { pose: "think" });
add("The standard pattern: a properties class reads the file, and other classes depend on it.", { pose: "present", ...flow(["application.properties", "PaymentProperties", "PaymentGateway"], 2, "values") });
add("So PaymentGateway receives PaymentProperties through constructor injection.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  private PaymentProperties paymentProperties;", "  public PaymentGateway(", "      PaymentProperties paymentProperties) {", "    this.paymentProperties = paymentProperties;", "  }", "}"], { highlight: [2, 3, 4, 5], revealFrom: 2, animate: "type" }) });
add("No Autowired needed: Spring injects it automatically.", { pose: "smug", mood: "happy" });
add("So we now have two components: one reads the file, the other uses the values.", { pose: "present", ...scene("lab", [{ asset: "document", x: 28, y: 52, size: 42, label: "PaymentProperties" }, { asset: "gear", x: 72, y: 52, size: 42, label: "PaymentGateway" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Add getters that delegate to the properties object.", { pose: "present", ...code("PaymentGateway.java", "java", ["public String getType() {", "  return paymentProperties.getType();", "}", "public int getRetryCount() {", "  return paymentProperties.getRetryCount();", "}"], { highlight: [1, 4], animate: "type" }) });
add("The same for isEnabled and getTimeout.", { pose: "point", ...code("PaymentGateway.java", "java", ["public boolean isEnabled() {", "  return paymentProperties.isEnabled();", "}", "public int getTimeout() {", "  return paymentProperties.getTimeout();", "}"], { highlight: [1, 4], animate: "type" }) });
add("Then a print method that prints all four values.", { pose: "present", ...code("PaymentGateway.java", "java", ["public void print() {", "  System.out.println(getType());", "  System.out.println(getRetryCount());", "  System.out.println(isEnabled());", "  System.out.println(getTimeout());", "}"], { highlight: [1, 2, 3, 4], animate: "type" }) });
add("In main, fetch the bean and call print. Run it.", { pose: "point", ...code("DemoApplication.java", "java", [...MAIN_CTX, ...GW_FETCH, "  paymentGateway.print();"], { highlight: [5], revealFrom: 5, animate: "type" }) });
add("All four values print: paytm, five, true, three thousand.", { pose: "celebrate", mood: "excited", ...term(["paytm", "5", "true", "3000"]) });
add("Spring Boot read the file, filled PaymentProperties, and injected it into the gateway.", { pose: "present", ...flow(["Properties file", "PaymentProperties", "PaymentGateway"], 2, "paytm") });
add("Why not use the properties class everywhere? Because the standard pattern is a normal service class.", { pose: "think" });
add("The properties class only reads. The gateway holds the business logic.", { pose: "present", ...compare("versus", [{ title: "PaymentProperties", points: ["Reads the file", "Holds the values"] }, { title: "PaymentGateway", points: ["Business logic", "Uses the values"], winner: true }]) });

// ═══════════════════════ 9 · Running code at startup ═══════════════════════
chapter("9 · Running code at startup", "server");
add("Now the second topic: starting our code without touching the container.", { pose: "present", mood: "excited" });
add("In a web app, an HTTP request triggers a controller and a service method.", { pose: "present", ...flow(["Browser", "Controller", "Service method"], 2, "GET /print") });
add("Here, we use no web starter, no endpoint, and no browser request.", { pose: "shrug" });
add("So we need a way to run code after the application starts.", { pose: "point" });
add("Calling the bean from main works, but it is a manual style.", { pose: "worried", mood: "worried", ...code("DemoApplication.java", "java", [...MAIN_CTX, ...GW_FETCH, "  paymentGateway.print();"], { highlight: [1, 3, 5] }) });
add("Start the context manually, fetch the bean manually, call the method manually.", { pose: "facepalm", mood: "sad", ...steps(["Start the context manually", "Fetch the bean manually", "Call the method manually"], 2) });
add("The Spring Boot way: let Spring create a bean that runs automatically after startup.", { pose: "smug", mood: "happy" });
add("That is what the runner interfaces are for. First, ApplicationRunner.", { pose: "present", mood: "excited", ...code("ApplicationRunner.java", "java", ["public interface ApplicationRunner {", "  void run(ApplicationArguments args)", "      throws Exception;", "}"], { highlight: [1], animate: "type" }) });
add("Create DemoRunner, with Component, implementing ApplicationRunner.", { pose: "point", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner implements ApplicationRunner {", "}"], { highlight: [1], animate: "type" }) });
add("It needs the PaymentGateway, so inject it through the constructor.", { pose: "point", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner implements ApplicationRunner {", "  private PaymentGateway paymentGateway;", "  public DemoRunner(PaymentGateway paymentGateway) {", "    this.paymentGateway = paymentGateway;", "  }", "}"], { highlight: [2, 3, 4], revealFrom: 2, animate: "type" }) });
add("The interface has one method, run. We override it, and call print.", { pose: "present", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner implements ApplicationRunner {", "  private PaymentGateway paymentGateway;", "  public DemoRunner(PaymentGateway paymentGateway) {", "    this.paymentGateway = paymentGateway;", "  }", "  @Override", "  public void run(ApplicationArguments args)", "      throws Exception {", "    paymentGateway.print();", "  }", "}"], { highlight: [9], revealFrom: 6, animate: "type" }) });
add("Now main does not need the context code at all. Comment it out.", { pose: "smug", mood: "happy", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  // PaymentGateway paymentGateway =", "  //   context.getBean(PaymentGateway.class);", "  // paymentGateway.print();"], { highlight: [3, 4, 5], revealFrom: 3 }) });
add("Run it. The runner fires on its own, and all four values print.", { pose: "celebrate", mood: "excited", ...term(["paytm", "5", "true", "3000"]) });
add("The flow: Spring creates DemoRunner, injects the gateway, and calls run after startup.", { pose: "present", ...flow(["Create DemoRunner", "Inject gateway", "run() after startup"], 2, "startup") });
add("In short: Spring creates the runner bean, injects its dependency, then calls run.", { pose: "point", ...steps(["Spring creates the runner bean", "Spring injects the PaymentGateway", "Boot sees the runner interface", "Boot calls run() after startup", "paymentGateway.print() executes"], 3) });
add("And the application keeps running, or exits, depending on its type.", { pose: "shrug" });
add("There is a second, very similar interface: CommandLineRunner.", { pose: "point", ...code("CommandLineRunner.java", "java", ["public interface CommandLineRunner {", "  void run(String... args)", "      throws Exception;", "}"], { highlight: [1], animate: "type" }) });
add("Switch DemoRunner to CommandLineRunner. Same call to print.", { pose: "present", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner implements CommandLineRunner {", "  private PaymentGateway paymentGateway;", "  public DemoRunner(PaymentGateway paymentGateway) {", "    this.paymentGateway = paymentGateway;", "  }", "  @Override", "  public void run(String... args) throws Exception {", "    paymentGateway.print();", "  }", "}"], { highlight: [1, 7], animate: "type" }) });
add("Run it, and the output is exactly the same.", { pose: "celebrate", ...term(["paytm", "5", "true", "3000"]) });
add("Those three dots after String mean zero, one, or many arguments.", { pose: "present", ...code("DemoRunner.java", "java", ["public void run(String... args)"], { highlight: [0] }) });
add("The difference is the arguments. Start the jar with two words.", { pose: "point", ...term(["$ java -jar app.jar hello world"]) });
add("CommandLineRunner receives them as raw strings, so we can loop over them.", { pose: "present", ...code("DemoRunner.java", "java", ["@Override", "public void run(String... args) {", "  for (String arg : args) {", "    System.out.println(arg);", "  }", "}"], { highlight: [2, 3], animate: "type" }) });
add("The output is hello, then world.", { pose: "smug", ...term(["$ java -jar app.jar hello world", "hello", "world"]) });
add("ApplicationRunner gives a structured object that understands named options.", { pose: "present", ...term(["$ java -jar app.jar --provider=Razorpay --retry=3"]) });
add("Read them with getOptionValues, by option name.", { pose: "point", ...code("DemoRunner.java", "java", ["@Override", "public void run(ApplicationArguments args) {", "  System.out.println(", "    args.getOptionValues(\"provider\"));", "  System.out.println(", "    args.getOptionValues(\"retry\"));", "}"], { highlight: [3, 5], animate: "type" }) });
add("Pause and think. Both runners ran our code. How do they differ?", { pose: "think", mood: "confused", ...quiz("How do the two runners differ?", ["Argument form", "Startup order", "One needs Component"], 0) });
add("CommandLineRunner gives raw strings. ApplicationRunner gives a structured arguments object.", { pose: "present", mood: "happy", ...compare("versus", [{ title: "CommandLineRunner", points: ["run(String... args)", "Raw strings"] }, { title: "ApplicationRunner", points: ["run(ApplicationArguments)", "Structured options"] }]) });
add("The class name does not matter to Spring Boot. The interface is what counts.", { pose: "present" });
add("For a console application, either works. Pick the one you prefer.", { pose: "smug" });

// ═══════════════════════ 10 · Startup flow and the terminal ═══════════════════════
chapter("10 · The full startup flow", "server");
add("You can also run the application without the green button.", { pose: "present" });
add("Open a terminal in the project folder, and use Maven.", { pose: "point", ...term(["$ mvn spring-boot:run"]) });
add("If Maven is not installed, install it first, and then repeat the command.", { pose: "shrug" });
add("The runner fires, all four values appear, and the build succeeds.", { pose: "celebrate", mood: "excited", ...term(["$ mvn spring-boot:run", "paytm", "5", "true", "3000", "[INFO] BUILD SUCCESS"]) });
const FLOW = ["main() calls SpringApplication.run()", "Environment prepared, config loaded", "ApplicationContext is created", "Component scan finds your classes", "Auto-configuration is applied", "Beans created, dependencies injected", "@Value and properties are bound", "Runners execute"];
add("Let us put it all together, in the order Spring Boot does it.", { pose: "present", ...steps(FLOW, 0) });
add("First the environment is prepared, and configuration values are loaded.", { pose: "point", ...steps(FLOW, 1) });
add("Then the context is created, and component scan finds your classes.", { pose: "point", ...steps(FLOW, 3) });
add("Auto-configuration applies, beans are created, and dependencies are injected.", { pose: "point", ...steps(FLOW, 5) });
add("Configuration values are bound, and finally the runners execute.", { pose: "celebrate", mood: "happy", ...steps(FLOW, 7) });

// ═══════════════════════ 11 · Recap and your task ═══════════════════════
chapter("11 · Recap and your task", "stage");
const RECAP = ["application.properties keeps values outside code", "@Value injects one value (default optional)", "@ConfigurationProperties binds a group", "Relaxed binding: retry-count to retryCount", "Runners start code after startup"];
add("Let us recap with five key ideas.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: application.properties keeps changeable values outside your Java code.", { pose: "point", ...steps(RECAP, 0) });
add("Two: Value injects a single property, with an optional default.", { pose: "point", ...steps(RECAP, 1) });
add("Three: ConfigurationProperties binds a whole group of keys to one class.", { pose: "point", ...steps(RECAP, 2) });
add("Four: Spring maps kebab case keys to camel case fields for you.", { pose: "point", ...steps(RECAP, 3) });
add("Five: runner interfaces run your code after the application starts.", { pose: "point", ...steps(RECAP, 4) });
add("The simple rule: one or two values, use Value. A group of values, use ConfigurationProperties.", { pose: "smug", mood: "happy", ...compare("versus", [{ title: "@Value", points: ["One or two values", "Small demos"] }, { title: "@ConfigurationProperties", points: ["A group of values", "Cleaner, larger apps"], winner: true }]) });
const TASK = ["Add payment-property.currency to the file", "Add a field and getters for it", "Print it from a runner"];
add("Now a challenge for you, without looking back at the code.", { pose: "smug", mood: "excited", ...steps(TASK, 0) });
add("Add a currency property, bind it in PaymentProperties, and print it from a runner.", { pose: "point", ...steps(TASK, 2) });
add("In the next video, we start the Spring Boot web application and build a CRUD app.", { pose: "present", mood: "excited", ...scene("sky", [{ asset: "globe", x: 30, y: 52, size: 46, label: "Web app" }, { asset: "rocket", x: 70, y: 52, size: 46, label: "CRUD" }], [{ from: [44, 52], to: [56, 52] }]) });
add("Review the lecture notes, and try the code from the course repository yourself.", { pose: "point", mood: "happy" });
add("Thanks for watching, and see you in the next lesson.", { pose: "celebrate", mood: "happy" });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "Spring Boot application.properties, @Value, @ConfigurationProperties & Runners | Spring Boot Full Course #10",
  description:
    "Stop hard-coding settings in Java. In this Spring Boot lesson you will learn how application.properties works, how externalized configuration keeps values outside your code, " +
    "how to inject single values with @Value (including defaults), how to bind a whole group of keys to a class with @ConfigurationProperties (relaxed binding included), " +
    "and how to run code at startup with CommandLineRunner and ApplicationRunner, including command-line arguments.\n\n" +
    "Chapters: 1 The problem | 2 Where we are | 3 Project setup | 4 A class with settings | 5 Configuration files | 6 The Value annotation | 7 ConfigurationProperties | 8 Injecting the properties | 9 Running code at startup | 10 The full startup flow | 11 Recap and your task\n\n" +
    "Code: github.com/adityatandon15/Spring-Framework-Full-Course (Lecture 10)\n\n#SpringBoot #Java #CodeOrCap",
  tags: ["Spring Boot", "application.properties", "@Value", "ConfigurationProperties", "ApplicationRunner", "CommandLineRunner", "Spring Boot tutorial", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "spring-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
