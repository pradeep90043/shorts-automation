// Generates the plan-only JSON for the 20-minute interactive English tutorial:
// "How Java Web Apps Actually Work: Servlets, Tomcat & WAR Files" (Spring Boot Full Course #14)
// Sources: the lecture transcript (.txt), the course repo (adityatandon15/Spring-Framework-Full-Course, Lecture 14
// ServletCrudDemo), and the Tomcat version table (tomcat.apache.org/whichversion.html: 10.1.x = Servlet 6.0, 11.0.x = 6.1).
// Interactive parts: "pause and think" quizzes and a "spot the bug" round built from real bugs in the repo's UserServlet.
// Two additions beyond the lecture, both labelled in the narration: servlet thread safety, and the Servlet/Tomcat version match.
//   node spring-14-servlets-tomcat.js out.json
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
const browser = (url, kind, lines, heading) => ({ browser: { url, kind, lines, heading } });
const table = (name, columns, rows, highlightRow) => ({ table: { name, columns, rows, highlightRow } });
const two = (bg, a, b) => scene(bg, [{ asset: a[0], x: 28, y: 52, size: 44, label: a[1], tint: a[2] }, { asset: b[0], x: 72, y: 52, size: 44, label: b[1], tint: b[2] }], [{ from: [42, 52], to: [58, 52] }]);

const lastCode = {};
function snap(title, language, lines, o = {}) {
  const prev = lastCode[title] || [];
  let k = 0;
  while (k < prev.length && k < lines.length && prev[k] === lines[k]) k++;
  lastCode[title] = lines;
  return code(title, language, lines, { revealFrom: Math.min(k, lines.length - 1), animate: "type", ...o });
}

const MANUAL = ["Read the raw HTTP text", "Parse URL, method, headers, body", "Pick the right Java method", "Build the HTTP response text", "Add status code and headers", "Serve many users at once (threads)", "Keep the server running"];
const LIFE = ["Constructor", "init()", "service() -> doGet / doPost", "destroy()"];
const POM = ["<packaging>war</packaging>", "", "<dependency>", "  <groupId>jakarta.servlet</groupId>", "  <artifactId>jakarta.servlet-api</artifactId>", "  <version>6.1.0</version>", "  <scope>provided</scope>", "</dependency>", "", "<build>", "  <finalName>crud-app</finalName>", "</build>"];
const SERVLET_1 = ["@WebServlet(\"/users\")", "public class UserServlet extends HttpServlet {", "}"];
const SERVLET_2 = ["@WebServlet(\"/users\")", "public class UserServlet extends HttpServlet {", "  @Override", "  public void doPost(HttpServletRequest request,", "                     HttpServletResponse response) {", "  }", "}"];
const DOGET_A = ["  @Override", "  public void doGet(HttpServletRequest request,", "                    HttpServletResponse response)", "      throws IOException {", "    String idParam = request.getParameter(\"id\");", "    if (idParam == null) {", "      List<User> users = userService.getAllUsers();", "      response.setStatus(200);", "      response.setContentType(\"application/json\");", "      response.getWriter().write(usersToJson(users));", "      return;", "    }", "  }"];

// ═══════════════════════ 1 · Why servlets ═══════════════════════
chapter("1 · Why servlets", "stage");
add("Every Spring Boot web app you have ever written runs on top of a technology from 1997: the servlet.", { pose: "present", mood: "excited", ...steps(["Servlets (the foundation)", "Spring MVC", "Spring Boot"], 0) });
add("Spring MVC is built on servlets, and Spring Boot is built on Spring MVC.", { pose: "point", ...steps(["Servlets (the foundation)", "Spring MVC", "Spring Boot"], 2) });
add("So to understand Spring from the inside, you need to understand servlets and Tomcat.", { pose: "smug", mood: "happy", props: [{ type: "bulb" }] });
add("We will not read boring theory. We will build a small CRUD app with servlets, and deploy it to a real Tomcat.", { pose: "present", mood: "excited", ...steps(["The problem servlets solve", "What Tomcat does", "Build and deploy a WAR", "The servlet lifecycle", "From servlets to Spring MVC"], 0) });
add("This lesson is interactive. When a question appears, pause and answer before the reveal.", { pose: "point", mood: "happy" });

// ═══════════════════════ 2 · The problem ═══════════════════════
chapter("2 · The problem", "classroom");
add("Start with what you already know: a client sends an HTTP request, and a server sends back an HTTP response.", { pose: "present", ...flow(["Client", "Server"], 1, "HTTP request") });
add("The client can be a front end, a mobile app, or Postman. The server is where your Java code runs.", { pose: "point", ...two("room", ["phone", "Client", "blue"], ["server", "Server", "green"]) });
add("Can we build a web app with plain Java, no frameworks? Yes, in principle, using the java dot net package.", { pose: "think", ...code("Server.java", "java", ["ServerSocket server = new ServerSocket(8080);", "Socket client = server.accept();"], { highlight: [0], animate: "type" }) });
add("A server socket can listen on port 8080, and wait for a connection.", { pose: "point", mood: "happy" });
add("Here is the catch. Say a get request for slash hello arrives. What does your Java code receive?", { pose: "think", mood: "confused", ...quiz("A GET /hello request reaches a plain socket. What does your code see?", ["A parsed request object", "A raw stream of bytes", "A servlet", "A JSON body"], 1, 0.7) });
add("Just bytes. The socket knows nothing about methods, URLs, headers, or bodies.", { pose: "present", mood: "worried" });
add("So you must parse the text yourself, to work out the method, the endpoint, the headers, and the body.", { pose: "point", ...steps(MANUAL, 1) });
add("Then you map the endpoint to a method: if the path is slash hello and the method is get, call hello.", { pose: "present", ...code("Manual routing", "java", ["if (endpoint.equals(\"/hello\") &&", "    method.equals(\"GET\")) {", "  hello();", "}"], { highlight: [0, 1, 2], animate: "lines" }) });
add("Then you build the response by hand: the status code, the headers, and the body text.", { pose: "point", ...steps(MANUAL, 4) });
add("And that is for one user. With many clients, you must manage threads, and keep the server running.", { pose: "think", mood: "worried", ...steps(MANUAL, 5) });
add("Count them: about thirteen jobs, and not one line of business logic yet.", { pose: "smug", ...alert("warning", "Server plumbing", "Zero business logic written so far") });
add("In Spring Boot you never do any of this. You just write a mapping and a method.", { pose: "present", mood: "happy" });
add("Developers should focus on business logic. Something else should handle the server work.", { pose: "point", mood: "excited" });

// ═══════════════════════ 3 · The servlet container ═══════════════════════
chapter("3 · The servlet container", "office");
add("That something is a servlet container. Imagine a layer that does all that plumbing for you.", { pose: "present", ...flow(["Client", "Container", "Your Java code"], 1, "plumbing") });
add("It parses the request, extracts headers, body, and parameters, and builds the response.", { pose: "point", ...steps(MANUAL, 1) });
add("The most famous servlet container is Tomcat. People often just call it a server.", { pose: "smug", mood: "happy" });
add("Tomcat is a Java server. It is a long-running process that listens on a port, 8080 by default.", { pose: "present", ...table("Tomcat", ["property", "value"], [["Language", "Java"], ["Runs as", "Long-running process"], ["Default port", "8080"]], 2) });
add("When a request arrives, Tomcat parses it, then calls a method of one of your Java classes.", { pose: "point", ...flow(["Request", "Tomcat", "Your class"], 2, "call") });
add("Those classes are called servlets. A servlet is a special Java class that you write.", { pose: "present", mood: "excited" });
add("Special, because Tomcat creates its objects, manages them, and calls their methods.", { pose: "point" });
add("Imagine two servlets, A and B. A request for slash hello goes to servlet A.", { pose: "present", ...flow(["Tomcat", "Servlet A (/hello)"], 1, "GET /hello") });
add("A request for slash login goes to servlet B. Tomcat keeps the full mapping.", { pose: "point", ...flow(["Tomcat", "Servlet B (/login)"], 1, "GET /login") });
add("Your Java code cannot read raw HTTP text, so Tomcat turns it into two Java objects.", { pose: "think", ...steps(["HttpServletRequest: filled with details", "HttpServletResponse: empty, for you to fill"], 0) });
add("The request object holds the method, the URL, the headers, the body, and the parameters.", { pose: "present", ...code("HttpServletRequest", "text", ["getMethod()", "getRequestURI()", "getHeader(name)", "getParameter(name)"], { animate: "lines" }) });
add("The response object starts empty. You set the status code, the headers, and the body.", { pose: "point", ...code("HttpServletResponse", "text", ["setStatus(200)", "setContentType(\"application/json\")", "getWriter().write(body)"], { animate: "lines" }) });
add("Tomcat passes both objects to your servlet, and the servlet fills in the response.", { pose: "present", ...flow(["Tomcat", "Servlet", "Filled response"], 2, "response") });
add("Question time. Servlet methods return void. So how does the data get back to the client?", { pose: "think", ...quiz("Servlet methods return void. How does the answer reach the client?", ["Return a string", "Fill the response object", "Throw an exception", "Print to the console"], 1, 0.7) });
add("You fill the response object. Because Java passes object references, Tomcat sees the changes.", { pose: "smug", mood: "happy" });
add("Then Tomcat sends that filled response back to the client.", { pose: "present", ...flow(["Servlet", "Tomcat", "Client"], 2, "HTTP response") });
add("Sound familiar? Spring has an IoC container that manages objects called beans.", { pose: "point", ...compare("versus", [{ title: "Spring", points: ["IoC container", "Manages beans"] }, { title: "Tomcat", points: ["Servlet container", "Manages servlets"] }]) });
add("Spring's container idea came from here. Tomcat creates servlets, and destroys them.", { pose: "smug" });
add("One difference: Tomcat does no dependency injection. There is no autowiring in servlets.", { pose: "think", mood: "worried" });

// ═══════════════════════ 4 · Setting up Tomcat and WAR ═══════════════════════
chapter("4 · Tomcat and WAR files", "office");
add("In Spring Boot, Tomcat is embedded: the web starter puts it inside your application.", { pose: "present", ...compare("versus", [{ title: "Embedded Tomcat", points: ["Inside your app", "Spring Boot default"] }, { title: "External Tomcat", points: ["Installed separately", "You deploy to it"] }]) });
add("In the old days, you installed Tomcat separately, and deployed your application into it.", { pose: "point" });
add("What do you deploy? A WAR file, a web archive. It is like a jar, packaged for a servlet container.", { pose: "present", ...steps(["Compiled classes", "Servlet classes", "Config files", "HTML, CSS, JavaScript"], 1) });
add("So we need Tomcat. Download it from the Apache Tomcat site, and unzip it.", { pose: "point", ...term(["$ tar -xzf apache-tomcat-10.1.x.tar.gz", "$ ls apache-tomcat-10.1.x", "bin  conf  lib  logs  temp  webapps  work"]) });
add("The lecture uses Tomcat ten point one. Keep that version family, because of the Servlet API.", { pose: "present", ...table("Tomcat and the Servlet API", ["Tomcat", "Servlet API"], [["9.0.x", "4.0 (javax)"], ["10.1.x", "6.0 (jakarta)"], ["11.0.x", "6.1 (jakarta)"]], 1) });
add("One catch: the course project compiles against Servlet API 6.1, but Tomcat 10.1 implements 6.0.", { pose: "think", mood: "worried", ...alert("warning", "Match the API to Tomcat", "Tomcat 10.1 = Servlet 6.0, Tomcat 11 = Servlet 6.1") });
add("This small app uses only basic servlet features, so it runs. But match them in your own projects.", { pose: "point" });
add("Open the conf folder and server dot xml. The connector says port 8080.", { pose: "present", ...code("conf/server.xml", "xml", ["<Connector port=\"8080\"", "           protocol=\"HTTP/1.1\"", "           connectionTimeout=\"20000\"", "           redirectPort=\"8443\" />"], { highlight: [0] }) });
add("That is the port Tomcat will listen on. Before it starts, the browser cannot reach it.", { pose: "point", ...alert("error", "This site can't be reached", "localhost:8080 - Tomcat is not running yet") });
add("Start it with catalina run. On a Mac, give the scripts permission first.", { pose: "present", ...term(["$ chmod +x bin/*.sh", "$ ./bin/catalina.sh run", "...", "Server startup in [292] milliseconds"]) });
add("The log says the server started. Open localhost 8080, and the Tomcat welcome page appears.", { pose: "celebrate", mood: "happy", ...browser("localhost:8080", "page", ["Apache Tomcat", "If you're seeing this, you've", "successfully installed Tomcat."], "Tomcat is up") });
add("Tomcat is now listening on port 8080, and waiting for requests.", { pose: "smug" });

// ═══════════════════════ 5 · Build the servlet app ═══════════════════════
chapter("5 · Build the app", "office");
add("Now our application. In IntelliJ, create a plain Maven project named servlet crud demo.", { pose: "present", ...steps(["Maven project: servlet-crud-demo", "No Spring, no Spring Boot", "Servlets only"], 1) });
add("In pom dot xml, set the packaging to war, because we want a web archive.", { pose: "point", ...snap("pom.xml", "xml", POM.slice(0, 1), { highlight: [0], animate: "lines" }) });
add("Add the Jakarta Servlet API dependency, version six point one.", { pose: "present", ...snap("pom.xml", "xml", POM.slice(0, 8), { highlight: [2, 3, 4, 5] }) });
add("It has a scope you have not seen: provided.", { pose: "think", ...snap("pom.xml", "xml", POM.slice(0, 8), { highlight: [6], animate: "lines" }) });
add("Provided means: needed to compile, but do not pack it into the WAR, because Tomcat supplies it.", { pose: "point", mood: "happy" });
add("Why? Tomcat already ships these classes. Two copies would confuse it about which to use.", { pose: "smug" });
add("Quick check. What does the provided scope do?", { pose: "think", ...quiz("What does the provided scope do?", ["Packs the jar into the WAR", "Compile only, Tomcat supplies it", "Test only", "Runtime only"], 1, 0.7) });
add("One more setting: final name. Without it, the WAR is named after the artifact and version.", { pose: "present", ...snap("pom.xml", "xml", POM, { highlight: [9, 10, 11] }) });
add("With final name crud app, the file is crud app dot war. That name matters in the URL later.", { pose: "point", mood: "happy" });
add("The app manages users, with an id, a name, an email, and a mobile number.", { pose: "present", ...snap("User.java", "java", ["public class User {", "  private Integer id;", "  private String name;", "  private String email;", "  private String mobile;", "  // constructor, getters and setters", "}"]) });
add("It is a plain Java class. No Spring, so there are no annotations on it.", { pose: "smug" });
add("We skip the database and use an in-memory HashMap. That keeps the focus on servlets.", { pose: "point", ...snap("UserService.java", "java", ["public class UserService {", "  private Map<Integer, User> userDB;", "", "  public UserService() {", "    userDB = new HashMap<>();", "  }", "}"], { highlight: [1, 4] }) });
add("The service creates users, and reads one or all of them from that map.", { pose: "present", ...snap("UserService.java", "java", ["public class UserService {", "  private Map<Integer, User> userDB;", "  public UserService() { userDB = new HashMap<>(); }", "", "  public User createUser(User userReq) {", "    userDB.put(userReq.getId(), userReq);", "    return userReq;", "  }", "}"], { highlight: [4, 5] }) });
add("Now the servlet. It is just a Java class, so what makes it special?", { pose: "think", ...snap("UserServlet.java", "java", ["public class UserServlet {", "}"]) });
add("Two things. It extends HttpServlet, and it tells Tomcat which endpoint it handles.", { pose: "present", ...snap("UserServlet.java", "java", SERVLET_1, { highlight: [0, 1] }) });
add("The Web Servlet annotation maps slash users to this class. That is how Tomcat knows where to send requests.", { pose: "point", ...snap("UserServlet.java", "java", SERVLET_1, { highlight: [0], animate: "lines" }) });
add("Older projects did the same mapping in an XML file called web dot xml. The annotation is simpler.", { pose: "shrug" });
add("HttpServlet is abstract, and gives us methods to override: doGet, doPost, doPut, and doDelete.", { pose: "present", ...snap("UserServlet.java", "java", SERVLET_2, { highlight: [2, 3, 4] }) });
add("Each HTTP method has its own Java method, but the endpoint is shared by the whole class.", { pose: "smug", ...table("One endpoint, many methods", ["HTTP method", "Servlet method"], [["POST", "doPost"], ["GET", "doGet"], ["PUT", "doPut"], ["DELETE", "doDelete"]], 0) });
add("A servlet has a class-level endpoint, never a method-level one, unlike a Spring mapping.", { pose: "point", mood: "happy" });
add("And remember: we never write new UserServlet. Tomcat creates that object.", { pose: "present", mood: "excited" });
add("To send data we use the query string: id, name, email and mobile after the question mark.", { pose: "point", ...browser("POST /crud-app/users?id=1&name=Aditya", "page", ["&email=adi@gmail.com", "&mobile=9876543210"], "Postman") });
add("Why not a JSON body? In Spring, Jackson converts it for you. In servlets you would parse it by hand.", { pose: "think", mood: "worried" });
add("Query parameters are far easier to read in a servlet, so we use them.", { pose: "smug", mood: "happy" });
add("In doPost, read each parameter from the request object. They always arrive as strings.", { pose: "present", ...snap("UserServlet.java", "java", ["  @Override", "  public void doPost(HttpServletRequest request,", "                     HttpServletResponse response)", "      throws IOException {", "    Integer id = Integer.parseInt(request.getParameter(\"id\"));", "    String name = request.getParameter(\"name\");", "    String email = request.getParameter(\"email\");", "    String mobile = request.getParameter(\"mobile\");", "  }"], { highlight: [4, 5, 6, 7] }) });
add("The id is an Integer in our model, so we convert the string with parse int.", { pose: "point", ...snap("UserServlet.java", "java", ["    Integer id = Integer.parseInt(request.getParameter(\"id\"));"], { highlight: [0], animate: "lines" }) });
add("No dependency injection here. The servlet creates its own service, which couples them tightly.", { pose: "think", mood: "worried", ...snap("UserServlet.java", "java", ["public class UserServlet extends HttpServlet {", "  private UserService userService = new UserService();"], { highlight: [1] }) });
add("That tight coupling is one reason people moved to Spring.", { pose: "smug" });
add("Then build the user, save it through the service, and answer with a status code.", { pose: "present", ...snap("UserServlet.java", "java", ["    User user = new User(id, name, email, mobile);", "    userService.createUser(user);", "", "    response.setStatus(201);", "    response.setContentType(\"application/json\");", "    response.getWriter().write(", "      \"{\\\"message\\\": \\\"User Added successfully\\\"}\");"], { highlight: [3, 4, 5, 6] }) });
add("We set the status to two hundred and one, the content type, and write the body ourselves, as a string.", { pose: "point", mood: "happy" });
add("The method returns nothing. The answer lives inside the response object that Tomcat handed us.", { pose: "smug" });

// ═══════════════════════ 6 · doGet and JSON by hand ═══════════════════════
chapter("6 · Reading data", "office");
add("Now doGet. One method handles both read one and read all, because the endpoint is the same.", { pose: "present", ...snap("UserServlet.java", "java", DOGET_A.slice(0, 5), { highlight: [4] }) });
add("If there is no id parameter, the client wants every user.", { pose: "point", ...snap("UserServlet.java", "java", DOGET_A, { highlight: [5, 6, 9, 10] }) });
add("Notice the return. Without it, the method would carry on to the next lines.", { pose: "think", mood: "worried", ...snap("UserServlet.java", "java", DOGET_A, { highlight: [10], animate: "lines" }) });
add("Otherwise, read the id, ask the service for that user, and answer not found if there is none.", { pose: "present", ...snap("UserServlet.java", "java", ["    Integer id = Integer.parseInt(idParam);", "    User user = userService.getUserById(id);", "    if (user == null) {", "      response.setStatus(404);", "      return;", "    }", "    response.setStatus(200);", "    response.setContentType(\"application/json\");", "    response.getWriter().write(userToJson(user));"], { highlight: [2, 3, 4] }) });
add("Spring would convert an object to JSON for you. Here, we must build the JSON text by hand.", { pose: "smug", ...compare("versus", [{ title: "Spring Boot", points: ["return user;", "Jackson makes JSON"] }, { title: "Servlet", points: ["Build the string", "Write it yourself"] }]) });
add("For one user, a method concatenates the fields into a string with braces and quotes.", { pose: "point", ...code("JSON target", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"email\": \"adi@gmail.com\",", "  \"mobile\": \"9876543210\"", "}"], { animate: "lines" }) });
add("For many users, the response is a list in square brackets, with commas between the users.", { pose: "present", ...code("JSON list", "json", ["[", "  { \"id\": 1, \"name\": \"Aditya\" },", "  { \"id\": 2, \"name\": \"Rohit\" }", "]"], { animate: "lines" }) });
add("A string builder appends the open bracket, then each user, and a comma between them.", { pose: "point", ...snap("UserServlet.java", "java", ["private String usersToJson(List<User> users) {", "  StringBuilder sb = new StringBuilder(\"[\");", "  for (int i = 0; i < users.size(); i++) {", "    sb.append(userToJson(users.get(i)));", "    if (i < users.size() - 1) {", "      sb.append(\",\");", "    }", "  }", "  sb.append(\"]\");", "  return sb.toString();", "}"], { highlight: [4, 5] }) });
add("The last user gets no trailing comma, otherwise the JSON would be invalid. That is why it is an indexed loop.", { pose: "smug", mood: "happy" });
add("The service needs the list too. Loop over the map's values, and add each user.", { pose: "present", ...snap("UserService.java", "java", ["public List<User> getAllUsers() {", "  List<User> usersResp = new ArrayList<>();", "  for (User user : userDB.values()) {", "    usersResp.add(user);", "  }", "  return usersResp;", "}"], { highlight: [2, 3] }) });
add("And one lookup method for a single user, which returns null when the id is unknown.", { pose: "point", ...snap("UserService.java", "java", ["public User getUserById(Integer id) {", "  return userDB.getOrDefault(id, null);", "}"], { highlight: [1] }) });

// ═══════════════════════ 7 · Package, deploy, test ═══════════════════════
chapter("7 · Package, deploy, test", "stage");
add("Time to run it. There is no main method to click this time. First, package the project with Maven.", { pose: "present", ...term(["$ mvn package", "...", "BUILD SUCCESS"]) });
add("Maven builds crud app dot war in the target folder.", { pose: "point", ...code("target/", "text", ["target/", "  crud-app.war"], { animate: "lines" }) });
add("Copy that file into Tomcat's webapps folder. That folder holds every application Tomcat runs.", { pose: "present", ...flow(["crud-app.war", "webapps/", "Tomcat"], 1, "deploy") });
add("Tomcat unpacks the WAR into a folder, with web inf, and our compiled classes inside.", { pose: "point", ...code("webapps/crud-app/", "text", ["webapps/crud-app/", "  META-INF/", "  WEB-INF/classes/in/strikes/", "    model/  service/  servlet/"], { animate: "lines" }) });
add("The folder structure matches our packages: model, service, and servlet.", { pose: "smug", mood: "happy" });
add("Restart Tomcat so it loads the new application.", { pose: "present", ...term(["$ ./bin/catalina.sh run", "...", "Deployment of web application archive crud-app.war", "Server startup in [...] milliseconds"]) });
add("Now the URL. It is not just slash users. The WAR name comes first, as the application's path.", { pose: "think", ...browser("localhost:8080/crud-app/users", "page", ["host:port = localhost:8080", "application = /crud-app", "servlet = /users"], "URL anatomy") });
add("One Tomcat can host many applications: crud app, order app, teachers app, each with its own path.", { pose: "point", ...table("webapps/", ["application", "path"], [["crud-app.war", "/crud-app"], ["order-app.war", "/order-app"], ["teachers-app.war", "/teachers-app"]], 0) });
add("Inside an application there can be many servlets, each with its own endpoint, such as users and students.", { pose: "present", ...flow(["Tomcat", "crud-app", "UserServlet (/users)"], 2, "route") });
add("Tomcat reads the URL, picks the application, picks the servlet, and calls the method for the HTTP verb.", { pose: "smug", mood: "happy" });
add("Send a post request with id one and the name Aditya. We get two hundred and one: user added successfully.", { pose: "celebrate", mood: "happy", ...alert("success", "201 Created", "User Added successfully") });
add("Add Rohit with id two. Then read id one, and the full JSON for Aditya comes back.", { pose: "point", ...browser("GET /crud-app/users?id=1", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"email\": \"adi@gmail.com\"", "}"]) });
add("Now read every user, with no id. Something goes wrong: a class cast exception.", { pose: "present", mood: "worried", ...alert("error", "500 ClassCastException", "Casting values() to List failed") });
add("The bug: the map's values method returns a collection, not a list, so the cast fails at runtime.", { pose: "think", ...code("The bug", "java", ["return (List<User>) userDB.values();", "// ClassCastException at runtime"], { highlight: [0], animate: "lines" }) });
add("The fix is the loop we saw: create a real list, and add each user to it.", { pose: "point", mood: "happy" });
add("After the fix: package, copy the new WAR into webapps, and restart Tomcat. Every single time.", { pose: "present", ...steps(["mvn package", "Replace the WAR in webapps", "Restart Tomcat", "Test again"], 3) });
add("Note: the map is in memory, so every restart wipes your users. Add them again.", { pose: "shrug", mood: "worried" });
add("Pause and think. In this setup, what must you do after changing the code?", { pose: "think", ...quiz("In this lesson's setup, what is needed after a code change?", ["Nothing, it reloads itself", "Rebuild, redeploy, restart Tomcat", "Restart only the browser", "Edit server.xml"], 1, 0.7) });
add("A second bug shows up. The read-all path forgot its return, so it kept running, and Tomcat answered 500.", { pose: "point", mood: "worried", ...alert("error", "500 Internal Server Error", "Missing return after the response was written") });
add("Fix it, rebuild, redeploy, restart. Now two hundred OK, and the whole list comes back.", { pose: "celebrate", mood: "happy" });
add("It works. But look at how many steps, and how much manual work, that was.", { pose: "smug" });

// ═══════════════════════ 8 · Lifecycle ═══════════════════════
chapter("8 · The servlet lifecycle", "classroom");
add("Tomcat manages servlets, so a servlet has a lifecycle, just like a Spring bean.", { pose: "present", ...steps(LIFE, 0) });
add("First, Tomcat creates the object, so the constructor runs.", { pose: "point", ...steps(LIFE, 0) });
add("Then init runs once, like post construct in Spring. Use it for expensive setup.", { pose: "present", ...steps(LIFE, 1) });
add("For every request, Tomcat calls service. The parent class decides which do-method to run.", { pose: "point", ...steps(LIFE, 2) });
add("Finally, destroy runs when the servlet is removed, like pre destroy. Use it to close resources.", { pose: "present", ...steps(LIFE, 3) });
add("By default Tomcat creates a servlet lazily, on the first request that needs it.", { pose: "smug", mood: "happy" });
add("What does service do? It looks at the HTTP method, and calls the matching do-method.", { pose: "point", ...code("HttpServlet.service() (simplified)", "java", ["if (method.equals(\"GET\"))    doGet(req, resp);", "else if (method.equals(\"POST\"))   doPost(req, resp);", "else if (method.equals(\"PUT\"))    doPut(req, resp);", "else if (method.equals(\"DELETE\")) doDelete(req, resp);"], { animate: "lines" }) });
add("That is why we override doGet and doPost, and leave service alone.", { pose: "smug" });
add("Let us prove it with a tiny servlet. A hello servlet, mapped to slash hello, prints in each lifecycle method.", { pose: "present", ...snap("HelloServlet.java", "java", ["@WebServlet(\"/hello\")", "public class HelloServlet extends HttpServlet {", "  public HelloServlet() {", "    System.out.println(\"HelloServlet Constructor called\");", "  }", "  @Override", "  public void init() {", "    System.out.println(\"init() method called\");", "  }", "}"], { highlight: [3, 7] }) });
add("Add a doGet that answers with plain text, and a destroy method that prints too.", { pose: "point", ...snap("HelloServlet.java", "java", ["  @Override", "  public void doGet(HttpServletRequest request,", "                    HttpServletResponse response)", "      throws IOException {", "    response.setStatus(200);", "    response.setContentType(\"text/plain\");", "    response.getWriter().write(\"Hello\");", "  }", "  @Override", "  public void destroy() {", "    System.out.println(\"Destroy method called\");", "  }"], { highlight: [4, 5, 6, 10] }) });
add("Package, deploy, restart. Where will the printed lines appear? In IntelliJ?", { pose: "think", mood: "confused", ...alert("warning", "Not in IntelliJ", "Your code runs inside Tomcat, not in IntelliJ") });
add("In the Tomcat terminal, because Tomcat is the one running your code.", { pose: "present" });
add("Send a get request to slash hello. Which order do you expect in the log?", { pose: "think", ...quiz("In which order do these run for the first request?", ["init, constructor, doGet", "constructor, init, doGet", "doGet, constructor, init", "constructor, doGet, init"], 1, 0.7) });
add("Constructor first, then init, and the response is hello.", { pose: "celebrate", mood: "happy", ...term(["HelloServlet Constructor called", "init() method called"], "Tomcat log") });
add("The servlet is created on the first request, not at startup, which proves lazy creation.", { pose: "smug" });
add("How do we see destroy? Stop Tomcat, using the shutdown script, from a second terminal.", { pose: "present", ...term(["$ ./bin/shutdown.sh"]) });
add("As Tomcat shuts down, the log prints: destroy method called.", { pose: "celebrate", mood: "happy", ...term(["Destroy method called"], "Tomcat log") });

// ═══════════════════════ 9 · Spot the bug ═══════════════════════
chapter("9 · Spot the bug", "classroom");
add("Round two. The course repository's user servlet has real bugs. Can you find them before the reveal?", { pose: "present", mood: "excited", ...steps(["Bug 1: a missing id", "Bug 2: a 400 that keeps going", "Bug 3: a 404 that falls through", "Bug 4: invalid JSON"], 0) });
add("Bug one. A client posts without an id. Look at the code.", { pose: "point", ...code("UserServlet.doPost", "java", ["Integer id = Integer.parseInt(", "    request.getParameter(\"id\"));", "// ...", "if (id == null || email == null) {", "  response.setStatus(400);", "}"], { highlight: [0, 1, 3], animate: "lines" }) });
add("Why does this crash instead of answering 400?", { pose: "think", ...quiz("Why does a missing id crash instead of giving a 400?", ["parseInt(null) throws first", "getParameter is private", "Wrong status code", "Missing import"], 0, 0.7) });
add("Parse int throws on null before the null check ever runs. Check the string first, then convert.", { pose: "smug", mood: "happy", ...code("The fix", "java", ["String idParam = request.getParameter(\"id\");", "if (idParam == null || email == null) {", "  response.setStatus(400);", "  return;", "}", "Integer id = Integer.parseInt(idParam);"], { highlight: [1, 3], animate: "lines" }) });
add("Bug two is in that same block. After writing the 400 response, there is no return.", { pose: "point", mood: "worried" });
add("So the servlet carries on, creates the user anyway, and writes a second response.", { pose: "present", ...alert("error", "Bad request still saved", "No return after the 400 response") });
add("Bug three. In doGet, when the user is null, the code sets 404 but does not return.", { pose: "point", ...code("UserServlet.doGet", "java", ["if (userResp == null) {", "  response.setStatus(404);", "}", "response.setStatus(200);", "response.getWriter().write(userToJson(userResp));"], { highlight: [1, 3, 4], animate: "lines" }) });
add("It falls through, and calls userToJson on null. What happens next?", { pose: "think", ...quiz("userToJson(null) runs after the 404. What happens?", ["Returns an empty string", "NullPointerException", "A 404 body", "Nothing"], 1, 0.7) });
add("A null pointer exception, because it calls getId on null. A return after the 404 fixes it.", { pose: "smug", mood: "happy" });
add("Bug four. The JSON builder writes the name and email without quotes around the values.", { pose: "point", ...code("userToJson", "java", ["\"    \\\"name\\\" : \" + user.getName() + \",\\n\" +", "// produces:  \"name\" : Aditya,", "// valid JSON needs \"Aditya\" in quotes"], { highlight: [1, 2], animate: "lines" }) });
add("Strings in JSON need double quotes, so that output is invalid JSON. A real library would never forget.", { pose: "smug" });
add("A bonus, beyond the lecture. Tomcat creates one servlet object, and many requests share it.", { pose: "present", mood: "excited", ...flow(["Request 1", "One UserServlet", "Request 2"], 1, "shared") });
add("So the HashMap inside the service is touched by several threads at once. Is that safe?", { pose: "think", ...quiz("Many requests share one servlet and its HashMap. What is the risk?", ["None, HashMap is thread-safe", "Not thread-safe: data can corrupt", "Requests run one at a time", "Tomcat copies the map"], 1, 0.7) });
add("Not safe. A HashMap is not thread-safe, so a real app needs a concurrent map, or a database.", { pose: "point", mood: "worried" });

// ═══════════════════════ 10 · From servlets to Spring MVC ═══════════════════════
chapter("10 · From servlets to Spring MVC", "stage");
add("Look back. Every servlet repeats the same work: reading input, validating, writing responses.", { pose: "present", ...steps(["Read the request", "Validate", "Route", "Write the response"], 0) });
add("With many servlets, that code is copied everywhere, and each servlet gets complicated.", { pose: "point", mood: "worried" });
add("The idea: add one central servlet in front, so every request goes through it first.", { pose: "present", mood: "excited", ...flow(["Client", "Tomcat", "Central servlet", "Small servlets"], 2, "every request") });
add("The central servlet handles the shared work, then hands each request to the right small servlet.", { pose: "point", ...flow(["Central servlet", "Servlet A", "Servlet B"], 0, "route") });
add("That makes the small servlets light, because they only hold business logic.", { pose: "smug", mood: "happy" });
add("That is exactly the idea of Spring MVC. The central servlet is called the Dispatcher Servlet.", { pose: "celebrate", mood: "excited", ...alert("success", "DispatcherServlet", "Spring MVC's central servlet") });
add("The small servlets are replaced by your controllers, which are just Spring beans.", { pose: "present", ...table("Servlet world vs Spring", ["servlets", "Spring MVC"], [["Many servlets", "One DispatcherServlet"], ["UserServlet", "UserController"], ["doGet, doPost", "GetMapping, PostMapping"], ["Tomcat creates", "Spring creates beans"]], 1) });
add("And Spring Boot? It starts Spring MVC and applies auto-configuration, with an embedded Tomcat.", { pose: "point", ...flow(["Spring Boot", "Spring MVC", "Servlets", "Tomcat"], 1, "builds on") });
add("So the servlet was never ignored. Spring still runs on top of it. We study the Dispatcher Servlet next.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 11 · Recap ═══════════════════════
chapter("11 · Recap and your turn", "stage");
const RECAP = ["Sockets give bytes; Tomcat parses HTTP", "Servlets: classes Tomcat creates and calls", "Request and response objects carry the data", "WAR file: package, deploy, restart", "Lifecycle: constructor, init, service, destroy"];
add("Recap, in five points.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: plain sockets give you bytes, while Tomcat does the HTTP work for you.", { pose: "point", ...steps(RECAP, 0) });
add("Two: a servlet is a Java class that Tomcat creates, and calls, per endpoint.", { pose: "point", ...steps(RECAP, 1) });
add("Three: the request object carries the input, and you fill the response object.", { pose: "point", ...steps(RECAP, 2) });
add("Four: external Tomcat means package a WAR, deploy it, and restart.", { pose: "point", ...steps(RECAP, 3) });
add("Five: a servlet has a lifecycle: constructor, init, service, then destroy.", { pose: "point", ...steps(RECAP, 4) });
const TASK = ["Implement doPut: update a user by id", "Implement doDelete: remove a user by id", "Fix the four bugs, and use a concurrent map"];
add("Your assignment. The repository leaves doPut and doDelete empty, so finish the CRUD app yourself.", { pose: "smug", mood: "excited", ...steps(TASK, 0) });
add("Read the parameters like in doPost, call the service, and update or remove the entry in the map.", { pose: "point", ...steps(TASK, 1) });
add("Then fix the four bugs from the spot the bug round, and swap the HashMap for a concurrent one.", { pose: "present", ...steps(TASK, 2) });
add("Next lesson: the Dispatcher Servlet, and how Spring MVC uses everything you saw today.", { pose: "present", mood: "excited", ...scene("sky", [{ asset: "server", x: 30, y: 52, size: 46, label: "Servlets", tint: "blue" }, { asset: "rocket", x: 70, y: 52, size: 46, label: "Spring MVC" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Thanks for watching, and see you in the next lesson.", { pose: "celebrate", mood: "happy" });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "How Java Web Apps Actually Work | Servlets, Tomcat & WAR Files | Spring Boot Full Course #14",
  description:
    "What happens before Spring Boot? This interactive lesson builds a CRUD app with plain servlets and deploys it to an external Tomcat. You will see why raw sockets are not enough, what a servlet container does, " +
    "how HttpServletRequest and HttpServletResponse work, what a WAR file is, why the provided scope exists, the servlet lifecycle (constructor, init, service, destroy), and how the Dispatcher Servlet in Spring MVC grows out of it. " +
    "Includes pause-and-think questions, a spot-the-bug round on the course's UserServlet, and a thread-safety warning.\n\n" +
    "Chapters: 1 Why servlets | 2 The problem | 3 The servlet container | 4 Tomcat and WAR files | 5 Build the app | 6 Reading data | 7 Package, deploy, test | 8 The servlet lifecycle | 9 Spot the bug | 10 From servlets to Spring MVC | 11 Recap and your turn\n\n" +
    "Code: github.com/adityatandon15/Spring-Framework-Full-Course (Lecture 14, ServletCrudDemo). Version note: Tomcat 10.1 implements Servlet 6.0 and Tomcat 11 implements Servlet 6.1 (tomcat.apache.org/whichversion.html); match your API dependency to your Tomcat.\n\n" +
    "Based on Spring Boot Full Course Lecture 14 (Hindi). Next video: the Dispatcher Servlet and Spring MVC.\n\n#SpringBoot #Java #Servlets #Tomcat #CodeOrCap",
  tags: ["Servlets", "Tomcat", "WAR file", "Spring MVC", "DispatcherServlet", "servlet lifecycle", "HttpServlet", "Spring Boot", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "spring14-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
