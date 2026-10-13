// Chapter 4: profile files and spring.profiles.active; chapter 5: command line and environment variables.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const FILES = ["application.properties", "application-dev.properties", "application-staging.properties", "application-prod.properties"];
const COMMON = ["spring.application.name=profile-demo", "app.welcome.message=Local: Hello, welcome", "app.welcome.code=200", "app.welcome.users=Aditya, Rohit, Rohan, Sohan"];
const COMMON_ACTIVE = [...COMMON, "spring.profiles.active=dev"];
const TBL_COLS = ["Environment", "Port", "Message"];
const TBL_ROWS = [["default", "8080", "Local"], ["dev", "9090", "Dev"], ["staging", "8080", "Staging"], ["prod", "8191", "Prod"]];

module.exports = () => {
  // ═══════════════ 4 · Profiles ═══════════════
  chapter("4 · Profiles: one file per environment", "office");
  add("Now to the real question. How do we show a different message, and use a different port, in each environment?", { pose: "present", mood: "excited" });
  add("In Spring Boot this idea is called profiling. And the idea is simple.", { pose: "point" });
  add("Do not keep one properties file. Keep several, one for each environment.", { pose: "present", ...steps(FILES, 0) });
  add("The main file stays application dot properties. It holds what is the same everywhere.", { pose: "point", ...steps(FILES, 0) });
  add("For the others, Spring Boot allows a name like application, a hyphen, the profile name, dot properties.", { pose: "present", ...steps(FILES, 1) });
  add("So we make one for dev, one for staging, and one for prod. Companies may use more, like test or pre prod.", { pose: "point", ...steps(FILES, 3) });
  add("Now we split the settings. In the main file we keep only what never changes: the application name, the code, and the list of users.", { pose: "present", ...snap("application.properties", "properties", COMMON, { highlight: [0, 2, 3] }) });
  add("The port and the message change, so we move them. Dev runs on ninety ninety, with the message Dev.", { pose: "point", ttsText: "The port and the message change, so we move them. Dev runs on ninety ninety, with the message Dev.", ...snap("application-dev.properties", "properties", ["server.port=9090", "app.welcome.message=Dev: Hello, welcome"], { highlight: [0, 1] }) });
  add("Staging runs on eighty eighty, with the message Staging.", { pose: "present", ttsText: "Staging runs on eighty eighty, with the message Staging.", ...snap("application-staging.properties", "properties", ["server.port=8080", "app.welcome.message=Staging: Hello, welcome"], { highlight: [0, 1] }) });
  add("And production runs on eighty one ninety one, with the message Prod.", { pose: "point", ttsText: "And production runs on eighty one ninety one, with the message Prod.", ...snap("application-prod.properties", "properties", ["server.port=8191", "app.welcome.message=Prod: Hello, welcome"], { highlight: [0, 1] }) });
  add("The main file has no port at all. So by default the app runs on the Tomcat default, eighty eighty, and says Local.", { pose: "present", ttsText: "The main file has no port at all. So by default the app runs on the Tomcat default, eighty eighty, and says Local.", ...table("Configuration per environment", TBL_COLS, TBL_ROWS, 0) });
  add("But how do we tell Spring Boot which file to pick? There is one key for that: spring dot profiles dot active.", { pose: "point", mood: "excited", ...snap("application.properties", "properties", COMMON_ACTIVE, { highlight: [4] }) });
  add("If we write dev there, Spring Boot reads two files. The main file, and application dev dot properties.", { pose: "present", ...flow(["Main file", "Dev file", "Final configuration"], 2, "success") });
  add("It always reads two: the common file, and the one for the active profile. Profile values win when a key is in both.", { pose: "point", mood: "happy" });
  add("Run it. The log says Tomcat started on port ninety ninety, and the message says Dev.", { pose: "present", ttsText: "Run it. The log says Tomcat started on port ninety ninety, and the message says Dev.", ...term(["The following 1 profile is active: \"dev\"", "Tomcat started on port 9090"], "Console") });
  add("Change the active profile to staging, and restart. Now the port is eighty eighty, and the message says Staging.", { pose: "point", ttsText: "Change the active profile to staging, and restart. Now the port is eighty eighty, and the message says Staging.", ...browser("GET :8080/api/demo/greet", "json", ["Staging: Hello, welcome : 200"]) });
  add("So profiles work. But look closely. Is the problem really solved?", { pose: "think", mood: "confused" });
  add("The file is inside the jar, so to switch environment we still edit it. Then commit, push, and deploy.", { pose: "present", mood: "worried" });
  add("It is the same trouble as hard coding. We still change a file before each deploy.", { pose: "point", mood: "angry", ...alert("warning", "Still editing a file", "spring.profiles.active changes per deploy") });
  add("What we want is someone from outside, who gives the configuration to the jar when it starts.", { pose: "present", mood: "excited", props: [{ type: "bulb" }] });
  add("Notice that application dot properties is an internal file. It is packed into the jar. So it is not external configuration.", { pose: "point" });

  // ═══════════════ 5 · External configuration ═══════════════
  chapter("5 · External configuration", "classroom");
  add("External configuration is what you give to the jar from outside it. There are many ways. Two are very common.", { pose: "present", ...steps(["Command line", "Environment variables"], 0) });
  add("The first is the command line. The second is environment variables.", { pose: "point", ...steps(["Command line", "Environment variables"], 0) });
  add("Environment variables are also key and value pairs. They do not belong to your app.", { pose: "present", ...steps(["Command line", "Environment variables"], 1) });
  add("They can come from the operating system, from a C I C D pipeline, from Kubernetes, or from the server you deploy on.", { pose: "point", ttsText: "They can come from the operating system, from a C I C D pipeline, from Kubernetes, or from the server you deploy on." });
  add("When we study deployment, we will set them for real. For now, let us focus on the command line.", { pose: "present" });
  add("With Maven the command is mvn spring boot run. With no extra input, Spring Boot says: no active profile set, using default.", { pose: "point", ...term(["$ mvn spring-boot:run", "No active profile set, falling back to default profiles: default"], "Terminal") });
  add("Then it reads application dot properties alone, so we get port eighty eighty, and the message says Local.", { pose: "present", ttsText: "Then it reads application dot properties alone, so we get port eighty eighty, and the message says Local.", ...browser("GET :8080/api/demo/greet", "json", ["Local: Hello, welcome : 200"]) });
  add("To choose a profile from outside, we add a flag: the property spring boot dot run dot profiles, with the name of the profile.", { pose: "point", ttsText: "To choose a profile from outside, we add a flag: the property spring boot dot run dot profiles, with the name of the profile.", ...term(["$ mvn spring-boot:run -Dspring-boot.run.profiles=prod"], "Terminal") });
  add("We pass prod. The log shows the prod profile is active, and the app is on port eighty one ninety one.", { pose: "present", ttsText: "We pass prod. The log shows the prod profile is active, and the app is on port eighty one ninety one.", ...term(["The following 1 profile is active: \"prod\"", "Tomcat started on port 8191"], "Terminal") });
  add("Call it on that port, and the message starts with Prod. The code, and the users, come from the main file.", { pose: "point", mood: "happy", ttsText: "Call it on that port, and the message starts with Prod. The code, and the users, come from the main file.", ...browser("GET :8191/api/demo/greet", "json", ["Prod: Hello, welcome : 200"]) });
  add("Only the port and the message changed. Everything common stayed in the main file.", { pose: "present", mood: "excited" });
  add("And now we did not edit any file. The same jar runs in dev, staging, or prod, just by changing one flag.", { pose: "smug", mood: "happy", ...compare("versus", [{ title: "Before", points: ["Edit spring.profiles.active", "Commit, push, deploy"] }, { title: "Now", points: ["Same jar everywhere", "Choose the profile at start"] }]) });
  add("In real life you do not run Maven on the server. You build a jar, and you run the jar with java dash jar.", { pose: "present", ...term(["$ mvn clean package", "$ java -jar target/profile-demo.jar"], "Terminal") });
  add("To choose the profile for a jar, add dash dash spring dot profiles dot active equals prod after its name.", { pose: "point", ttsText: "To choose the profile for a jar, add dash dash spring dot profiles dot active equals prod after its name.", ...term(["$ java -jar app.jar --spring.profiles.active=prod"], "Terminal") });
  add("The environment variable version is spring underscore profiles underscore active. Spring Boot understands that spelling too.", { pose: "present", ttsText: "The environment variable version is spring underscore profiles underscore active, in capital letters. Spring Boot understands that spelling too.", ...term(["$ export SPRING_PROFILES_ACTIVE=prod", "$ java -jar target/profile-demo.jar"], "Terminal") });
  add("Your server, your pipeline, or your container sets that variable for you. And your code does not change at all.", { pose: "point", mood: "happy", ...snap("DemoController.java", "java", ["@Value(\"${app.welcome.message}\")", "private String message;", "// unchanged in every environment"], { highlight: [0, 1] }) });
  add("You can also activate more than one profile. Write the names with commas between them.", { pose: "present", ...term(["$ java -jar app.jar --spring.profiles.active=prod,metrics"], "Terminal") });
  add("Now, an important question. What if the same key is set in several places? Spring Boot has a clear order.", { pose: "point", mood: "confused" });
  add("The command line wins over everything. Then come environment variables. Then the file of the active profile. And last, the main file.", { pose: "present", ...steps(["Command line", "Environment variables", "Profile file", "Main file"], 0) });
  add("So the main file is your default, and the outside world always has the last word. That is exactly what we want.", { pose: "point", mood: "excited", ...steps(["Command line", "Environment variables", "Profile file", "Main file"], 3) });
  add("This also helps with secrets. A production password should not be written in a file inside the jar, or in Git.", { pose: "present", mood: "worried", props: [{ type: "lock" }] });
  add("Instead, the file says: take the password from a variable. And the real value is set on the server, outside of Git.", { pose: "point", ...snap("application-prod.properties", "properties", ["spring.datasource.password=${DB_PASSWORD}"], { highlight: [0] }) });
  add("Now the repository holds no secret, and each environment gives its own value. This is how teams really work.", { pose: "present", mood: "happy" });
  add("The same idea works for the database. The URL, the username, and the password differ for local, dev, staging, and prod.", { pose: "present" });
  add("You keep each set in its own profile file, or give it from outside. The code never changes.", { pose: "point", mood: "happy" });
  ask("A key is in the main file, the prod file, and on the command line. Which wins?", ["The main file", "The prod file", "The command line", "The last one in the log"], 2,
    "It has the highest priority. Then environment variables, then the profile file, then the main file.");
  ask("You start the jar with the profile prod. Which configuration files does Spring Boot read?", ["Only application-prod.properties", "Only application.properties", "application.properties and application-prod.properties", "All the property files"], 2,
    "It always reads the common file, and then the file of the active profile. Values in the profile file override the common ones.");
};
