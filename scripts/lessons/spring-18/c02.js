// Chapter 3: YAML versus properties.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const YML_1 = ["spring:", "  application:", "    name: profile-demo"];
const YML_2 = ["spring:", "  application:", "    name: profile-demo", "server:", "  port: 9090"];
const YML_3 = ["spring:", "  application:", "    name: profile-demo", "server:", "  port: 9090", "app:", "  welcome:", "    message: Hello, welcome to my application", "    code: 200"];
const YML_4 = [...YML_3, "    users: Aditya, Rohit, Rohan, Sohan"];
const PROPS_FLAT = ["spring.application.name=profile-demo", "server.port=9090", "app.welcome.message=Hello, welcome", "app.welcome.code=200"];

module.exports = () => {
  chapter("3 · YAML versus properties", "classroom");
  add("Besides application dot properties, Spring Boot gives us a second format: application dot yml, or Yamul.", { pose: "present", mood: "excited" });
  add("When you create a project on Spring Initializr, you can choose either one. Until today we always chose properties.", { pose: "point", ...compare("versus", [{ title: "application.properties", points: ["Flat key and value", "Dot between the words"] }, { title: "application.yml", points: ["Tree like structure", "Indentation, no dots"] }]) });
  add("Both do the same job. They give configuration to your code. Only the way we write it is different.", { pose: "present", mood: "happy" });
  add("In a properties file, each line is a flat key and a value, with dots between the words of the key.", { pose: "point", ...snap("application.properties", "properties", PROPS_FLAT, { highlight: [2, 3] }) });
  add("Look at the last two lines. They both start with app dot welcome. We repeat it every time.", { pose: "present", mood: "confused" });
  add("Think of it as a tree. App is the root. Welcome is its child. And message and code are the children of welcome.", { pose: "point", ...flow(["app", "welcome", "message / code"], 2, "success") });
  add("That is exactly how Yamul writes it. You write each level on its own line, using indentation.", { pose: "present", mood: "excited" });
  add("Start with spring, then a colon. On the next line, move in a little, and write application, with a colon.", { pose: "point", ...snap("application.yml", "yaml", YML_1, { highlight: [0, 1] }) });
  add("Move in once more, and write name, then the value: profile demo. That is spring dot application dot name.", { pose: "present", ttsText: "Move in once more, and write name, then the value: profile demo. That is spring dot application dot name.", ...snap("application.yml", "yaml", YML_1, { highlight: [2] }) });
  add("The server port is the same idea. Server is the parent. Port is its child, with the value nine zero nine zero.", { pose: "point", ttsText: "The server port is the same idea. Server is the parent. Port is its child, with the value ninety ninety.", ...snap("application.yml", "yaml", YML_2, { highlight: [3, 4] }) });
  add("Now our own keys. App, then welcome, and inside welcome we write message. And code sits next to it, at the same level.", { pose: "present", ...snap("application.yml", "yaml", YML_3, { highlight: [5, 6, 7, 8] }) });
  add("Because welcome is already the parent, we do not repeat app dot welcome. The indentation says it.", { pose: "smug", mood: "happy" });
  add("Same level means same parent. If code needed children of its own, we would move it in one more step.", { pose: "point" });
  add("In the controller we add a code field with the same Value annotation, and return the message and the code together.", { pose: "present", ...snap("DemoController.java", "java", ["@Value(\"${app.welcome.message}\")", "private String message;", "", "@Value(\"${app.welcome.code}\")", "private Integer code;"], { highlight: [3, 4] }) });
  add("Remove the properties file, restart, and call the endpoint. The message and the code both arrive from Yamul.", { pose: "point", mood: "happy", ...browser("GET /api/demo/greet", "json", ["Hello, welcome to my application : 200"]) });
  add("The Value annotation does not change at all. It does not care if the key came from properties or from Yamul.", { pose: "present", mood: "excited" });
  add("Yamul can also hold a list. We write the names separated by commas, and read them into a list of strings.", { pose: "point", ...snap("application.yml", "yaml", YML_4, { highlight: [9] }) });
  add("The Value annotation fills the list, and the console prints Aditya, Rohit, Rohan, and Sohan.", { pose: "present", mood: "happy", ...term(["Aditya, Rohit, Rohan, Sohan"], "Console") });
  add("For big, complicated objects, Spring has the ConfigurationProperties annotation. That is for another day.", { pose: "shrug" });
  add("A few rules will save you time with Yamul. Rule one: indentation is made of spaces, never tabs.", { pose: "present", mood: "worried", ...snap("application.yml", "yaml", ["server:", "  port: 9090", "# two spaces, never a tab"], { highlight: [1] }) });
  add("Rule two: after a colon there must be a space, and then the value. Without the space, it is not a key and value.", { pose: "point", ...compare("versus", [{ title: "Works", points: ["port: 9090"] }, { title: "Broken", points: ["port:9090"] }]) });
  add("Rule three: the number of spaces matters. Two spaces per level is the common style. Keep it the same in the whole file.", { pose: "present" });
  add("Quotes around a value are optional. Writing hello, or writing hello in double quotes, both work.", { pose: "point", mood: "happy" });
  add("Comments start with a hash in both formats, so you can explain a setting, or switch one off for a moment.", { pose: "present", ttsText: "Comments start with a hash sign in both formats, so you can explain a setting, or switch one off for a moment." });
  add("Many teams like Yamul for exactly this reason: it is easier to read when there are many nested settings.", { pose: "smug", mood: "happy" });
  add("But properties files are simple and flat, and they are perfectly fine. There is no wrong choice here.", { pose: "point" });
  add("Whichever you pick, the way we read values in code stays the same. That is the beauty of it.", { pose: "present", mood: "excited" });
  add("Now an important question. What if both files exist in the project?", { pose: "present", mood: "confused", props: [{ type: "question" }] });
  add("Spring Boot reads the properties file and gives it priority. Even Yamul is converted inside into flat keys, just like properties.", { pose: "point", ...compare("versus", [{ title: "Both files exist", points: ["application.properties wins", "yml: only for keys not set there"] }, { title: "Only the yml exists", points: ["It is read", "Tree becomes flat keys inside"] }]) });
  add("So if you want Yamul to win, delete the properties file. Which format you use is your own taste.", { pose: "smug", mood: "happy" });
  ask("In application.yml, which line is written correctly?", ["port:9090", "port: 9090", "port = 9090", "port.9090"], 1,
    "A colon, then a space, then the value. Without the space it is not read as a key and a value.");
  ask("Both application.properties and application.yml set server.port. Which wins?", ["The one from application.yml", "The one from application.properties", "It throws an error", "The larger number"], 1,
    "The properties file has priority. Yamul is only read for keys the properties file does not set.");
};
