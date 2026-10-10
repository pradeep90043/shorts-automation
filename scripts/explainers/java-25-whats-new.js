// Generates the plan-only JSON for the 10-minute English explainer: "Java 25 (LTS): What's New and Should You Upgrade?"
// Research (2026-10-10): openjdk.org/projects/jdk/25 and the JEP pages (506, 502, 505, 507, 510, 511, 512, 513, 514, 515, 519,
// 520, 521, 483), docs.spring.io Spring Boot 4.0 system requirements, Oracle support roadmap summaries.
// Every number and flag below is quoted from those pages; benchmark numbers are labelled as the JEP's own measurements.
//   node java-25-whats-new.js out.json
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
const term = (lines, title = "Terminal") => ({ terminal: { title, lines } });
const flow = (nodes, active, packet) => ({ flow: { nodes, active, packet } });
const steps = (items, current) => ({ steps: { items, current } });
const scene = (background, items, arrows = []) => ({ scene: { background, items, arrows } });
const quiz = (question, options, answer, revealAt = 0.65) => ({ quiz: { question, options, answer, revealAt } });
const alert = (kind, title, detail) => ({ alert: { kind, title, detail } });
const compare = (mode, cards) => ({ compare: { mode, cards } });
const table = (name, columns, rows, highlightRow) => ({ table: { name, columns, rows, highlightRow } });
const counter = (items) => ({ counter: { items } });

const lastCode = {};
function snap(title, language, lines, o = {}) {
  const prev = lastCode[title] || [];
  let k = 0;
  while (k < prev.length && k < lines.length && prev[k] === lines[k]) k++;
  lastCode[title] = lines;
  return code(title, language, lines, { revealFrom: Math.min(k, lines.length - 1), animate: "type", ...o });
}

const AGENDA = ["Why Java 25 matters", "Language features", "Concurrency", "Speed and memory", "Tools and security", "Should you upgrade?"];

// ═══════════════════════ 1 · Hook ═══════════════════════
chapter("1 · Java 25", "stage");
add("Java 25 is the new long-term support release, and it is packed with changes you can use today.", { pose: "present", mood: "excited", ...steps(AGENDA, 0) });
add("It shipped on September 16, 2025, with eighteen changes, called JEPs.", { pose: "point", ...counter([{ value: 18, label: "JEPS IN JAVA 25" }]) });
add("Twelve are final features, and six are still preview, incubator, or experimental.", { pose: "present", ...compare("versus", [{ title: "Final", points: ["12 JEPs", "Safe for production"] }, { title: "Not final", points: ["6 JEPs", "Preview, incubator", "or experimental"] }]) });
add("Final means ready for production. Preview means the feature works, but its design may still change.", { pose: "point", ...steps(["Final: production ready", "Preview: may still change", "Incubator: separate module", "Experimental: use with care"], 1) });
add("Preview features need a flag to run, so you always opt in on purpose.", { pose: "smug", mood: "happy" });
add("In ten minutes, we cover what matters, with real code, and whether you should upgrade.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 2 · Why it matters ═══════════════════════
chapter("2 · Why it matters", "office");
add("Java releases twice a year, but only some releases get long-term support.", { pose: "present", ...table("Recent LTS releases", ["version", "kind"], [["Java 17", "LTS"], ["Java 21", "LTS"], ["Java 25", "LTS"]], 2) });
add("Java 25 is the first LTS since Java 21, so it is the version many teams will move to.", { pose: "point" });
add("Oracle lists premier support for Java 25 through September 2030.", { pose: "present", ...alert("success", "Premier support to September 2030", "Oracle support roadmap for Java 25") });
add("Newer releases exist too: Java 26 arrived in March 2026, and Java 27 in September.", { pose: "think", ...table("Releases since", ["release", "date"], [["Java 26", "March 2026"], ["Java 27", "Sept 2026"]], 0) });
add("But those are regular six-month releases. Java 25 is still the one to plan around.", { pose: "smug", mood: "happy" });
add("Using Spring? Spring Boot 4.0 needs at least Java 17, and is documented to run up to Java 25.", { pose: "point", ...alert("success", "Spring Boot 4.0 + Java 25", "Minimum Java 17, compatible through Java 25") });

// ═══════════════════════ 3 · Language features ═══════════════════════
chapter("3 · Language features", "classroom");
add("Start with the language. Hello World has always needed a class, a public static main, and a string array.", { pose: "present", ...snap("HelloWorld.java", "java", ["public class HelloWorld {", "  public static void main(String[] args) {", "    System.out.println(\"Hello, World!\");", "  }", "}"]) });
add("Compact source files, now final, shrink it to a single method.", { pose: "point", mood: "excited", ...snap("HelloWorld.java", "java", ["void main() {", "  IO.println(\"Hello, World!\");", "}"], { highlight: [0, 1] }) });
add("Main no longer needs public, static, or arguments, and the class is implied.", { pose: "present", ...steps(["No public static", "No String[] args", "No class declaration", "IO.println replaces System.out"], 2) });
add("Behind the scenes, the compiler wraps your code in an implicit class, and imports java base for you.", { pose: "point", ...flow(["Your methods", "Implicit class", "java.base imported"], 2, "implied") });
add("IO is a new class in java dot lang, with print, println, and readln for reading input.", { pose: "point", ...snap("Greeter.java", "java", ["void main() {", "  String name = IO.readln(\"Your name: \");", "  IO.print(\"Pleased to meet you, \");", "  IO.println(name);", "}"], { highlight: [1] }) });
add("Run it directly with java and the file name. No separate compile step.", { pose: "smug", ...term(["$ java Greeter.java", "Your name: Aditya", "Pleased to meet you, Aditya"]) });
add("It is meant for beginners and quick scripts, and it is the same Java, not a separate dialect.", { pose: "smug", mood: "happy" });
add("Next, module import declarations. One line imports everything a module exports.", { pose: "present", ...snap("Imports.java", "java", ["import module java.base;", "", "void main() {", "  var m = Stream.of(\"a\", \"b\")", "    .collect(Collectors.toMap(s -> s, String::length));", "}"], { highlight: [0] }) });
add("No more long lists of imports for List, Map, Stream, and Collectors.", { pose: "point", mood: "happy" });
add("If two packages share a class name, using that name fails to compile, and you add one explicit import.", { pose: "think", ...alert("warning", "Name clash", "java.util.List vs java.awt.List: add a single-type import") });
add("Third, flexible constructor bodies. Code may now run before the call to super.", { pose: "present", ...snap("Employee.java", "java", ["Employee(String name, int age, String officeID) {", "  if (age < 18 || age > 67)", "    throw new IllegalArgumentException();", "  this.officeID = officeID;", "  super(name, age);", "}"], { highlight: [1, 2, 3] }) });
add("Validate the arguments first, fail fast, and even assign fields declared in this class.", { pose: "point" });
add("The rule: that early code cannot read the object under construction.", { pose: "think", mood: "worried", ...alert("warning", "Prologue limits", "No this, no instance methods, no reading fields") });
add("Records and enums keep their own constructor rules, so check them before you rely on this.", { pose: "shrug" });
add("A preview worth watching: primitive types in patterns, in its third preview.", { pose: "present", ...snap("Status.java", "java", ["String msg = switch (status) {", "  case 0 -> \"okay\";", "  case 1 -> \"warning\";", "  case int i when i < 0 -> \"invalid: \" + i;", "  case int i -> \"unknown: \" + i;", "};"], { highlight: [3, 4] }) });
add("It also lets you switch over long, float, double, and boolean. It needs the preview flag.", { pose: "point", ...term(["$ java --enable-preview --source 25 Status.java"]) });

// ═══════════════════════ 4 · Concurrency ═══════════════════════
chapter("4 · Concurrency", "office");
add("Virtual threads arrived in Java 21. Java 25 finishes the tools around them.", { pose: "present", ...steps(["Virtual threads (Java 21)", "Scoped values (final)", "Structured concurrency (preview)", "Stable values (preview)"], 1) });
add("Scoped values, now final, replace thread locals for sharing data safely.", { pose: "point", mood: "excited" });
add("Thread locals can be changed from anywhere, can leak, and are costly to copy into child threads.", { pose: "present", ...compare("versus", [{ title: "ThreadLocal", points: ["Mutable anywhere", "Can leak", "Copied to children"] }, { title: "ScopedValue", points: ["Set once", "Bounded lifetime", "Shared cheaply"] }]) });
add("You bind a value for the duration of a call, and any method inside can read it.", { pose: "point", ...snap("Request.java", "java", ["static final ScopedValue<String> USER =", "    ScopedValue.newInstance();", "", "ScopedValue.where(USER, \"alice\")", "    .run(() -> handleRequest());", "", "void handleRequest() {", "  IO.println(USER.get()); // alice", "}"], { highlight: [3, 4, 7] }) });
add("When the call ends, the binding is gone. Reading it outside throws an exception.", { pose: "smug" });
add("A callee can bind the same value again, and the earlier one returns when that inner scope ends.", { pose: "present", ...snap("Nested.java", "java", ["ScopedValue.where(USER, \"alice\").run(() -> {", "  IO.println(USER.get());        // alice", "  ScopedValue.where(USER, \"bob\")", "      .run(() -> IO.println(USER.get())); // bob", "  IO.println(USER.get());        // alice", "});"], { highlight: [2, 3, 4] }) });
add("Child threads started by structured concurrency inherit the value without copying it.", { pose: "point", mood: "happy" });
add("Structured concurrency, in its fifth preview, treats subtasks as one unit of work.", { pose: "present", ...snap("Handler.java", "java", ["Response handle() throws InterruptedException {", "  try (var scope = StructuredTaskScope.open()) {", "    var user  = scope.fork(() -> findUser());", "    var order = scope.fork(() -> fetchOrder());", "    scope.join();", "    return new Response(user.get(), order.get());", "  }", "}"], { highlight: [1, 4] }) });
add("If one subtask fails, the other is cancelled, and nothing is left running in the background.", { pose: "point", mood: "happy" });
add("The scope opens with a factory method, and a joiner can change the policy, like first success wins.", { pose: "present", ...steps(["open(): wait for all, fail on one", "open(Joiner): choose a policy", "fork() returns a Subtask", "join() before get()"], 1) });
add("This API changed again, so treat it as preview, and use the enable preview flag.", { pose: "think", mood: "worried", ...alert("warning", "Preview API", "Run with --enable-preview; the API may change") });
add("Also in preview: stable values, for lazy values that are set once, and then act like final.", { pose: "present", ...snap("OrderController.java", "java", ["private final Supplier<Logger> logger =", "  StableValue.supplier(", "    () -> Logger.create(OrderController.class));", "", "void submit() {", "  logger.get().info(\"order started\");", "}"], { highlight: [1, 2] }) });
add("The logger is created on first use, not when the object is built, and only once.", { pose: "point" });
add("Java 26 kept previewing structured concurrency, a sixth preview, so it is still not final.", { pose: "think", mood: "worried" });

// ═══════════════════════ 5 · Speed and memory ═══════════════════════
chapter("5 · Speed and memory", "stage");
add("Now the changes that make existing applications cheaper to run. First, compact object headers.", { pose: "present", ...steps(["Compact object headers", "Generational Shenandoah", "Faster startup with AOT cache"], 0) });
add("Every Java object carries a header. Compact headers make it smaller, so the heap holds more.", { pose: "point" });
add("The JEP quotes a benchmark, SPECjbb2015: twenty two percent less heap, and eight percent less CPU time.", { pose: "present", ...counter([{ value: 22, suffix: "%", label: "LESS HEAP (JEP, SPECJBB)" }, { value: 8, suffix: "%", label: "LESS CPU TIME (JEP)" }]) });
add("Those are benchmark figures for one setting, so measure your own application.", { pose: "think", mood: "worried" });
add("It is now a product feature. Turn it on with one flag. It is not the default yet.", { pose: "point", ...term(["$ java -XX:+UseCompactObjectHeaders -jar app.jar"]) });
add("Amazon ran it in hundreds of production services, mostly on older Java versions.", { pose: "smug", mood: "happy" });
add("The JEP also cites about fifteen percent fewer garbage collections in one test, and about ten percent faster JSON parsing.", { pose: "present", ...table("Quoted in JEP 519", ["test", "result"], [["SPECjbb2015", "22% less heap"], ["SPECjbb2015", "8% less CPU"], ["SPECjbb2015", "15% fewer GCs"], ["JSON parser", "about 10% faster"]], 2) });
add("Second, generational Shenandoah, a low-pause garbage collector, is now a product feature.", { pose: "present", ...term(["$ java -XX:+UseShenandoahGC \\", "    -XX:ShenandoahGCMode=generational -jar app.jar"]) });
add("The JEP gives no speedup figure here, so test it on your own workload.", { pose: "shrug" });
add("Third, startup. An ahead-of-time cache stores loaded classes from a training run.", { pose: "present", ...flow(["Training run", "AOT cache file", "Faster startup"], 1, "classes") });
add("In Java 24, building the cache took three steps: record, create, and run.", { pose: "point", ...term(["$ java -XX:AOTMode=record -XX:AOTConfiguration=app.aotconf -cp app.jar App", "$ java -XX:AOTMode=create -XX:AOTConfiguration=app.aotconf \\", "    -XX:AOTCache=app.aot -cp app.jar", "$ java -XX:AOTCache=app.aot -cp app.jar App"]) });
add("The earlier JEP, in Java 24, measured Spring PetClinic starting forty two percent faster.", { pose: "point", ...counter([{ value: 42, suffix: "%", label: "FASTER STARTUP (PETCLINIC)" }]) });
add("Java 25 makes the cache easier. One command now runs the training and builds the cache.", { pose: "present", ...term(["$ java -XX:AOTCacheOutput=app.aot -cp app.jar App", "$ java -XX:AOTCache=app.aot -cp app.jar App"]) });
add("One catch: the one-step version needs as much memory again to build the cache, so use the two steps on small machines.", { pose: "think", mood: "worried", ...alert("warning", "Memory caveat", "One-step creation needs about double the heap") });
add("And ahead-of-time method profiles let the compiler optimize hot methods sooner.", { pose: "point", ...counter([{ value: 90, suffix: " ms", label: "WITHOUT PROFILES" }, { value: 73, suffix: " ms", label: "WITH PROFILES" }]) });
add("That is the JEP's small example, about nineteen percent faster. Real apps will differ.", { pose: "think", mood: "worried" });

// ═══════════════════════ 6 · Tools and security ═══════════════════════
chapter("6 · Tools and security", "office");
add("Flight Recorder gets three upgrades: method timing and tracing, CPU-time profiling, and cooperative sampling.", { pose: "present", ...steps(["Method timing and tracing", "CPU-time profiling (experimental)", "Cooperative sampling"], 0) });
add("Method timing records exact counts and durations, with no agent and no source changes.", { pose: "point", ...code("JFR option", "text", ["-XX:StartFlightRecording:", "  jdk.MethodTiming#filter=", "    java.util.HashMap::resize"], { highlight: [1, 2], animate: "lines" }) });
add("It records exact statistics, not sampled guesses, but it is meant for a few methods at a time.", { pose: "smug" });
add("You view the results with the jfr tool, using the view command for method timing.", { pose: "present", ...term(["$ jfr view method-timing recording.jfr"]) });
add("For security, a new key derivation API, with HKDF, lives in javax dot crypto.", { pose: "present", ...snap("Keys.java", "java", ["KDF hkdf = KDF.getInstance(\"HKDF-SHA256\");", "", "var params = HKDFParameterSpec.ofExtract()", "    .addIKM(initialKeyMaterial)", "    .addSalt(salt)", "    .thenExpand(info, 32);", "", "SecretKey key = hkdf.deriveKey(\"AES\", params);"], { highlight: [0, 7] }) });
add("A key derivation function turns secret material and a salt into new, strong keys.", { pose: "point", ...flow(["Key material + salt", "KDF (HKDF)", "Strong keys"], 1, "derive") });
add("HKDF is the only algorithm in this release, and password-based ones still use the older API.", { pose: "shrug" });
add("Under the hood, the PEM encoding API for keys and certificates is also in preview.", { pose: "point" });
add("And one removal: the 32-bit x86 port is gone from the JDK.", { pose: "think", mood: "worried", ...alert("warning", "Removed", "32-bit x86 port (JEP 503)") });

// ═══════════════════════ 7 · Should you upgrade? ═══════════════════════
chapter("7 · Should you upgrade?", "classroom");
add("So, should you upgrade? If you are on Java 21, the move is smooth for most applications.", { pose: "present", ...steps(["Update the JDK and build tools", "Run your tests", "Trial one flag at a time", "Keep preview features off in production"], 0) });
add("Run your test suite first, and check that your libraries and frameworks support Java 25.", { pose: "point", ...steps(["Update the JDK and build tools", "Run your tests", "Trial one flag at a time", "Keep preview features off in production"], 1) });
add("For Spring, the official documentation says Spring Boot 4.0 runs on Java 17 up to Java 25.", { pose: "present", ...table("Spring Boot 4.0", ["Java version", "status"], [["Java 17", "Minimum"], ["Java 21", "Supported"], ["Java 25", "Supported"]], 2) });
add("Then try compact headers or the AOT cache one at a time, and compare real numbers.", { pose: "smug", ...steps(["Update the JDK and build tools", "Run your tests", "Trial one flag at a time", "Keep preview features off in production"], 2) });
add("Do not ship preview features to production unless you accept that the API may change.", { pose: "think", mood: "worried", ...steps(["Update the JDK and build tools", "Run your tests", "Trial one flag at a time", "Keep preview features off in production"], 3) });
add("Pause and think. Which of these is a preview feature in Java 25?", { pose: "think", ...quiz("Which one is still a preview feature in Java 25?", ["Scoped values", "Structured concurrency", "Compact source files", "Flexible constructor bodies"], 1, 0.7) });
add("Structured concurrency. Scoped values, compact source files, and flexible constructors are final.", { pose: "smug", mood: "happy" });
const RECAP = ["Friendlier language: compact files, imports", "Scoped values final; concurrency preview", "Compact headers, AOT cache: less, faster", "Better JFR and key derivation API", "Test first, adopt step by step"];
add("Let us recap in five points.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: the language is friendlier, from compact files to validating before super.", { pose: "point", ...steps(RECAP, 0) });
add("Two: scoped values are final, while structured concurrency and stable values are preview.", { pose: "point", ...steps(RECAP, 1) });
add("Three: compact headers and the AOT cache can cut memory and startup, so measure them yourself.", { pose: "point", ...steps(RECAP, 2) });
add("Four: Flight Recorder and the key derivation API make tools and security easier.", { pose: "point", ...steps(RECAP, 3) });
add("Five: test first, adopt step by step, and keep previews out of production.", { pose: "point", ...steps(RECAP, 4) });
add("Sources: OpenJDK, the JEP pages, and the Spring Boot documentation. Thanks for watching.", { pose: "celebrate", mood: "happy" });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "Java 25 (LTS): What's New and Should You Upgrade? | Scoped Values, Compact Headers, AOT Cache",
  description:
    "Java 25 became generally available on September 16, 2025, as the first long-term support release since Java 21. It has 18 JEPs: 12 final and 6 preview, incubator or experimental. " +
    "In 10 minutes: compact source files with IO.println, module import declarations, flexible constructor bodies, scoped values, the structured concurrency and stable values previews, " +
    "compact object headers, generational Shenandoah, the ahead-of-time cache improvements (JEP 514, 515), Flight Recorder method timing, the key derivation API, and an upgrade checklist (including Spring Boot 4.0 compatibility).\n\n" +
    "Benchmark figures are quoted from the JEPs (SPECjbb2015 for compact headers, Spring PetClinic for JEP 483, a small stream program for JEP 515) and will differ for your application. Preview features need --enable-preview and may change.\n\n" +
    "Sources: openjdk.org/projects/jdk/25 and openjdk.org/jeps (483, 502, 505, 506, 507, 510, 511, 512, 513, 514, 515, 519, 520, 521); Spring Boot 4.0 system requirements (docs.spring.io); Oracle Java SE support roadmap.\n\n#Java25 #Java #JDK25 #CodeOrCap",
  tags: ["Java 25", "JDK 25", "Java LTS", "scoped values", "compact object headers", "structured concurrency", "Project Leyden", "Java new features", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "java25-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
