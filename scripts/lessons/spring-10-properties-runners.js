// Generates the plan-only JSON for the 15-minute English tutorial:
// "Spring Boot application.properties, @Value, @ConfigurationProperties & Runners"
// Source: the user's Hindi lecture transcript (Spring Boot Full Course #10). Facts, names and values come from it.
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

// ── shared code snapshots (progressive building repeats the earlier lines) ──
const PROPS_BASE = ["spring.application.name=demo"];
const PROPS_VALUE = [...PROPS_BASE, "payment.gateway.type=Paytm", "payment.gateway.retry-count=5"];
const PROPS_ALL = [...PROPS_VALUE, "payment-property.type=Paytm", "payment-property.retry-count=5", "payment-property.enabled=true", "payment-property.timeout=3000"];
const MAIN_CTX = ["public static void main(String[] args) {", "  ApplicationContext context =", "    SpringApplication.run(DemoApplication.class, args);"];

// ═══════════════════════ 1 · The problem ═══════════════════════
chapter("1 · The problem", "stage");
add("Imagine your payment gateway name is hard-coded inside Java.", { pose: "point", mood: "worried", ...code("PaymentGateway.java", "java", ["PaymentGateway pg = new PaymentGateway();", "pg.setType(\"Paytm\");", "pg.setRetryCount(5);"], { highlight: [1], animate: "type" }) });
add("Next month, the business decides to switch to Razorpay.", { pose: "shocked", mood: "shocked", ...compare("versus", [{ title: "Hard-coded", points: ["Edit the Java", "Recompile", "Redeploy"] }, { title: "Configured", points: ["Edit one line", "Restart the app"], winner: true }]) });
add("So you edit Java, recompile, merge, and redeploy, just to change one word.", { pose: "facepalm", mood: "sad", title: "One word, one deploy" });
add("There is a much better way, and it starts with one small file.", { pose: "smug", mood: "happy", callouts: ["ONE SMALL FILE"], props: [{ type: "bulb" }] });
add("If you missed the last lectures, watch them first; the links are in the description.", { pose: "present", mood: "happy" });
add("Today you will learn application.properties, the Value annotation, and ConfigurationProperties.", { pose: "present", ...steps(["application.properties", "@Value", "@ConfigurationProperties", "Application runners"], 0) });
add("Then you will run code at startup, without touching the container yourself.", { pose: "point", ...steps(["application.properties", "@Value", "@ConfigurationProperties", "Application runners"], 3) });
add("By the end, you will bind a whole configuration file to a Java class.", { pose: "celebrate", mood: "excited", ...flow(["Config file", "Spring Boot", "Java class"], 2, "values") });
add("This lesson builds on the last two: annotation-based and XML-based configuration.", { pose: "think", ...steps(["Annotation config", "XML config", "Spring Boot core"], 2) });

// ═══════════════════════ 2 · Where we are ═══════════════════════
chapter("2 · Where we are", "classroom");
add("Last time we saw how Spring Boot handles dependency injection and the IoC container for us.", { pose: "present", ...scene("lab", [{ asset: "gear", x: 30, y: 52, size: 46, label: "IoC container" }, { asset: "robot", x: 70, y: 52, size: 46, label: "Spring Boot" }], [{ from: [43, 52], to: [57, 52] }]) });
add("We wrote far less code, and the framework did the wiring.", { pose: "smug", mood: "happy" });
add("One habit we want to drop: pulling beans out of the context by hand.", { pose: "point", mood: "worried", ...code("DemoApplication.java", "java", ["context.getBean(PaymentGateway.class);"], { highlight: [0] }) });
add("Spring Boot wants you to use annotations, and let everything auto-configure.", { pose: "present" });
add("So we need a way to run our code directly. That is the second half of today.", { pose: "think", mood: "confused", props: [{ type: "question" }] });

// ═══════════════════════ 3 · Project setup ═══════════════════════
chapter("3 · Project setup", "office");
add("Start from an empty project generated with Spring Initializr.", { pose: "present", ...browser("start.spring.io", "page", ["Project: Maven", "Language: Java 21", "Spring Boot: 4.1.0", "Dependencies: none"], "Spring Initializr") });
add("Choose Java, Maven, Spring Boot version four point one, and Java 21.", { pose: "point", ...browser("start.spring.io", "page", ["Project: Maven", "Language: Java 21", "Spring Boot: 4.1.0", "Dependencies: none"], "Spring Initializr") });
add("Pick properties for configuration, add no dependencies, then click Generate.", { pose: "idle", ...browser("start.spring.io", "page", ["Config: properties", "Dependencies: none", "[ Generate ]"], "Spring Initializr") });
add("Open pom.xml and you will find just two dependencies.", { pose: "point", ...code("pom.xml", "xml", ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter</artifactId>", "</dependency>", "<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-test</artifactId>", "</dependency>"], { highlight: [2, 6], animate: "type" }) });
add("The Spring Boot starter and the starter for tests: a basic Spring Boot project.", { pose: "present" });
add("Here is the main class, DemoApplication.java.", { pose: "point", ...code("DemoApplication.java", "java", ["@SpringBootApplication", "public class DemoApplication {", "", "  public static void main(String[] args) {", "    SpringApplication.run(DemoApplication.class, args);", "  }", "}"], { highlight: [4], animate: "type" }) });
add("In the resources folder lives application.properties, the heart of this lesson.", { pose: "present", ...code("application.properties", "properties", PROPS_BASE, { highlight: [0], animate: "type" }) });
add("By default it holds one line: the application name is demo.", { pose: "point", ...code("application.properties", "properties", PROPS_BASE, { highlight: [0] }) });
add("We do not need to change it. Let us make sure everything runs.", { pose: "smug" });
add("Print Hello World in main, then start the application.", { pose: "think", ...code("DemoApplication.java", "java", ["public static void main(String[] args) {", "  SpringApplication.run(DemoApplication.class, args);", "  System.out.println(\"Hello World\");", "}"], { highlight: [2], revealFrom: 2, animate: "type" }) });
add("Spring starts, Hello World appears, and we are ready to build.", { pose: "celebrate", mood: "happy", ...term(["Hello World"]) });

add("Everything works, so now we need a class that actually has some settings.", { pose: "present", mood: "happy" });

// ═══════════════════════ 4 · A class with settings ═══════════════════════
chapter("4 · A class with settings", "office");
add("Create a new class called PaymentGateway.", { pose: "present", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "}"], { animate: "type" }) });
add("Real gateways are many: Razorpay, Paytm, and plenty more.", { pose: "point", ...scene("room", [{ asset: "money", x: 28, y: 52, size: 44, tint: "blue", label: "Razorpay" }, { asset: "money", x: 72, y: 52, size: 44, tint: "green", label: "Paytm" }]) });
add("So the class needs a field for the type of gateway.", { pose: "think", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "  private String type;", "}"], { highlight: [1], revealFrom: 1, animate: "type" }) });
add("And an integer field: how many times to retry a failed payment.", { pose: "present", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "  private String type;", "  private int retryCount;", "}"], { highlight: [2], revealFrom: 2, animate: "type" }) });
add("Generate the getters and setters for both fields.", { pose: "idle", ...code("PaymentGateway.java", "java", ["public class PaymentGateway {", "  private String type;", "  private int retryCount;", "  public String getType() { return type; }", "  public void setType(String type) { this.type = type; }", "  // getRetryCount and setRetryCount too", "}"], { highlight: [3, 4], revealFrom: 3 }) });
add("Right now this is just a plain Java object, a POJO.", { pose: "shrug" });
add("Add the Component annotation, so Spring scans and manages it.", { pose: "point", mood: "happy", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  // fields, getters and setters", "}"], { highlight: [0], animate: "type" }) });
add("Back in DemoApplication, we need a variable to hold the context.", { pose: "think", ...code("DemoApplication.java", "java", MAIN_CTX, { highlight: [1, 2], animate: "type" }) });
add("It is not a good way, but we will improve it very soon.", { pose: "smug", mood: "smug" });
add("Fetch the PaymentGateway bean from the context, then set the type to Paytm.", { pose: "present", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  PaymentGateway pg =", "    context.getBean(PaymentGateway.class);", "  pg.setType(\"Paytm\");"], { highlight: [3, 4, 5], revealFrom: 3, animate: "type" }) });
add("Set the retry count to five, and print both values.", { pose: "point", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  PaymentGateway pg =", "    context.getBean(PaymentGateway.class);", "  pg.setType(\"Paytm\");", "  pg.setRetryCount(5);", "  System.out.println(pg.getType());", "  System.out.println(pg.getRetryCount());"], { highlight: [6, 7, 8], revealFrom: 6, animate: "type" }) });
add("It prints Paytm and five. Basic setting and getting.", { pose: "celebrate", mood: "happy", ...term(["Paytm", "5"]) });
add("Now imagine the live application needs Razorpay instead of Paytm.", { pose: "worried", mood: "worried", ...scene("night", [{ asset: "money", x: 28, y: 52, size: 44, tint: "green", label: "Paytm" }, { asset: "money", x: 72, y: 52, size: 44, tint: "blue", label: "Razorpay" }], [{ from: [42, 52], to: [58, 52] }]) });
add("You would edit the Java code, recompile, merge, and push again.", { pose: "facepalm", mood: "sad", ...steps(["Edit the Java code", "Recompile", "Merge and push", "Redeploy"], 3) });
add("What if the values came from outside, and a config change was enough?", { pose: "think", mood: "confused", ...flow(["Config file", "Spring Boot", "Your Java code"], 2, "values") });

// ═══════════════════════ 5 · Configuration files ═══════════════════════
chapter("5 · Configuration files", "server");
add("That is exactly what application.properties gives us.", { pose: "present", mood: "happy", ...code("application.properties", "properties", PROPS_BASE, { highlight: [0] }) });
add("Notice it is a non-Java file: there is no dot java at the end.", { pose: "point", ...scene("lab", [{ asset: "document", x: 30, y: 52, size: 46, label: "application.properties" }, { asset: "cross", x: 72, y: 52, size: 36, label: "not .java" }]) });
add("Inside, you see a key, an equals sign, and a value.", { pose: "point", ...code("application.properties", "properties", PROPS_BASE, { highlight: [0] }) });
add("Just like a map: every key has exactly one value.", { pose: "present", ...table_("properties", ["key", "value"], [["type", "Paytm"], ["retry-count", "5"]]) });
add("We call this a configuration file.", { pose: "smug" });
add("Java has many configuration files, not only this one.", { pose: "present" });
add("Careful: this is not the Configuration annotation you put on a Java class.", { pose: "point", mood: "worried", callouts: ["NOT @CONFIGURATION"] });
add("That annotation lives on Java classes that define beans with Bean methods.", { pose: "present", ...code("AppConfig.java", "java", ["@Configuration", "public class AppConfig {", "  @Bean", "  public PaymentGateway gateway() {", "    return new PaymentGateway();", "  }", "}"], { highlight: [0, 2], animate: "type" }) });
add("Properties files are different: they are non-Java files.", { pose: "point" });
add("They are special, because they supply values from outside your code.", { pose: "present", mood: "excited", ...flow(["application.properties", "Spring Boot", "Your Java code"], 2, "values") });
add("Change the file, and your Java code sees the new value.", { pose: "smug", ...flow(["application.properties", "Spring Boot", "Your Java code"], 2, "Razorpay") });
add("No hard-coded values, and no recompiling just to change a setting.", { pose: "celebrate", mood: "happy", ...scene("lab", [{ asset: "check", x: 50, y: 52, size: 54, label: "Configurable" }]) });
add("Spring Boot loads this file automatically whenever the application starts.", { pose: "present", ...scene("lab", [{ asset: "document", x: 28, y: 52, size: 44, label: "properties file" }, { asset: "robot", x: 72, y: 52, size: 44, label: "Spring Boot" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Spring Initializr offered two formats: dot properties, or YAML.", { pose: "point", ...code("application.yml", "yaml", ["spring:", "  application:", "    name: demo"], { highlight: [2], animate: "type" }) });
add("Properties is the most common and the default one.", { pose: "smug" });
add("But values can come from several other places too.", { pose: "think", ...steps(["application.properties", "application.yml", "Environment variables", "Command-line arguments", "System properties"], 0) });
add("Spring Boot gives us two files itself: properties and YAML.", { pose: "present", ...steps(["application.properties", "application.yml", "Environment variables", "Command-line arguments", "System properties"], 1) });
add("Then environment variables, command-line arguments, and system properties.", { pose: "point", ...steps(["application.properties", "application.yml", "Environment variables", "Command-line arguments", "System properties"], 4) });
add("All of them live outside your Java code, and provide real values to it.", { pose: "present" });
add("So how does Java code ask for these values? Let us see.", { pose: "think", mood: "confused", props: [{ type: "question" }] });

// ═══════════════════════ 6 · The Value annotation ═══════════════════════
chapter("6 · The Value annotation", "office");
add("Add two keys to application.properties, in the same style.", { pose: "present", ...code("application.properties", "properties", PROPS_VALUE, { highlight: [1, 2], revealFrom: 1, animate: "type" }) });
add("The prefix is payment.gateway, then type, equals Paytm.", { pose: "point", ...code("application.properties", "properties", PROPS_VALUE, { highlight: [1] }) });
add("Next key: payment.gateway.retry-count, equals five.", { pose: "point", ...code("application.properties", "properties", PROPS_VALUE, { highlight: [2] }) });
add("We have key value pairs. How do we read them in Java?", { pose: "think", mood: "confused" });
add("Spring gives us a special annotation called Value.", { pose: "present", mood: "excited", callouts: ["@VALUE"] });
add("Let us use it through the constructor first.", { pose: "idle", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  private String type;", "  private int retryCount;", "  public PaymentGateway(String type, int retryCount) {", "    this.type = type;", "    this.retryCount = retryCount;", "  }", "}"], { highlight: [4], revealFrom: 4, animate: "type" }) });
add("Before the type parameter, write Value with a dollar sign and curly braces.", { pose: "point", ...code("PaymentGateway.java", "java", ["public PaymentGateway(", "  @Value(\"${payment.gateway.type}\")", "  String type,", "  int retryCount) {", "  this.type = type;", "  this.retryCount = retryCount;", "}"], { highlight: [1], animate: "type" }) });
add("Inside the braces goes the property name: payment.gateway.type.", { pose: "present", ...code("PaymentGateway.java", "java", ["public PaymentGateway(", "  @Value(\"${payment.gateway.type}\")", "  String type,", "  int retryCount) {", "  this.type = type;", "  this.retryCount = retryCount;", "}"], { highlight: [1] }) });
add("Do the same for the retry count parameter.", { pose: "point", ...code("PaymentGateway.java", "java", ["public PaymentGateway(", "  @Value(\"${payment.gateway.type}\")", "  String type,", "  @Value(\"${payment.gateway.retry-count}\")", "  int retryCount) {", "  this.type = type;", "  this.retryCount = retryCount;", "}"], { highlight: [3], revealFrom: 3, animate: "type" }) });
add("Now Spring supplies both values. The constructor needs nothing else.", { pose: "smug", mood: "happy" });
add("In main, comment out the setters, and print the getters.", { pose: "idle", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  PaymentGateway pg =", "    context.getBean(PaymentGateway.class);", "  // pg.setType(\"Paytm\");", "  // pg.setRetryCount(5);", "  System.out.println(pg.getType());", "  System.out.println(pg.getRetryCount());"], { highlight: [6, 7], revealFrom: 6 }) });
add("Run it. An error appears, and it is a syntax mistake.", { pose: "shocked", mood: "shocked", ...alert("error", "UnsatisfiedDependencyException", "NumberFormatException: cannot convert text to int") });
add("I wrote round brackets instead of curly braces. A classic typo.", { pose: "facepalm", mood: "sad", ...code("PaymentGateway.java", "java", ["@Value(\"$(payment.gateway.retry-count)\")", "int retryCount"], { highlight: [0] }) });
add("Fix it: a dollar sign, then curly braces around the key.", { pose: "point", mood: "happy", ...code("PaymentGateway.java", "java", ["@Value(\"${payment.gateway.retry-count}\")", "int retryCount"], { highlight: [0], animate: "type" }) });
add("Run again. The warning is gone, and the output is right.", { pose: "celebrate", mood: "happy", ...term(["Paytm", "5"]) });
add("The values came from the properties file, not from Java code.", { pose: "present", ...flow(["application.properties", "@Value", "PaymentGateway"], 2, "Paytm") });
add("You do not need a constructor. Value also works directly on fields.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  @Value(\"${payment.gateway.type}\")", "  private String type;", "  @Value(\"${payment.gateway.retry-count}\")", "  private int retryCount;", "}"], { highlight: [2, 4], animate: "type" }) });
add("Just like Autowired, you can annotate the field itself.", { pose: "present" });
add("Remove the constructor, run again, and the result is identical.", { pose: "smug", ...term(["Paytm", "5"]) });
add("Underneath, this behaves like dependency injection, with values as the dependency.", { pose: "think", ...flow(["PaymentGateway", "@Value", "Properties file"], 2, "values") });
add("Spring Boot sees the file on the classpath, and maps each key.", { pose: "present" });
add("What happens if the key does not exist at all?", { pose: "think", mood: "worried" });
add("Spring cannot create the bean, because nothing provides the value.", { pose: "shocked", mood: "shocked", ...alert("error", "BeanCreationException", "Could not resolve placeholder 'payment.gateway.type'") });
add("Look closely at that error: it complains about autowiring a dependency.", { pose: "point", ...alert("error", "BeanCreationException", "Injection of autowired dependencies failed") });
add("So Value really is injection, just for simple values like strings and numbers.", { pose: "present", mood: "excited" });
add("Use Autowired for other beans, and use Value for simple values from outside.", { pose: "point", ...compare("versus", [{ title: "Autowired", points: ["Injects beans", "Like OrderService"] }, { title: "Value", points: ["Injects simple values", "String, int, boolean"] }]) });
add("Fix that with a default value, written after a colon.", { pose: "point", mood: "happy", ...code("PaymentGateway.java", "java", ["@Value(\"${payment.gateway.type:Razorpay}\")", "private String type;"], { highlight: [0], animate: "type" }) });
add("If the key is missing, the default Razorpay is used.", { pose: "present", ...scene("room", [{ asset: "warning", x: 28, y: 52, size: 44, tint: "gold", label: "Key missing" }, { asset: "money", x: 72, y: 52, size: 44, tint: "blue", label: "Razorpay" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Pause and think. The key exists in the file. What happens?", { pose: "think", mood: "confused", ...quiz("The key exists in the file. Which value is used?", ["The file value", "The default value", "An error"], 0) });
add("The file value wins. The default is only a safety net.", { pose: "smug", mood: "happy" });
add("Run it to prove it, and Paytm is printed.", { pose: "celebrate", ...term(["Paytm"]) });
add("Give the retry count a default of three as well.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Value(\"${payment.gateway.retry-count:3}\")", "private int retryCount;"], { highlight: [0], animate: "type" }) });
add("Defaults work on fields, constructors, and setters alike.", { pose: "present" });
add("Value can read from properties, YAML, and environment variables too.", { pose: "present" });
add("We will see those later. Today we focus on the properties file.", { pose: "smug" });

// ═══════════════════════ 7 · ConfigurationProperties ═══════════════════════
chapter("7 · ConfigurationProperties", "classroom");
add("Now imagine a class with many settings, not just two.", { pose: "think", ...scene("lab", [{ asset: "document", x: 17, y: 52, size: 40, label: "type" }, { asset: "document", x: 50, y: 52, size: 40, label: "timeout" }, { asset: "document", x: 83, y: 52, size: 40, label: "enabled" }]) });
add("Enabled or disabled, timeouts, and more, all in one place.", { pose: "present" });
add("Writing Value on every single field gets confusing and error-prone.", { pose: "shrug", mood: "worried" });
add("You could map the wrong value to the wrong variable.", { pose: "facepalm", mood: "sad" });
add("Real configuration files hold dozens of properties. There must be a better way.", { pose: "think", mood: "confused" });
add("There is. Spring Boot gives us ConfigurationProperties.", { pose: "present", mood: "excited", ...code("PaymentProperties.java", "java", ["@ConfigurationProperties(", "  prefix = \"payment-property\")"], { highlight: [0], animate: "type" }) });
add("In enterprise projects you will often see a class that picks its values from a non-Java file.", { pose: "present", ...scene("room", [{ asset: "document", x: 28, y: 52, size: 42, label: "properties file" }, { asset: "city", x: 72, y: 52, size: 42, label: "Enterprise app" }], [{ from: [42, 52], to: [58, 52] }]) });
add("It collects the settings in one place, and the rest of the code just uses it.", { pose: "smug" });
add("Put it on a class, and that class maps itself to the file.", { pose: "point", ...flow(["application.properties", "@ConfigurationProperties", "Java class"], 2, "keys") });
add("Create a new class named PaymentProperties.", { pose: "present", ...code("PaymentProperties.java", "java", ["public class PaymentProperties {", "}"], { animate: "type" }) });
add("Add Component, so Spring manages it.", { pose: "point", ...code("PaymentProperties.java", "java", ["@Component", "public class PaymentProperties {", "}"], { highlight: [0], animate: "type" }) });
add("Then add ConfigurationProperties, with a prefix inside the brackets.", { pose: "point", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(prefix = \"paymentProperty\")", "public class PaymentProperties {", "}"], { highlight: [1], revealFrom: 1, animate: "type" }) });
add("The prefix tells Spring which keys in the file belong to this class.", { pose: "present" });
add("Our first prefix is written in camel case, and Spring objects.", { pose: "shocked", mood: "shocked", ...alert("error", "Invalid prefix", "Prefix must be in canonical form") });
add("Canonical form means lower case words, separated by hyphens.", { pose: "point", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(prefix = \"payment-property\")", "public class PaymentProperties {", "}"], { highlight: [1], animate: "type" }) });
add("Now add four fields: type, retry count, enabled, and timeout.", { pose: "present", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(prefix = \"payment-property\")", "public class PaymentProperties {", "  private String type;", "  private int retryCount;", "  private boolean enabled;", "  private int timeout;", "}"], { highlight: [3, 4, 5, 6], revealFrom: 3, animate: "type" }) });
add("Enabled is a boolean, and timeout is an integer in milliseconds.", { pose: "point" });
add("Generate getters and setters for all four fields.", { pose: "idle", ...code("PaymentProperties.java", "java", ["@Component", "@ConfigurationProperties(prefix = \"payment-property\")", "public class PaymentProperties {", "  private String type;", "  private int retryCount;", "  private boolean enabled;", "  private int timeout;", "  // getters and setters for all four", "}"], { highlight: [7], revealFrom: 7 }) });
add("Now give every field a value in application.properties.", { pose: "present", ...code("application.properties", "properties", PROPS_ALL, { highlight: [3, 4, 5, 6], revealFrom: 3, animate: "type" }) });
add("Every key starts with the prefix: payment-property.", { pose: "point", ...code("application.properties", "properties", PROPS_ALL, { highlight: [3] }) });
add("Type is Paytm, and the retry count is five.", { pose: "present", ...code("application.properties", "properties", PROPS_ALL, { highlight: [3, 4] }) });
add("Enabled is true, and the timeout is three thousand.", { pose: "present", ...code("application.properties", "properties", PROPS_ALL, { highlight: [5, 6] }) });
add("Notice retry-count is written with a hyphen. This is called kebab case.", { pose: "point", ...code("application.properties", "properties", PROPS_ALL, { highlight: [4] }) });
add("In Java we write retryCount in camel case, as usual.", { pose: "present", ...compare("beforeAfter", [{ title: "properties file", points: ["retry-count"] }, { title: "Java field", points: ["retryCount"] }]) });
add("Spring Boot is flexible: it converts the hyphenated key into the camel case field.", { pose: "smug", mood: "happy", ...flow(["retry-count", "Spring Boot", "retryCount"], 2, "mapped") });
add("So each file keeps its own convention, and the mapping just works.", { pose: "celebrate", mood: "happy" });
add("Boolean fields have one more rule: the getter is named isEnabled.", { pose: "point", ...code("PaymentProperties.java", "java", ["  private boolean enabled;", "  public boolean isEnabled() {", "    return enabled;", "  }"], { highlight: [1], animate: "type" }) });
add("That is the Java convention, so regenerate the getter and setter.", { pose: "idle" });
add("The warnings are gone. PaymentProperties now reads all four values itself.", { pose: "celebrate", mood: "happy", ...scene("lab", [{ asset: "document", x: 28, y: 52, size: 42, label: "properties" }, { asset: "check", x: 72, y: 52, size: 42, label: "Bound" }], [{ from: [42, 52], to: [58, 52] }]) });

const MISTAKES = ["Round brackets instead of curly braces", "Camel case in the prefix", "Missing key and no default value", "Boolean getter not named isEnabled"];
add("Before we continue, four mistakes we just made, and you will make them too.", { pose: "present", mood: "happy", ...steps(MISTAKES, 0) });
add("One: round brackets instead of curly braces in the Value annotation.", { pose: "point", ...steps(MISTAKES, 0) });
add("Two: a camel case prefix, when Spring wants lower case with hyphens.", { pose: "point", ...steps(MISTAKES, 1) });
add("Three: a missing key with no default, which stops the bean from being created.", { pose: "point", ...steps(MISTAKES, 2) });
add("Four: a boolean getter that is not named isEnabled.", { pose: "point", ...code("PaymentProperties.java", "java", ["// wrong", "public boolean getEnabled() { ... }", "// right", "public boolean isEnabled() { ... }"], { highlight: [3], animate: "type" }) });
add("Errors are friendly teachers. Read them, fix them, and move on.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 8 · Injecting the properties ═══════════════════════
chapter("8 · Injecting the properties", "office");
add("Now PaymentGateway should use these values, but not read the file directly.", { pose: "think" });
add("The standard pattern: a properties class reads the file, and other classes depend on it.", { pose: "present", ...flow(["application.properties", "PaymentProperties", "PaymentGateway"], 2, "values") });
add("So PaymentGateway receives PaymentProperties through constructor injection.", { pose: "point", ...code("PaymentGateway.java", "java", ["public PaymentGateway(PaymentProperties p) {", "  this.p = p;", "}"], { highlight: [0], animate: "type" }) });
add("Remove the Value fields and the old constructor.", { pose: "idle", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "}"], { highlight: [1] }) });
add("Add a field for PaymentProperties, and a constructor that takes it.", { pose: "point", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  private final PaymentProperties p;", "  public PaymentGateway(PaymentProperties p) {", "    this.p = p;", "  }", "}"], { highlight: [2, 3, 4], revealFrom: 2, animate: "type" }) });
add("No Autowired needed: constructor injection happens automatically.", { pose: "smug", mood: "happy" });
add("Add getters that simply delegate to the properties object.", { pose: "present", ...code("PaymentGateway.java", "java", ["@Component", "public class PaymentGateway {", "  private final PaymentProperties p;", "  public PaymentGateway(PaymentProperties p) {", "    this.p = p;", "  }", "  public String getType() { return p.getType(); }", "  public int getTimeout() { return p.getTimeout(); }", "  // retry count and enabled work the same way", "}"], { highlight: [6, 7], revealFrom: 6, animate: "type" }) });
add("Then add a print method that prints all four values.", { pose: "point", ...code("PaymentGateway.java", "java", ["  public void print() {", "    System.out.println(getType());", "    System.out.println(getRetryCount());", "    System.out.println(isEnabled());", "    System.out.println(getTimeout());", "  }"], { highlight: [1, 2, 3, 4], animate: "type" }) });
add("Now DemoApplication only has to call print on the gateway bean.", { pose: "present", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  PaymentGateway pg =", "    context.getBean(PaymentGateway.class);", "  pg.print();"], { highlight: [5], revealFrom: 5, animate: "type" }) });
add("Run it, and all four values print: Paytm, five, true, three thousand.", { pose: "celebrate", mood: "excited", ...term(["Paytm", "5", "true", "3000"]) });
add("Spring Boot read the file, filled PaymentProperties, and injected it into the gateway.", { pose: "present", ...flow(["Properties file", "PaymentProperties", "PaymentGateway"], 2, "Paytm") });
add("Why not read the properties class directly everywhere?", { pose: "think", mood: "confused" });
add("Because the standard pattern is to depend on a normal service class.", { pose: "point" });
add("The properties class only reads. The gateway holds the business logic.", { pose: "present", ...compare("versus", [{ title: "PaymentProperties", points: ["Reads the file", "Holds the values"] }, { title: "PaymentGateway", points: ["Business logic", "Uses the values"], winner: true }]) });
add("Follow this same pattern, and it will serve you in every project.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 9 · Running code at startup ═══════════════════════
chapter("9 · Running code at startup", "server");
add("Now the second topic: starting code without touching the container.", { pose: "present", mood: "excited" });
add("Today, main fetches a bean from the context, and then calls its method.", { pose: "point", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  PaymentGateway pg =", "    context.getBean(PaymentGateway.class);", "  pg.print();"], { highlight: [3, 4, 5] }) });
add("That means we talk to the IoC container directly.", { pose: "worried", mood: "worried", ...code("DemoApplication.java", "java", [...MAIN_CTX, "  PaymentGateway pg =", "    context.getBean(PaymentGateway.class);"], { highlight: [1, 2, 4] }) });
add("We do not want that. We want to just run the application.", { pose: "point" });
add("In a web application, an endpoint would trigger the method.", { pose: "present", ...flow(["Browser", "/print endpoint", "print()"], 2, "GET /print") });
add("In a web app, you would map print to a URL, such as slash print.", { pose: "present", ...browser("localhost:8080/print", "page", ["print() runs when", "this URL is opened"], "Web application") });
add("Here there is no web server, only a console application.", { pose: "shrug" });
add("We want print to run the moment the application starts.", { pose: "point" });
add("Spring Boot has a special interface for exactly this: ApplicationRunner.", { pose: "present", mood: "excited", ...code("ApplicationRunner.java", "java", ["public interface ApplicationRunner {", "  void run(ApplicationArguments args)", "      throws Exception;", "}"], { highlight: [1], animate: "type" }) });
add("Create a class called DemoRunner, add Component, and implement ApplicationRunner.", { pose: "point", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner", "    implements ApplicationRunner {", "}"], { highlight: [1, 2], animate: "type" }) });
add("The interface has one method, run, and we override it.", { pose: "present", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner", "    implements ApplicationRunner {", "  @Override", "  public void run(ApplicationArguments args) {", "  }", "}"], { highlight: [4], revealFrom: 3, animate: "type" }) });
add("It has only one method, which makes it a functional interface.", { pose: "present" });
add("ApplicationArguments holds the command-line arguments you start the app with.", { pose: "present", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner", "    implements ApplicationRunner {", "  @Override", "  public void run(ApplicationArguments args) {", "  }", "}"], { highlight: [4] }) });
add("A main method receives arguments in the same way.", { pose: "point" });
add("We will not use them today.", { pose: "shrug" });
add("DemoRunner needs the PaymentGateway, so inject it through the constructor.", { pose: "point", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner", "    implements ApplicationRunner {", "  private final PaymentGateway gateway;", "  public DemoRunner(PaymentGateway gateway) {", "    this.gateway = gateway;", "  }", "  @Override", "  public void run(ApplicationArguments args) {", "  }", "}"], { highlight: [3, 4, 5], revealFrom: 3, animate: "type" }) });
add("Inside run, simply call print on the gateway.", { pose: "present", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner", "    implements ApplicationRunner {", "  private final PaymentGateway gateway;", "  public DemoRunner(PaymentGateway gateway) {", "    this.gateway = gateway;", "  }", "  @Override", "  public void run(ApplicationArguments args) {", "    gateway.print();", "  }", "}"], { highlight: [9], revealFrom: 9, animate: "type" }) });
add("Now main can be a single line. Remove all the context code.", { pose: "smug", mood: "happy", ...code("DemoApplication.java", "java", ["@SpringBootApplication", "public class DemoApplication {", "  public static void main(String[] args) {", "    SpringApplication.run(DemoApplication.class, args);", "  }", "}"], { highlight: [3] }) });
add("No context variable, no bean fetching, and no print call.", { pose: "celebrate", mood: "happy" });
add("Run it. The runner fires on its own, and all four values print.", { pose: "celebrate", mood: "excited", ...term(["Paytm", "5", "true", "3000"]) });
add("Spring Boot calls run once the application context is ready.", { pose: "present", ...flow(["Start app", "Context ready", "run() called"], 2, "startup") });
add("There is a second, very similar interface: CommandLineRunner.", { pose: "point", ...code("CommandLineRunner.java", "java", ["public interface CommandLineRunner {", "  void run(String... args)", "      throws Exception;", "}"], { highlight: [1], animate: "type" }) });
add("Switch DemoRunner to implement CommandLineRunner instead.", { pose: "present", ...code("DemoRunner.java", "java", ["@Component", "public class DemoRunner", "    implements CommandLineRunner {", "  private final PaymentGateway gateway;", "  // constructor as before", "  @Override", "  public void run(String... args) {", "    gateway.print();", "  }", "}"], { highlight: [2, 6], animate: "type" }) });
add("Same method name, but the arguments arrive as plain strings.", { pose: "point", ...code("DemoRunner.java", "java", ["  @Override", "  public void run(String... args) {", "    gateway.print();", "  }"], { highlight: [1] }) });
add("Those three dots mean zero, one, or many arguments.", { pose: "present" });
add("We still ignore them, and only call print.", { pose: "shrug" });
add("Run it again, and the output is exactly the same.", { pose: "celebrate", ...term(["Paytm", "5", "true", "3000"]) });
add("Pause and think. Both runners ran our code. How do they differ?", { pose: "think", mood: "confused", ...quiz("How do the two runners differ?", ["Argument type", "Startup order", "One needs Component"], 0) });
add("ApplicationRunner gets a parsed arguments object. CommandLineRunner gets raw strings.", { pose: "present", mood: "happy", ...compare("versus", [{ title: "ApplicationRunner", points: ["run(ApplicationArguments)", "Parsed arguments"] }, { title: "CommandLineRunner", points: ["run(String... args)", "Raw strings"] }]) });
add("For a console application, either one works. Pick the one you prefer.", { pose: "smug" });

// ═══════════════════════ 10 · Run it from the terminal ═══════════════════════
chapter("10 · Run it from the terminal", "server");
add("You can also run the application without the green button.", { pose: "present" });
add("Open a terminal in the project folder, and use Maven.", { pose: "point", ...term(["$ cd demo"]) });
add("Type mvn space spring-boot colon run.", { pose: "present", ...term(["$ mvn spring-boot:run"]) });
add("The app starts, our runner fires, and all four values appear.", { pose: "celebrate", mood: "excited", ...term(["$ mvn spring-boot:run", "Paytm", "5", "true", "3000", "[INFO] BUILD SUCCESS"]) });
add("If Maven is missing, install it first, and then repeat the command.", { pose: "shrug" });

// ═══════════════════════ 11 · Recap and your task ═══════════════════════
chapter("11 · Recap and your task", "stage");
const RECAP = ["application.properties holds external values", "@Value injects one value", "@ConfigurationProperties binds many", "Prefix in kebab-case, fields in camelCase", "Runners start your code automatically"];
add("Let us recap with five key ideas.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: application.properties keeps your settings outside the Java code.", { pose: "point", ...steps(RECAP, 0) });
add("Two: Value injects a single property, with an optional default.", { pose: "point", ...steps(RECAP, 1) });
add("Three: ConfigurationProperties binds a whole group of keys to one class.", { pose: "point", ...steps(RECAP, 2) });
add("Four: the prefix is kebab case, and Spring maps it to camel case fields.", { pose: "point", ...steps(RECAP, 3) });
add("Five: ApplicationRunner and CommandLineRunner run your code at startup.", { pose: "point", ...steps(RECAP, 4) });
const TASK = ["Add payment-property.currency to the file", "Add a field and getter for it", "Print it from a runner"];
add("Now a challenge for you, without looking back at the code.", { pose: "smug", mood: "excited", ...steps(TASK, 0) });
add("Add a currency property to the file, and bind it in PaymentProperties.", { pose: "point", ...steps(TASK, 1) });
add("Then print it from a runner, and run it with Maven.", { pose: "present", ...steps(TASK, 2) });
add("As a bonus, try an invalid prefix, and read the error carefully.", { pose: "think", mood: "confused", ...alert("warning", "Try this", "Break the prefix on purpose, then read the message") });
add("In the next video, we start the Spring Boot web application.", { pose: "present", mood: "excited", ...scene("sky", [{ asset: "globe", x: 30, y: 52, size: 46, label: "Web app" }, { asset: "rocket", x: 70, y: 52, size: 46, label: "CRUD" }], [{ from: [44, 52], to: [56, 52] }]) });
add("We will build a full CRUD application, and it will be very practical.", { pose: "celebrate", mood: "excited" });
add("Thanks for watching, and see you in the next lesson.", { pose: "celebrate", mood: "happy" });

// small table helper (declared after use is fine for function declarations)
function table_(name, columns, rows) { return { table: { name, columns, rows } }; }

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "Spring Boot application.properties, @Value, @ConfigurationProperties & Runners | Spring Boot Full Course #10",
  description:
    "Stop hard-coding settings in Java. In this Spring Boot lesson you will learn how application.properties works, how to inject single values with @Value (including defaults), " +
    "how to bind a whole group of keys to a class with @ConfigurationProperties, and how to run code at startup with ApplicationRunner and CommandLineRunner.\n\n" +
    "Chapters: 1 The problem | 2 Where we are | 3 Project setup | 4 A class with settings | 5 Configuration files | 6 The Value annotation | 7 ConfigurationProperties | 8 Injecting the properties | 9 Running code at startup | 10 Run it from the terminal | 11 Recap and your task\n\n" +
    "#SpringBoot #Java #CodeOrCap",
  tags: ["Spring Boot", "application.properties", "@Value", "ConfigurationProperties", "ApplicationRunner", "CommandLineRunner", "Spring Boot tutorial", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "spring-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
