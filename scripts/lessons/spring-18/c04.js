// Chapter 6: the Profile annotation (a different bean per environment); chapter 7: recap.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const IFACE = ["public interface NotificationService {", "  String send();", "}"];
const REAL_1 = ["@Service", "public class NotificationServiceImpl", "    implements NotificationService {", "  public String send() {", "    return \"Here is a notification\";", "  }", "}"];
const DUMMY_1 = ["@Service", "public class DummyNotificationServiceImpl", "    implements NotificationService {", "  public String send() {", "    return \"Here is a dummy notification\";", "  }", "}"];
const DUMMY_2 = ["@Service", "@Profile(\"dev\")", "public class DummyNotificationServiceImpl", "    implements NotificationService {", "  // sends nothing real", "}"];
const REAL_2 = ["@Service", "@Profile(\"prod\")", "public class NotificationServiceImpl", "    implements NotificationService {", "  // sends the real notification", "}"];
const DUMMY_3 = ["@Service", "@Profile({\"dev\", \"default\", \"staging\"})", "public class DummyNotificationServiceImpl", "    implements NotificationService {", "  // sends nothing real", "}"];
const CTRL = ["@RestController", "@RequestMapping(\"/api/notification\")", "public class NotificationController {", "  private final NotificationService service;", "", "  public NotificationController(NotificationService s) {", "    this.service = s;", "  }", "", "  @PostMapping", "  public ResponseEntity<String> sendNotification() {", "    return ResponseEntity.ok(service.send());", "  }", "}"];

module.exports = () => {
  chapter("6 · The Profile annotation", "office");
  add("Configuration values are one thing. But sometimes the behaviour itself must change per environment.", { pose: "present", mood: "excited" });
  add("Take a notification controller. It sends a notification to a user, by email or by S M S. Sending has a cost.", { pose: "point", ttsText: "Take a notification controller. It sends a notification to a user, by email or by S M S. Sending has a cost.", ...snap("NotificationController.java", "java", CTRL, { highlight: [3, 10, 11] }) });
  add("The controller calls a NotificationService, and the service sends the real notification.", { pose: "present", ...flow(["Controller", "NotificationService", "Email / S M S"], 2, "success") });
  add("In production, that is exactly what we want. But think about a dev environment, where a developer is testing a new feature.", { pose: "point", mood: "worried", ...snap("NotificationController.java", "java", CTRL, { highlight: [9, 10, 11] }) });
  add("Each test call would send a real message to a real person. That costs money, and it annoys users.", { pose: "present", mood: "angry", ...alert("error", "Real notification in dev", "A real user gets spammed") });
  add("In dev we want a dummy service. It says the notification was sent, but sends nothing at all.", { pose: "point", mood: "happy" });
  add("So first we turn NotificationService into an interface, with one method, send.", { pose: "present", ...snap("NotificationService.java", "java", IFACE, { highlight: [0, 1] }) });
  add("The real class implements it, and returns: Here is a notification.", { pose: "point", ...snap("NotificationServiceImpl.java", "java", REAL_1, { highlight: [1, 2, 4] }) });
  add("Now we make a second class that also implements the interface. It only returns: Here is a dummy notification.", { pose: "present", ...snap("DummyNotificationServiceImpl.java", "java", DUMMY_1, { highlight: [1, 2, 4] }) });
  add("Run it now, and the app fails to start. Spring finds two beans for one interface, and does not know which to inject.", { pose: "point", mood: "worried", ...alert("error", "Application failed to start", "2 beans of type NotificationService found") });
  add("You may know the Primary and Qualifier annotations. But they pick one bean for all environments.", { pose: "present", mood: "confused" });
  add("We need a different bean in each environment. For that, Spring gives us the Profile annotation.", { pose: "point", mood: "excited", props: [{ type: "bulb" }] });
  add("On the dummy class we write Profile, with the name dev. This bean is created only when dev is active.", { pose: "present", ...snap("DummyNotificationServiceImpl.java", "java", DUMMY_2, { highlight: [1] }) });
  add("On the real class we write Profile prod. The real bean exists only in production.", { pose: "point", ...snap("NotificationServiceImpl.java", "java", REAL_2, { highlight: [1] }) });
  add("Start the app with the dev profile, and call slash api slash notification. The answer says: Here is a dummy notification.", { pose: "present", ttsText: "Start the app with the dev profile, and call slash api slash notification. The answer says: Here is a dummy notification.", ...browser("POST :9090/api/notification", "json", ["Here is a dummy notification"]) });
  add("Start it with prod, and the same call returns: Here is a notification. The real service ran.", { pose: "point", mood: "happy", ...browser("POST :8191/api/notification", "json", ["Here is a notification"]) });
  add("Now the tricky case. Start with no profile at all, so the profile is default. What happens?", { pose: "present", mood: "confused", props: [{ type: "question" }] });
  add("The app fails again. There is no bean of type NotificationService, because neither class matches the default profile.", { pose: "point", mood: "worried", ...alert("error", "No qualifying bean", "NotificationService is not defined for default") });
  add("The fix is easy. The Profile annotation accepts many names. Give the dummy class dev, default, and staging.", { pose: "present", mood: "happy", ...snap("DummyNotificationServiceImpl.java", "java", DUMMY_3, { highlight: [1] }) });
  add("Now only production sends real notifications. Everywhere else, the dummy service answers.", { pose: "point", mood: "excited", ...table("Bean per profile", ["Profile", "Bean"], [["default", "Dummy"], ["dev", "Dummy"], ["staging", "Dummy"], ["prod", "Real"]], 3) });
  add("So there are two tools, and you must not mix them. Profiles in files change the configuration values.", { pose: "present", ...compare("versus", [{ title: "Profile files", points: ["application-dev.properties", "Change configuration values"] }, { title: "Profile annotation", points: ["On a class or a bean", "Change which bean exists"] }]) });
  add("The same works with Yamul files: application dash dev dot yml, and the others. Everything behaves the same way.", { pose: "point", ttsText: "The same works with Yamul files: application dev dot yml, and the others. Everything behaves the same way." });
  ask("A dummy service must be used in dev, and the real one only in prod. What do you use?", ["Two properties files only", "The Value annotation", "The Profile annotation on each bean", "The Primary annotation on both"], 2,
    "The Profile annotation makes Spring create a bean only when its profile is active. Properties files change values, not beans.");

  add("The Profile annotation is not only for classes. You can also put it on a bean method inside a configuration class.", { pose: "present", mood: "excited" });
  add("Say we need a different data source in each environment. Each bean method has its own Profile.", { pose: "point", ...snap("DataSourceConfig.java", "java", ["@Configuration", "public class DataSourceConfig {", "  @Bean @Profile(\"dev\")", "  DataSource devSource() { /* H2, in memory */ }", "", "  @Bean @Profile(\"prod\")", "  DataSource prodSource() { /* real database */ }", "}"], { highlight: [2, 5] }) });
  add("You can also say not. A profile written with an exclamation mark means: every profile except this one.", { pose: "present", ttsText: "You can also say not. A profile written with an exclamation mark means: every profile except this one.", ...snap("DummyNotificationServiceImpl.java", "java", ["@Service", "@Profile(\"!prod\")", "public class DummyNotificationServiceImpl", "    implements NotificationService { }"], { highlight: [1] }) });
  add("That one line covers local, dev, staging, and any new environment you add later. Only prod gets the real service.", { pose: "point", mood: "happy" });
  add("This is safer than listing names. A new environment is dummy by default, and nobody sends real messages by accident.", { pose: "smug", mood: "excited" });
  add("One more tip. If a bean has no Profile annotation at all, it is created in every environment.", { pose: "point" });
  add("So use Profile only where behaviour really must differ, and keep everything else simple.", { pose: "present", mood: "happy" });
  add("And always test your default case. Start the app with no profile, and make sure it still starts.", { pose: "point", mood: "worried" });
  ask("Which annotation line makes a bean exist in every environment except production?", ["Profile with the name prod", "Profile with the name not prod", "Profile with an exclamation mark and prod", "No annotation can do that"], 2,
    "An exclamation mark negates the profile. Profile, not prod, means every profile except prod.");

  chapter("7 · Recap", "stage");
  add("Let us recap. The code is the same in every environment, and the configuration is what changes.", { pose: "present", mood: "happy", ...compare("versus", [{ title: "Code", points: ["Same everywhere"] }, { title: "Configuration", points: ["URL, password, port, message"] }]) });
  add("Never hard code values that change. It means editing code, leaking secrets, and a tightly coupled app.", { pose: "point", mood: "worried" });
  add("Properties and Yamul do the same job. Properties are flat, Yamul is a tree, and if both exist, properties win.", { pose: "present", ...steps(["Properties: flat", "Yamul: tree", "Both: properties win"], 2) });
  add("For many environments, make one file each, like application dash prod dot properties, and keep the common values in the main file.", { pose: "point", ttsText: "For many environments, make one file each, like application prod dot properties, and keep the common values in the main file." });
  add("Choose the profile from outside with the command line or an environment variable, so the same jar runs everywhere.", { pose: "present", mood: "excited" });
  add("And when whole beans must differ, use the Profile annotation.", { pose: "point", mood: "happy" });
  add("This is exactly what happens when we deploy our code to different environments. I hope you enjoyed it.", { pose: "celebrate", mood: "happy" });
  add("That is it for this video. See you in the next one. Thank you so much.", { pose: "celebrate", mood: "excited" });
};
