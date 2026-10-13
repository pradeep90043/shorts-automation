// Chapters 1-2: same code, different configuration per environment; the demo controller and why hard coding hurts.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const ENVS = ["Local", "Dev", "Staging", "Production"];
const CTRL_HARD = ["@RestController", "@RequestMapping(\"/api/demo\")", "public class DemoController {", "  private String message =", "      \"Hello, welcome to my application\";", "", "  @GetMapping(\"/greet\")", "  public ResponseEntity<String> simpleGreet() {", "    return ResponseEntity.ok(message);", "  }", "}"];
const CTRL_VALUE = ["@RestController", "@RequestMapping(\"/api/demo\")", "public class DemoController {", "  @Value(\"${app.welcome.message}\")", "  private String message;", "", "  @GetMapping(\"/greet\")", "  public ResponseEntity<String> simpleGreet() {", "    return ResponseEntity.ok(message);", "  }", "}"];
const BAD_CODE = ["String dbUrl = \"jdbc:mysql://localhost:3306/shop\";", "String username = \"root\";", "String password = \"root123\";"];

module.exports = () => {
  // ═══════════════ 1 · Same code, different configuration ═══════════════
  chapter("1 · Same code, different configuration", "stage");
  add("Welcome back, coders. Today we talk about configuration and profiles in Spring Boot.", { pose: "present", mood: "excited" });
  add("Sooner or later you build a project and try to deploy it to production. And that is where a big issue shows up.", { pose: "point", mood: "worried", props: [{ type: "rocket" }] });
  add("It is the issue of configuration. Today we will see how Spring Boot solves it with profiles.", { pose: "present", mood: "happy" });
  add("If you have not watched the application dot properties video, watch it first. We will also recap it quickly here.", { pose: "point" });
  add("When you build a Spring Boot app, you take care of two things. The first is the code.", { pose: "present", ...steps(["Code", "Configuration"], 0) });
  add("The code is your controllers, services, and repositories. This is your main logic.", { pose: "point", ...steps(["Code", "Configuration"], 0) });
  add("It does not change from place to place. We trust that the same code runs everywhere.", { pose: "present", mood: "happy" });
  add("It runs on your own laptop, and also on production, where real users use the application.", { pose: "point", ...steps(ENVS, 0) });
  add("Between them there can be a dev environment, where developers test their work.", { pose: "present", ...steps(ENVS, 1) });
  add("And there can be a staging environment, almost a copy of production, where the Q A team checks everything before going live.", { pose: "point", ...steps(ENVS, 2), ttsText: "And there can be a staging environment, almost a copy of production, where the Q A team checks everything before going live." });
  add("Companies name these differently. Some say pre prod, some say Q A. The idea is the same: many environments.", { pose: "shrug", mood: "happy" });
  add("In every environment the main code is the same. So what changes? The configuration.", { pose: "point", mood: "excited", ...compare("versus", [{ title: "Does not change", points: ["Controllers", "Services", "Repositories"] }, { title: "Changes per environment", points: ["Database URL", "Username and password", "Server port"] }]) });
  add("Think about the database. Your local one lives on localhost, port 3306.", { pose: "present", ...code("Configuration", "properties", ["spring.datasource.url=jdbc:mysql://localhost:3306/shop", "spring.datasource.username=root", "spring.datasource.password=root123"]) });
  add("The username may be a simple one, and the password may be root one two three.", { pose: "point", mood: "happy" });
  add("In production the URL is different, and the password is long and complicated. Nobody uses root one two three there.", { pose: "present", mood: "worried", ...alert("warning", "Not the same everywhere", "URL, username and password change") });
  add("The same is true for the port the app runs on, and for any setting you invent yourself.", { pose: "point" });

  add("Let us make this real with a small story. Imagine a shop with branches in many cities.", { pose: "present", mood: "happy" });
  add("The rules of the shop are the same in every branch. But each branch has its own phone number, its own address, and its own cash register password.", { pose: "point", ...compare("versus", [{ title: "Same in every branch", points: ["Shop rules", "How to serve a customer"] }, { title: "Different per branch", points: ["Address", "Phone number", "Register password"] }]) });
  add("Your application is that shop. The code is the rulebook. The configuration is the address and the password of each branch.", { pose: "smug", mood: "happy" });
  add("If you rewrote the rulebook for every branch, you would make mistakes, and the branches would slowly stop matching.", { pose: "point", mood: "worried" });
  add("The better idea is to keep one rulebook, and hand each branch a small card with its own details.", { pose: "present", mood: "excited", props: [{ type: "bulb" }] });
  add("In Spring Boot, that card is the configuration, and giving the right card to the right environment is what we call profiles.", { pose: "point", mood: "happy" });
  add("Remember this picture. We will keep coming back to it: one code base, many small cards.", { pose: "present" });
  add("This is also what makes deployment calm. If the code never changes between environments, then what you tested is what you ship.", { pose: "point", mood: "happy", ...flow(["Code tested in dev", "Same jar in staging", "Same jar in prod"], 2, "success") });

  // ═══════════════ 2 · Why we never hard code it ═══════════════
  chapter("2 · Why we never hard code it", "office");
  add("Let us see the problem in code. Start a new project on Spring Initializr, and name it profile demo.", { pose: "present", ...steps(["Spring Initializr", "Name: profile-demo", "Java 21", "Spring Web"], 1) });
  add("Add only one dependency, Spring Web. We need nothing else.", { pose: "point", ...steps(["Spring Initializr", "Name: profile-demo", "Java 21", "Spring Web"], 3) });
  add("Open it in your IDE. In the resources folder, you will find the application dot properties file.", { pose: "present", ...steps(["pom.xml", "ProfileDemoApplication", "resources/application.properties"], 2) });
  add("Now we make a small experiment. A controller named DemoController, with one method that greets the user.", { pose: "point", ...snap("DemoController.java", "java", CTRL_HARD, { highlight: [2, 6, 7] }) });
  add("We want to return a message. The easy way is to write the message right in the code.", { pose: "present", ...snap("DemoController.java", "java", CTRL_HARD, { highlight: [3, 4] }) });
  add("It works. Run the app, open Postman, call slash api slash demo slash greet, and the message comes back.", { pose: "point", mood: "happy", ...browser("GET /api/demo/greet", "json", ["Hello, welcome to my application"]) });
  add("But think. The first problem: to change this message, you must change the code, again and again.", { pose: "present", mood: "worried" });
  add("The second problem is bigger. In local we want the message to say local. In staging, staging. In production, production.", { pose: "point", ...steps(ENVS, 3), mood: "confused" });
  add("The message is only an example. But the same need exists for every database setting.", { pose: "present" });
  add("Say we wrote the database details straight in the code.", { pose: "point", ...snap("DemoController.java", "java", BAD_CODE, { highlight: [0, 1, 2] }) });
  add("Problem one: every environment needs different values. So you keep commenting and uncommenting lines before each deploy.", { pose: "present", mood: "worried", ...alert("error", "Change code to deploy", "Comment and uncomment by hand") });
  add("Problem two is security. You will push this code to Git, to keep its versions.", { pose: "point", mood: "worried" });
  add("Then your username and your password are leaked, for anyone who can read that repository.", { pose: "present", mood: "angry", props: [{ type: "lock" }], ...alert("error", "Secrets in Git", "Password visible to everyone with access") });
  add("Problem three: the code becomes tightly coupled to the values. To change a single message, you must commit, push, and deploy again.", { pose: "point", mood: "confused" });
  add("So the rule is simple. Do not hard code anything that changes. Let the configuration give it to the code.", { pose: "smug", mood: "happy", props: [{ type: "bulb" }] });
  add("Forget environments for a moment. First, let us take the message out of the code.", { pose: "present" });
  add("In application dot properties, we add a key: app dot welcome dot message, with our message as the value.", { pose: "point", ...snap("application.properties", "properties", ["app.welcome.message=Hello, welcome to my application"], { highlight: [0] }) });
  add("In the controller we read it with the Value annotation: dollar sign, curly brackets, and the key.", { pose: "present", ttsText: "In the controller we read it with the Value annotation: dollar sign, curly brackets, and the key.", ...snap("DemoController.java", "java", CTRL_VALUE, { highlight: [3, 4] }) });
  add("Run the app again, call the same endpoint, and the message comes from the configuration. It works.", { pose: "point", mood: "happy", ...browser("GET /api/demo/greet", "json", ["Hello, welcome to my application"]) });
  add("When the app starts, the configuration becomes available to Spring Boot, and the Value annotation fills the field.", { pose: "present", ...flow(["application.properties", "Spring Boot", "DemoController"], 2, "success") });  add("There is one detail to know. If the key does not exist, the app refuses to start, and tells you it could not resolve the placeholder.", { pose: "point", mood: "worried", ...alert("error", "Could not resolve placeholder", "app.welcome.message is not defined") });
  add("That is a good thing. A missing setting is found at startup, not later, when a real user is waiting.", { pose: "present", mood: "happy" });
  add("If a value is optional, you can give a default after a colon. If the key is missing, the default is used.", { pose: "point", ...snap("DemoController.java", "java", ["@Value(\"${app.welcome.message:Hello}\")", "private String message;"], { highlight: [0] }) });
  add("Keep that in mind. Later, a default will save us when a profile forgets to set a value.", { pose: "present", mood: "happy" });

};
