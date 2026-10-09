// Generates the plan-only JSON for the 20-minute English tutorial:
// "Spring Boot CRUD Project from Scratch: API & Architecture" (Spring Boot Full Course #11)
// Source: the lecture transcript. Class names, endpoints, status codes and console output come from it.
// The lecture builds the skeleton only (create endpoint, dummy repository); reads, update, delete and the real
// database connection come in the next video, and this lesson says so.
//   node spring-11-crud-architecture.js out.json
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
const term = (lines, title = "Run") => ({ terminal: { title, lines: /^(Run|Server console)$/.test(title) ? ["$ ./mvnw spring-boot:run", ...lines] : lines } });
const flow = (nodes, active, packet) => ({ flow: { nodes, active, packet } });
const steps = (items, current) => ({ steps: { items, current } });
const scene = (background, items, arrows = []) => ({ scene: { background, items, arrows } });
const quiz = (question, options, answer, revealAt = 0.65) => ({ quiz: { question, options, answer, revealAt } });
const alert = (kind, title, detail) => ({ alert: { kind, title, detail } });
const compare = (mode, cards) => ({ compare: { mode, cards } });
const browser = (url, kind, lines, heading) => ({ browser: { url, kind, lines, heading } });
const table = (name, columns, rows, highlightRow) => ({ table: { name, columns, rows, highlightRow } });
const two = (bg, a, b) => scene(bg, [{ asset: a[0], x: 28, y: 52, size: 44, label: a[1], tint: a[2] }, { asset: b[0], x: 72, y: 52, size: 44, label: b[1], tint: b[2] }], [{ from: [42, 52], to: [58, 52] }]);

// Progressive code: revealFrom is the length of the common prefix with the previous snapshot of the same file.
const lastCode = {};
function snap(title, language, lines, o = {}) {
  const prev = lastCode[title] || [];
  let k = 0;
  while (k < prev.length && k < lines.length && prev[k] === lines[k]) k++;
  lastCode[title] = lines;
  return code(title, language, lines, { revealFrom: Math.min(k, lines.length - 1), animate: "type", ...o });
}

// ── shared snapshots ──
const CRUD_STEPS = ["Create: add a record", "Read: fetch records", "Update: change a record", "Delete: remove a record"];
const LAYERS = ["Postman (client)", "StudentController", "StudentService", "StudentRepository", "MySQL database"];
const REQS = ["Postman", "MySQL server", "DBeaver (database viewer)", "Spring Initializr project"];
const ENDPOINTS = [["POST", "/api/students", "create"], ["GET", "/api/students/1", "read one"], ["GET", "/api/students", "read all"], ["PUT", "/api/students/1", "update"], ["DELETE", "/api/students/1", "delete"]];
const STUDENT_FIELDS = ["public class Student {", "  private Long id;", "  private String name;", "  private String email;", "  private Integer age;", "  private Integer rollNumber;", "  private String subject;", "}"];
const POST_JSON = ["{", "  \"name\": \"Aditya\",", "  \"email\": \"aditya@gmail.com\",", "  \"age\": 28,", "  \"rollNumber\": 1001,", "  \"subject\": \"Spring Framework\"", "}"];

// ═══════════════════════ 1 · The big picture ═══════════════════════
chapter("1 · The big picture", "stage");
add("Almost every backend application you will ever build does just four things with data.", { pose: "present", mood: "excited", ...steps(CRUD_STEPS, 0) });
add("Create it, read it, update it, and delete it. Those four letters spell CRUD.", { pose: "point", ...steps(CRUD_STEPS, 3) });
add("It sounds simple, yet this tiny idea is the backbone of every backend project.", { pose: "smug", mood: "happy" });
add("Think of Instagram or YouTube. Uploading a video creates a record.", { pose: "point", ...two("room", ["phone", "Upload a video", "blue"], ["database", "New record", "green"]) });
add("Scrolling through reels is a read. Editing a caption is an update. Removing a post is a delete.", { pose: "present", ...steps(CRUD_STEPS, 1) });
add("Once you can do CRUD in Spring Boot, any business logic on top becomes easier.", { pose: "smug", mood: "happy", props: [{ type: "bulb" }] });
add("Today we bring three things together for the first time: a client, a server, and a database.", { pose: "present", ...flow(["Client", "Spring Boot server", "Database"], 2, "data") });
add("You will learn a lot, even if you have built CRUD apps before.", { pose: "point", mood: "excited" });
add("And do not worry if some of it feels magical. We open the black box in later lessons.", { pose: "shrug", mood: "happy", props: [{ type: "question" }] });

// ═══════════════════════ 2 · What we will build ═══════════════════════
chapter("2 · What we will build", "office");
add("Here is the finished app. In Postman, I send a POST request to slash api slash students.", { pose: "present", ...browser("POST localhost:8080/api/students", "json", POST_JSON.slice(0, 7)) });
add("The body holds a name, an email, an age, a roll number, and a subject.", { pose: "point", ...browser("POST localhost:8080/api/students", "json", POST_JSON.slice(0, 7)) });
add("The database table is empty. I press send, and the server answers with two hundred OK.", { pose: "point", mood: "happy", ...table("student", ["id", "name", "age"], [["-", "-", "-"]], 0) });
add("Refresh the database, and a new row has appeared. One create operation, done.", { pose: "present", mood: "excited", ...table("student", ["id", "name", "age", "is_deleted"], [["1", "Aditya", "28", "0"]], 0) });
add("A second request with different values creates a second row.", { pose: "point", ...table("student", ["id", "name", "age", "is_deleted"], [["1", "Aditya", "28", "0"], ["2", "Rohit", "29", "0"]], 1) });
add("A GET request for student one reads that record back, with a two hundred OK.", { pose: "present", ...browser("GET localhost:8080/api/students/1", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"age\": 28", "}"]) });
add("A GET on slash api slash students, with no id, returns a list of every student.", { pose: "point", ...browser("GET localhost:8080/api/students", "json", ["[", "  { \"id\": 1, \"name\": \"Aditya\" },", "  { \"id\": 2, \"name\": \"Rohit\" }", "]"]) });
add("A PUT request updates student one: age goes from twenty eight to twenty nine.", { pose: "present", ...table("student", ["id", "name", "age"], [["1", "Aditya", "29"], ["2", "Rohit", "29"]], 0) });
add("A DELETE request removes student one, and the row disappears from the table.", { pose: "point", mood: "worried", ...table("student", ["id", "name", "age"], [["2", "Rohit", "29"]], 0) });
add("There is also a soft delete. The row stays, but is marked as deleted.", { pose: "think", ...table("student", ["id", "name", "is_deleted"], [["2", "Rohit", "1"]], 0) });
add("Soft delete means: do not erase the record, only flag it as deleted.", { pose: "present", ...compare("versus", [{ title: "Hard delete", points: ["Row is erased forever"] }, { title: "Soft delete", points: ["Row stays", "Flag is_deleted = 1", "Hidden from lists"] }]) });
add("Behind the scenes, the server logs the SQL queries it runs: insert, update, select.", { pose: "present", ...term(["Hibernate: insert into student ...", "Hibernate: select ... from student", "Hibernate: update student set ..."], "Server log") });
add("Will we write those queries by hand? No. That is the magic of Spring Data JPA.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });

// ═══════════════════════ 3 · HTTP and the architecture ═══════════════════════
chapter("3 · HTTP and the architecture", "classroom");
add("First, the big picture. The client sends an HTTP request to the server.", { pose: "present", ...flow(["Client", "Server"], 1, "HTTP request") });
add("The server sends back an HTTP response. Those two messages follow fixed rules.", { pose: "point", ...flow(["Client", "Server"], 0, "HTTP response") });
add("To create data, the client uses the POST method.", { pose: "present", ...steps(["POST: create", "GET: read", "PUT: update", "DELETE: delete"], 0) });
add("To read data, it uses GET.", { pose: "point", ...steps(["POST: create", "GET: read", "PUT: update", "DELETE: delete"], 1) });
add("To update existing data, it uses PUT. Post means new, put means existing.", { pose: "point", ...steps(["POST: create", "GET: read", "PUT: update", "DELETE: delete"], 2) });
add("And to delete, it uses DELETE.", { pose: "present", ...steps(["POST: create", "GET: read", "PUT: update", "DELETE: delete"], 3) });
add("So POST, GET, PUT, DELETE are HTTP methods, while create, read, update, delete are the operations.", { pose: "smug", ...table("Methods and operations", ["HTTP method", "CRUD operation"], [["POST", "Create"], ["GET", "Read"], ["PUT", "Update"], ["DELETE", "Delete"]], 0) });
add("Who is the client? Anything that can send a request: a React app, a browser, or a mobile app.", { pose: "present", ...scene("room", [{ asset: "laptop", x: 22, y: 52, size: 36, label: "Web app" }, { asset: "phone", x: 50, y: 52, size: 36, label: "Mobile app" }, { asset: "globe", x: 78, y: 52, size: 36, label: "Browser" }]) });
add("We are not building a front end today, so our client is Postman.", { pose: "point", ...browser("postman", "page", ["Send requests to any server", "GET   POST   PUT   PATCH   DELETE", "URL + headers + body", "See status code and response"], "Postman") });
add("Postman imitates a client, and we will use it all through this series.", { pose: "smug", mood: "happy" });
add("The server runs on localhost, port eight thousand and eighty. That is the host name.", { pose: "present", ...browser("localhost:8080", "page", ["Host: localhost", "Port: 8080", "Spring Boot with Tomcat"], "Server address") });
add("When you deploy, you replace localhost with your own domain name. Here we stay local.", { pose: "point", ...two("sky", ["laptop", "localhost:8080"], ["globe", "yourdomain.com", "blue"]) });
add("What is an endpoint? A complete URL that is mapped to one method in your Spring Boot code.", { pose: "present", ...flow(["URL", "Mapping", "Java method"], 2, "request") });
add("Hit slash api slash students, and a specific Java method runs. Another URL runs another method.", { pose: "point", ...flow(["/api/students", "Mapping", "createStudent()"], 2, "POST") });
add("So a full request is the method, the host, the endpoint, a body, and headers.", { pose: "present", ...steps(["HTTP method: POST", "Host: localhost:8080", "Endpoint: /api/students", "Body: JSON", "Headers: Accept, Content-Type"], 4) });
add("Two headers matter here: Accept and Content-Type, both set to application slash json.", { pose: "point", ...browser("Headers", "json", ["Accept: application/json", "Content-Type: application/json"]) });
add("They say we send JSON, and we want JSON back. They are usually added for you.", { pose: "smug" });
add("The server then talks to the database, stores the data, and replies to the client.", { pose: "present", ...flow(LAYERS.slice(0, 1).concat(["Spring Boot", "MySQL"]), 2, "store") });
add("Postman is the client, Spring Boot is the server, and MySQL is the database.", { pose: "point", mood: "happy", ...scene("lab", [{ asset: "laptop", x: 17, y: 52, size: 38, label: "Postman" }, { asset: "server", x: 50, y: 52, size: 38, label: "Spring Boot" }, { asset: "database", x: 83, y: 52, size: 38, label: "MySQL" }], [{ from: [28, 52], to: [39, 52] }, { from: [61, 52], to: [72, 52] }]) });

// ═══════════════════════ 4 · What you need ═══════════════════════
chapter("4 · What you need", "office");
add("Before we code, install four things. First, Postman, for Windows or Mac.", { pose: "present", ...steps(REQS, 0) });
add("Second, a MySQL server on your computer, so you can run a database.", { pose: "point", ...steps(REQS, 1) });
add("Why a relational database? Because we store rows in tables. Postgres or Oracle would also work.", { pose: "think", ...compare("versus", [{ title: "MySQL", points: ["Easy to start", "Used in this course"] }, { title: "PostgreSQL", points: ["Also works", "We will try it later"] }]) });
add("MySQL has no graphical interface, so we add a third tool: DBeaver.", { pose: "present", ...steps(REQS, 2) });
add("MySQL Workbench is the official tool, and Sequel Ace is great on a Mac, but DBeaver works everywhere.", { pose: "point" });
add("Install them, set a password for your MySQL server, and open DBeaver. The notes have every step.", { pose: "point", mood: "happy", ...steps(REQS, 2) });
add("You do not need to create a database yet. We will create it ourselves, so pause now and install.", { pose: "smug" });

// ═══════════════════════ 5 · Project setup ═══════════════════════
chapter("5 · Project setup", "office");
add("Now the Spring Boot project. Open Spring Initializr, our favourite website.", { pose: "present", ...browser("start.spring.io", "page", ["Project: Maven   Language: Java", "Spring Boot: 4.1.0", "Group: in.strikes", "Artifact: crud-spring-boot-demo", "Packaging: Jar   Java: 21"], "Spring Initializr") });
add("We choose Maven, Java 21, and name the project crud spring boot demo.", { pose: "point", ...browser("start.spring.io", "page", ["Project: Maven   Language: Java", "Spring Boot: 4.1.0", "Group: in.strikes", "Artifact: crud-spring-boot-demo", "Packaging: Jar   Java: 21"], "Spring Initializr") });
add("This time it is a web application, not a console one, so we need three dependencies.", { pose: "point", mood: "excited", ...steps(["Spring Web", "Spring Data JPA", "MySQL Driver"], 0) });
add("Spring Web gives us the Tomcat server. We will study it properly soon.", { pose: "present", ...steps(["Spring Web", "Spring Data JPA", "MySQL Driver"], 0) });
add("Spring Data JPA lets us talk to the database without writing SQL queries.", { pose: "present", ...steps(["Spring Web", "Spring Data JPA", "MySQL Driver"], 1) });
add("And the MySQL driver lets our application connect to MySQL.", { pose: "point", ...steps(["Spring Web", "Spring Data JPA", "MySQL Driver"], 2) });
add("Generate, unzip, and open it in IntelliJ. In pom dot xml, here is the data JPA starter.", { pose: "present", ...snap("pom.xml", "xml", ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-data-jpa</artifactId>", "</dependency>"], { highlight: [2] }) });
add("It brings JPA, the Jakarta Persistence API, so we can use the database without raw SQL.", { pose: "point", ...snap("pom.xml", "xml", ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-data-jpa</artifactId>", "</dependency>"], { highlight: [2], animate: "lines" }) });
add("Next, the web starter, with Spring MVC and the Tomcat server.", { pose: "present", ...snap("pom.xml", "xml", ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-webmvc</artifactId>", "</dependency>"], { highlight: [2] }) });
add("And the MySQL connector, which lets us connect to the database.", { pose: "point", ...snap("pom.xml", "xml", ["<dependency>", "  <groupId>com.mysql</groupId>", "  <artifactId>mysql-connector-j</artifactId>", "</dependency>"], { highlight: [2] }) });
add("The test dependencies are there too, but we will not write tests today.", { pose: "shrug" });
add("Each dependency also pulls in many more, called transitive dependencies. Maven lists them all.", { pose: "present", ...scene("lab", [{ asset: "gear", x: 28, y: 52, size: 40, label: "5 dependencies" }, { asset: "gear", x: 72, y: 52, size: 40, label: "Many more inside", tint: "blue" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Let us run a first test. Print Hello World in the main class, and press run.", { pose: "think", ...snap("CrudSpringBootDemoApplication.java", "java", ["public static void main(String[] args) {", "  SpringApplication.run(", "    CrudSpringBootDemoApplication.class, args);", "  System.out.println(\"Hello World\");", "}"], { highlight: [3] }) });
add("It fails. The process finishes with an exit code, and the error says application failed to start.", { pose: "shocked", mood: "shocked", ...term(["Failed to configure a DataSource: 'url'", "attribute is not specified and no embedded", "datasource could be configured."], "Error") });
add("We only downloaded dependencies. Why does the app break already?", { pose: "think", mood: "confused", props: [{ type: "question" }] });
add("Because of auto-configuration. Seeing JPA and the MySQL driver, Spring Boot tries to set up a database.", { pose: "point", ...flow(["Dependencies", "Auto-config", "DataSource bean"], 2, "setup") });
add("One of those beans is the data source, and it needs a URL, a username, and a password.", { pose: "present", ...steps(["DataSource needs:", "URL of the database", "Username", "Password"], 1) });
add("Those values belong in application dot properties, and we have not added them yet.", { pose: "point", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo"], { highlight: [0] }) });
add("For now, tell Spring Boot to exclude data source auto-configuration.", { pose: "smug", ...snap("CrudSpringBootDemoApplication.java", "java", ["@SpringBootApplication(exclude = {", "  DataSourceAutoConfiguration.class", "})", "public class CrudSpringBootDemoApplication {"], { highlight: [1] }) });
add("Run again, and Hello World prints. The Tomcat server starts on port eight thousand and eighty.", { pose: "celebrate", mood: "happy", ...term(["Hello World", "Tomcat started on port 8080 (http)", "Started CrudSpringBootDemoApplication"]) });
add("Tomcat is what listens to port eight thousand and eighty, so our app is ready for requests.", { pose: "present", mood: "happy" });
add("Open localhost 8080 in a browser, and you get a white label error page.", { pose: "point", ...alert("warning", "Whitelabel Error Page", "No endpoint is mapped yet") });
add("That is expected, because we have not mapped a single endpoint. Let us fix that.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 6 · Layered architecture ═══════════════════════
chapter("6 · Layered architecture", "classroom");
add("How should we organise the code? One class could do everything.", { pose: "think", ...code("StudentService.java", "java", ["// one class that:", "//  1. listens to the endpoint", "//  2. applies business rules", "//  3. talks to the database"], { language: "java", highlight: [1, 2, 3] }) });
add("It would listen to the endpoint, apply business logic, and talk to the database.", { pose: "present", ...flow(["Postman", "One big class", "Database"], 1, "everything") });
add("That is a bad idea. A class should have one responsibility, and use dependencies for the rest.", { pose: "point", mood: "worried", ...alert("warning", "One class, three jobs", "Hard to change and hard to test") });
add("You saw this idea in our Spring Core videos. Now we apply it at project scale.", { pose: "smug" });
add("So we split it into three layers. First, the controller layer.", { pose: "present", ...steps(["Controller layer", "Service layer", "Repository layer"], 0) });
add("The controller receives the HTTP request, with its body and parameters, and nothing more.", { pose: "point", ...flow(["Postman", "StudentController"], 1, "HTTP request") });
add("Second, the service layer. It holds the business logic and validation.", { pose: "present", ...steps(["Controller layer", "Service layer", "Repository layer"], 1) });
add("For example, the subject must be a computer science subject, and roll numbers must stay in range.", { pose: "point", ...compare("versus", [{ title: "Valid", points: ["Subject: Spring Framework", "Roll number in range"] }, { title: "Rejected", points: ["Subject: Geography", "Roll number out of range"] }]) });
add("Third, the repository layer. Its only job is to talk to the database.", { pose: "present", ...steps(["Controller layer", "Service layer", "Repository layer"], 2) });
add("The service never touches the database itself. It hands the work to the repository.", { pose: "point", ...flow(["StudentService", "StudentRepository", "MySQL"], 1, "save") });
add("Every request travels down through the layers, and the answer travels back up.", { pose: "present", ...flow(LAYERS, 4, "request") });
add("Postman to controller to service to repository to database, and the response returns the same way.", { pose: "point", mood: "happy", ...flow(LAYERS, 0, "response") });
add("This is the controller, service, repository architecture, and we will use it in every project.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });
add("The data itself travels in a fourth kind of class, called an entity.", { pose: "present", ...steps(["Controller", "Service", "Repository", "Entity"], 3) });
add("We keep it to those four for now. Other patterns like DTOs come in later lessons.", { pose: "shrug" });
add("Each layer lives in its own package, so the project stays tidy as it grows.", { pose: "present", ...steps(["controller", "service", "repository", "entity"], 0) });
add("Imagine students, teachers, and courses. Each needs its own controller, service, and repository.", { pose: "point", ...scene("room", [{ asset: "person", x: 22, y: 52, size: 36, label: "Students" }, { asset: "person-happy", x: 50, y: 52, size: 36, label: "Teachers" }, { asset: "document", x: 78, y: 52, size: 36, label: "Courses" }]) });
add("So we create four packages: controller, service, repository, and entity.", { pose: "present", ...code("Project structure", "text", ["in.strikes.crudspringbootdemo", "  controller", "  service", "  repository", "  entity", "  CrudSpringBootDemoApplication"], { animate: "lines" }) });
add("Some people name the entity package model. Both are fine, but this is the common convention.", { pose: "smug" });

// ═══════════════════════ 7 · The Student entity ═══════════════════════
chapter("7 · The Student entity", "office");
add("What do we store? A student. So in the entity package, we create a class named Student.", { pose: "present", ...snap("Student.java", "java", ["public class Student {", "}"]) });
add("It is a plain old Java object. Think about which details matter for a student.", { pose: "think", ...snap("Student.java", "java", ["public class Student {", "}"], { animate: "lines" }) });
add("A name, an email, an age, a roll number, and a subject. That is enough for now.", { pose: "point", ...snap("Student.java", "java", ["public class Student {", "  private String name;", "  private String email;", "  private Integer age;", "  private Integer rollNumber;", "  private String subject;", "}"]) });
add("The same fields will appear in the JSON that Postman sends.", { pose: "present", ...browser("Request body", "json", POST_JSON) });
add("Which means the JSON must be converted into this class before our Java code can use it.", { pose: "point", ...flow(["JSON", "Student object"], 1, "convert") });
add("Java code only understands classes, so name, age, and roll number must land in a Student object.", { pose: "point", mood: "worried" });
add("Next, the database. In DBeaver, create a new database called student crud db.", { pose: "present", ...term(["CREATE DATABASE student_crud_db;"], "DBeaver") });
add("Then a table named student, with the very same columns, plus an id.", { pose: "point", ...code("create-table.sql", "text", ["CREATE TABLE student (", "  id BIGINT AUTO_INCREMENT PRIMARY KEY,", "  name VARCHAR(255),", "  age INT,", "  email VARCHAR(255),", "  roll_number INT,", "  subject VARCHAR(255)", ");"], { animate: "lines" }) });
add("Run it, refresh, and the empty student table is there. The id is the primary key.", { pose: "present", mood: "happy", ...table("student", ["id", "name", "age", "email"], [["-", "-", "-", "-"]], 0) });
add("A primary key is unique for each row, so the database can find exactly one record.", { pose: "point", ...scene("lab", [{ asset: "database", x: 28, y: 52, size: 44, label: "Table", tint: "blue" }, { asset: "lock", x: 72, y: 52, size: 44, label: "Unique id", tint: "gold" }], [{ from: [42, 52], to: [58, 52] }]) });
add("We could insert a row by hand, with an insert query and hard-coded values.", { pose: "think", ...code("insert.sql", "text", ["INSERT INTO student VALUES (", "  1, 'Aditya', 28,", "  'aditya@gmail.com', 1001,", "  'Spring Framework');"], { animate: "lines" }) });
add("But those values are hard-coded. In our app, they come from the Student object.", { pose: "point", mood: "worried" });
add("So something must turn each Student object into a row, filling each column from each field.", { pose: "present", ...flow(["Student object", "ORM", "Table row"], 1, "map") });
add("Spring Data JPA does exactly that, so we never write those queries ourselves.", { pose: "smug", mood: "happy" });
add("Why is this called ORM? Object relational mapping. One object is mapped to one row.", { pose: "present", ...compare("versus", [{ title: "Java", points: ["Student s1", "Student s2"] }, { title: "Database", points: ["Row 1", "Row 2"] }]) });
add("A second student object maps to a second row, and a third object to a third row.", { pose: "point" });
add("We will study Hibernate and JDBC underneath it later. Today we treat it as a black box.", { pose: "shrug", mood: "happy" });
add("How do we tell JPA that this class should be stored? With the Entity annotation.", { pose: "present", ...snap("Student.java", "java", ["@Entity", "public class Student {", "  private String name;", "  private String email;", "  private Integer age;", "  private Integer rollNumber;", "  private String subject;", "}"], { highlight: [0], revealFrom: 0 }) });
add("The moment we add it, an error appears: a persistent entity should have a primary key.", { pose: "shocked", mood: "worried", ...alert("error", "No primary key", "Persistent entity Student should have a primary key") });
add("That is logical. A database table needs a primary key, and so does our class.", { pose: "think" });
add("Could the name be the key? No, two students can share a name.", { pose: "point", ...quiz("Which field is the safest primary key?", ["name", "age", "a separate id field", "subject"], 2, 0.7) });
add("Email would be unique, and so might roll number. But the best habit is a separate id field.", { pose: "present", mood: "happy" });
add("We use a Long, because we may store a very large number of records.", { pose: "point", ...snap("Student.java", "java", ["@Entity", "public class Student {", "  @Id", "  private Long id;", "  private String name;", "  private String email;", "  private Integer age;", "  private Integer rollNumber;", "  private String subject;", "}"], { highlight: [2, 3], revealFrom: 2 }) });
add("The Id annotation marks it as the primary key, and the error disappears.", { pose: "celebrate", mood: "happy" });
add("Generate getters and setters for every field, including the id. The entity is complete.", { pose: "present", ...snap("Student.java", "java", ["@Entity", "public class Student {", "  @Id", "  private Long id;", "  private String name;", "  // email, age, rollNumber, subject", "  // getters and setters for all fields", "}"], { animate: "lines", revealFrom: 0 }) });
add("Look inside Entity, and you see Retention, Target and Documented. You will meet them in every annotation.", { pose: "point" });
add("Notice there is no Component annotation. So the Spring IoC container does not manage this class.", { pose: "think", mood: "confused", ...compare("versus", [{ title: "Controller, Service", points: ["Managed by IoC", "Component inside"] }, { title: "Entity", points: ["Managed by JPA", "Not an IoC bean"] }]) });
add("We create Student objects with new, and JPA manages them. Different tools, different jobs.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 8 · The controller ═══════════════════════
chapter("8 · The controller", "office");
add("Now the controller. In the controller package, create StudentController.", { pose: "present", ...snap("StudentController.java", "java", ["public class StudentController {", "}"]) });
add("It must receive HTTP requests. So we tell Spring it is special, using Rest Controller.", { pose: "point", ...snap("StudentController.java", "java", ["@RestController", "public class StudentController {", "}"], { highlight: [0] }) });
add("Why not Component? Component is generic. Rest Controller says: this class handles REST requests.", { pose: "present", ...compare("versus", [{ title: "@Component", points: ["Generic bean"] }, { title: "@RestController", points: ["Handles REST requests", "Returns JSON"] }]) });
add("Inside, it still uses Component, and Spring creates the bean and stores it in the IoC container.", { pose: "point", ...scene("lab", [{ asset: "city", x: 28, y: 52, size: 40, label: "StudentController" }, { asset: "server", x: 72, y: 52, size: 40, label: "IoC container", tint: "blue" }], [{ from: [42, 52], to: [58, 52] }]) });
add("A Rest Controller returns data, usually JSON, rather than web pages.", { pose: "smug" });
add("Every method in this class will serve a path that starts with slash api slash students.", { pose: "present", ...table("Endpoints", ["method", "endpoint", "action"], ENDPOINTS, 0) });
add("Create is POST. Read one is GET with an id. Read all is GET without an id.", { pose: "point", ...table("Endpoints", ["method", "endpoint", "action"], ENDPOINTS, 1) });
add("Update is PUT with an id. Delete is DELETE with an id.", { pose: "present", ...table("Endpoints", ["method", "endpoint", "action"], ENDPOINTS, 4) });
add("Two endpoints can be identical. What makes a request unique is the URL plus the HTTP method.", { pose: "think", ...compare("versus", [{ title: "POST /api/students", points: ["Creates a student"] }, { title: "GET /api/students", points: ["Reads all students"] }]) });
add("The common part, slash api slash students, goes on the class with Request Mapping.", { pose: "point", ...snap("StudentController.java", "java", ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "}"], { highlight: [1] }) });
add("Every method in this class now starts from that path.", { pose: "present", mood: "happy" });
add("Now the create method. Public void createStudent, for now.", { pose: "present", ...snap("StudentController.java", "java", ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  public void createStudent() {", "  }", "}"], { highlight: [3] }) });
add("It should run only when a POST request arrives. For that, we add Post Mapping.", { pose: "point", ...snap("StudentController.java", "java", ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  @PostMapping(\"/create\")", "  public void createStudent() {", "  }", "}"], { highlight: [3] }) });
add("Here we add slash create to the path, so the full endpoint is slash api slash students slash create.", { pose: "point" });
add("You can design it either way. Some teams keep one endpoint per method; others add words like create.", { pose: "shrug" });
add("I prefer the same endpoint with different methods, but for now we keep slash create to stay clear.", { pose: "smug" });
add("Together, the HTTP method and the full path are unique, so Spring knows exactly which method to call.", { pose: "present", ...flow(["POST + /api/students/create", "Mapping", "createStudent()"], 2, "match") });
add("How does the Student object arrive? The method must accept one as a parameter.", { pose: "think", ...snap("StudentController.java", "java", ["  @PostMapping(\"/create\")", "  public void createStudent(Student student) {", "  }"], { highlight: [1] }) });
add("But the JSON is in the body. Request Body tells Spring to convert the JSON into a Student.", { pose: "point", ...snap("StudentController.java", "java", ["  @PostMapping(\"/create\")", "  public void createStudent(", "      @RequestBody Student student) {", "  }"], { highlight: [2] }) });
add("Spring does this with the Jackson library. It turns JSON into an object, and back again.", { pose: "present", ...flow(["JSON body", "Jackson", "Student object"], 1, "convert") });
add("Let us prove it. Print the student's name and email.", { pose: "point", ...snap("StudentController.java", "java", ["  @PostMapping(\"/create\")", "  public void createStudent(", "      @RequestBody Student student) {", "    System.out.println(student.getName());", "    System.out.println(student.getEmail());", "  }"], { highlight: [3, 4] }) });
add("Run the app, and send the POST request from Postman to the create endpoint.", { pose: "present", ...browser("POST localhost:8080/api/students/create", "json", POST_JSON) });
add("The console prints Aditya and his email. The JSON mapped into the object by itself.", { pose: "celebrate", mood: "happy", ...term(["Aditya", "aditya@gmail.com"], "Server console") });
add("No response comes back yet, because the method is void. But the mapping works.", { pose: "smug" });
add("Magical, yes. Jackson matches each JSON key with the field of the same name.", { pose: "point", mood: "excited", props: [{ type: "bulb" }] });

// ═══════════════════════ 9 · Service and repository ═══════════════════════
chapter("9 · Service and repository", "office");
add("The controller should only receive the request. It must hand the work to the service.", { pose: "present", ...flow(["StudentController", "StudentService"], 1, "Student") });
add("So the controller depends on the service. And we know how to inject a dependency.", { pose: "point", ...snap("StudentController.java", "java", ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  private final StudentService studentService;", "}"], { highlight: [3] }) });
add("Field injection would work. But we prefer constructor injection.", { pose: "smug", ...snap("StudentController.java", "java", ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  private final StudentService studentService;", "", "  public StudentController(StudentService s) {", "    this.studentService = s;", "  }", "}"], { highlight: [5, 6] }) });
add("No annotation is needed. Spring injects the service automatically.", { pose: "present", mood: "happy" });
add("Create the service class in the service package, and mark it as a Service.", { pose: "present", ...snap("StudentService.java", "java", ["@Service", "public class StudentService {", "}"], { highlight: [0] }) });
add("Under the hood, Service uses Component. It just says: this class holds business logic.", { pose: "point", ...compare("versus", [{ title: "@Component", points: ["Any bean"] }, { title: "@Service", points: ["Business logic", "Clearer for teammates"] }]) });
add("A teammate reading Service knows where the business rules live. Component would work too.", { pose: "smug" });
add("Now give the service a method that creates a student. It returns a Student.", { pose: "present", ...snap("StudentService.java", "java", ["@Service", "public class StudentService {", "  public Student createStudent(Student request) {", "    // business logic goes here", "    return null;", "  }", "}"], { highlight: [2] }) });
add("In the controller, call that method, and keep what it returns.", { pose: "point", ...snap("StudentController.java", "java", ["  @PostMapping(\"/create\")", "  public String createStudent(", "      @RequestBody Student studentRequest) {", "    Student created =", "      studentService.createStudent(studentRequest);", "    return \"Student created\";", "  }"], { highlight: [3, 4] }) });
add("Here the service has little to do. Rules like a valid subject would go in the service.", { pose: "think", ...code("StudentService.java", "java", ["// validation lives here, for example:", "// subject must be a CS subject", "// roll number must be in range"], { animate: "lines" }) });
add("Then the service hands the work to the repository, so it also needs a dependency.", { pose: "present", ...flow(["StudentService", "StudentRepository"], 1, "Student") });
add("The repository lives in its own package, and for now we mark it with Component.", { pose: "point", ...snap("StudentRepository.java", "java", ["@Component", "public class StudentRepository {", "  public Student saveStudent(Student request) {", "    // later: save to the database", "    return null;", "  }", "}"], { highlight: [0] }) });
add("Later we will use a special repository annotation. For now, Component keeps it simple.", { pose: "smug" });
add("Inject it into the service with a constructor, the same way as before.", { pose: "point", ...snap("StudentService.java", "java", ["@Service", "public class StudentService {", "  private final StudentRepository studentRepository;", "", "  public StudentService(StudentRepository repo) {", "    this.studentRepository = repo;", "  }", "}"], { highlight: [2, 4, 5] }) });
add("An error appeared earlier, because Spring could not find a bean. Adding Component fixed it.", { pose: "present", mood: "happy" });
add("And the service calls the repository's save method, passing the request.", { pose: "point", ...snap("StudentService.java", "java", ["  public Student createStudent(Student request) {", "    // validation and business rules go here", "    return studentRepository.saveStudent(request);", "  }"], { highlight: [2] }) });
add("The controller asks the service. The service asks the repository. Each layer delegates.", { pose: "present", ...flow(["Controller", "Service", "Repository"], 2, "Student") });
add("We have not connected to the database yet, so the repository only returns null.", { pose: "shrug", ...code("StudentRepository.java", "java", ["public Student saveStudent(Student request) {", "  // no database yet", "  return null;", "}"], { animate: "lines" }) });
add("Let us trace the flow. Print a line when entering and when leaving each layer.", { pose: "think", ...snap("StudentRepository.java", "java", ["public Student saveStudent(Student request) {", "  System.out.println(\"Inside StudentRepository\");", "  System.out.println(\"Exiting StudentRepository\");", "  return null;", "}"], { highlight: [1, 2] }) });
add("The service and the controller get the same inside and exiting messages.", { pose: "point", ...snap("StudentService.java", "java", ["public Student createStudent(Student request) {", "  System.out.println(\"Inside StudentService\");", "  Student saved = studentRepository.saveStudent(request);", "  System.out.println(\"Exiting StudentService\");", "  return saved;", "}"], { highlight: [1, 3] }) });
add("Run the app, and send the same POST request again.", { pose: "present", ...browser("POST localhost:8080/api/students/create", "json", POST_JSON) });
add("The response says: student created. The request went down and came back up.", { pose: "celebrate", mood: "happy", ...alert("success", "Student created", "Response body: plain text") });
add("The console shows the path: controller first, then service, then repository.", { pose: "point", ...term(["Inside StudentController", "Inside StudentService", "Inside StudentRepository", "Exiting StudentRepository", "Exiting StudentService", "Exiting StudentController"], "Server console") });
add("Then the layers exit in reverse: repository, service, and controller. A perfect call chain.", { pose: "present", mood: "happy" });
add("Now let the repository return a dummy student, so we can see a real response.", { pose: "think", ...snap("StudentRepository.java", "java", ["  public Student saveStudent(Student request) {", "    Student s1 = new Student();", "    s1.setName(\"Aditya\");", "    s1.setAge(28);", "    // also email, roll number and subject", "    return s1;", "  }"], { highlight: [1, 2, 5] }) });
add("We use new, because Spring does not manage the Student class. This is still dummy data.", { pose: "point", ...quiz("Why do we create Student with the new keyword?", ["Spring manages it as a bean", "Spring does not manage entities", "It is faster", "It is required for JSON"], 1, 0.7) });
add("The id stays empty, since the database will generate it later.", { pose: "smug" });

// ═══════════════════════ 10 · Responses and status codes ═══════════════════════
chapter("10 · Responses and status codes", "classroom");
add("Next, return the student instead of a string. The method now returns a Student.", { pose: "present", ...snap("StudentController.java", "java", ["  @PostMapping(\"/create\")", "  public Student createStudent(", "      @RequestBody Student studentRequest) {", "    Student created =", "      studentService.createStudent(studentRequest);", "    return created;", "  }"], { highlight: [1, 5] }) });
add("Send the request again, and the response is JSON, with every field of the student.", { pose: "point", ...browser("200 OK", "json", ["{", "  \"id\": null,", "  \"name\": \"Aditya\",", "  \"email\": \"aditya@gmail.com\",", "  \"age\": 28", "}"]) });
add("The id is null because we never set it. Jackson converted our object into JSON by itself.", { pose: "present", mood: "happy" });
add("A response has three parts: a body, a status code, and headers.", { pose: "present", ...steps(["Body: the JSON", "Status code: 200, 201, 404...", "Headers"], 1) });
add("The status code is always two hundred OK right now, because we never choose one.", { pose: "point", ...alert("warning", "Always 200 OK", "We have not chosen a status code") });
add("But creating something should return two hundred and one: created.", { pose: "present", ...steps(["200: OK", "201: Created", "404: Not Found", "401: Unauthorized"], 1) });
add("To control it, return a Response Entity of Student, with the type in angle brackets.", { pose: "point", ...snap("StudentController.java", "java", ["  public ResponseEntity<Student> createStudent(", "      @RequestBody Student studentRequest) {", "    Student created =", "      studentService.createStudent(studentRequest);", "    return ResponseEntity", "      .status(HttpStatus.CREATED).body(created);", "  }"], { highlight: [0, 4, 5] }) });
add("Response Entity wraps the status code and the body together. We choose both.", { pose: "present", ...flow(["Status: 201", "Body: Student", "ResponseEntity"], 2, "wrap") });
add("Http Status is an enum with many ready values: ok, created, accepted, not found, unauthorized.", { pose: "point", ...table("HttpStatus", ["name", "code"], [["OK", "200"], ["CREATED", "201"], ["ACCEPTED", "202"], ["NOT_FOUND", "404"], ["UNAUTHORIZED", "401"]], 1) });
add("There is also a shortcut, Response Entity dot ok, for the common two hundred case.", { pose: "smug" });
add("Rerun, send the request, and Postman now shows two hundred and one created, with the body.", { pose: "celebrate", mood: "happy", ...alert("success", "201 Created", "Body: the new student as JSON") });
add("The console still prints the whole path, from controller to repository and back.", { pose: "present", ...term(["Inside StudentController", "Inside StudentService", "Inside StudentRepository", "Exiting StudentRepository", "Exiting StudentService", "Exiting StudentController"], "Server console") });
add("The skeleton works. What is missing is the real database connection, and the other endpoints.", { pose: "point", ...steps(["Create endpoint (skeleton)", "Real database connection", "Read, update, delete endpoints", "Soft delete"], 1) });
add("They are for the next video, since this lesson is already long and could overwhelm a beginner.", { pose: "smug" });

// ═══════════════════════ 11 · Recap ═══════════════════════
chapter("11 · Recap and next steps", "stage");
const RECAP = ["CRUD = Create, Read, Update, Delete", "HTTP: POST, GET, PUT, DELETE", "Controller, Service, Repository + Entity", "Entity needs an Id; JSON maps via Jackson", "ResponseEntity sets the status code"];
add("Time to recap, with five key ideas.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: CRUD is the backbone of backend work, and each operation matches an HTTP method.", { pose: "point", ...steps(RECAP, 1) });
add("Two: split your code into controller, service, and repository, with an entity moving through them.", { pose: "point", ...steps(RECAP, 2) });
add("Three: an entity is a class stored in the database, and it needs a primary key.", { pose: "point", ...steps(RECAP, 3) });
add("Four: Request Body turns incoming JSON into an object, and Jackson turns objects back into JSON.", { pose: "point", ...steps(RECAP, 3) });
add("Five: Response Entity lets you choose the status code, such as two hundred and one for created.", { pose: "point", ...steps(RECAP, 4) });
add("If the whole architecture still feels like a lot, that is normal. Zero to one is the hardest step.", { pose: "smug", mood: "happy" });
add("Theory builds the foundation. Anyone can generate a project, but interviewers ask how it works inside.", { pose: "present", mood: "excited", props: [{ type: "bulb" }] });
const TASK = ["Create the three packages and the entity", "Build the create endpoint end to end", "Return 201 Created with a body"];
add("Your challenge: rebuild this skeleton yourself, without looking at the code.", { pose: "smug", mood: "excited", ...steps(TASK, 0) });
add("Create the packages and the entity, wire controller to service to repository, and return two hundred and one.", { pose: "point", ...steps(TASK, 2) });
add("In the next video, we connect to MySQL, and finish read, update, delete, and soft delete.", { pose: "present", mood: "excited", ...scene("sky", [{ asset: "database", x: 30, y: 52, size: 46, label: "MySQL", tint: "blue" }, { asset: "rocket", x: 70, y: 52, size: 46, label: "Full CRUD" }], [{ from: [42, 52], to: [58, 52] }]) });
add("If you have doubts, write them in the comments. Like the video if it helped.", { pose: "point", mood: "happy" });
add("Thanks for watching, and see you in the next lesson.", { pose: "celebrate", mood: "happy" });

// Trim: narration-only scenes that repeat what the panels already show, so the lesson lands near 20 minutes.
const DROP = [
  "It sounds simple, yet this tiny idea", "You will learn a lot, even if", "And do not worry if some of it feels magical", "Scrolling through reels is a read",
  "A second request with different values", 
  "Who is the client?", "Postman imitates a client", "When you deploy, you replace localhost", "They say we send JSON", "Two headers matter here", "So POST, GET, PUT, DELETE are HTTP methods",
  "MySQL Workbench is the official tool", "You do not need to create a database yet",
  "The test dependencies are there too", "Each dependency also pulls in many more", "That is expected, because we have not mapped", "Spring Web gives us the Tomcat server",
  "You saw this idea in our Spring Core", "We keep it to those four for now", "Imagine students, teachers, and courses", "Some people name the entity package model", "This is the controller, service, repository architecture",
  "Email would be unique, and so might roll number", "It is a plain old Java object. Think about",
  "Every method in this class now starts from that path", 
  "No annotation is needed.", "An error appeared earlier, because Spring could not find a bean", 
  "The id is null because we never set it", "There is also a shortcut, Response Entity dot ok", "They are for the next video, since this lesson",
  "If the whole architecture still feels like a lot", "If you have doubts, write them in the comments",
];
for (let k = scenes.length - 1; k >= 0; k--) if (DROP.some((d) => scenes[k].text.startsWith(d))) scenes.splice(k, 1);
scenes.forEach((sc, k) => { sc.i = k; });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "Spring Boot CRUD Project from Scratch | Create API & Architecture | Spring Boot Full Course #11",
  description:
    "Build the skeleton of a Spring Boot CRUD application: what CRUD means, how HTTP methods map to create, read, update and delete, " +
    "how a client (Postman), a Spring Boot server and a MySQL database work together, and how to structure code in the controller, service and repository layers with an entity class. " +
    "You will create the Student entity, map JSON to Java objects with Request Body, trace a request through every layer, and return a 201 Created response with Response Entity.\n\n" +
    "Chapters: 1 The big picture | 2 What we will build | 3 HTTP and the architecture | 4 What you need | 5 Project setup | 6 Layered architecture | 7 The Student entity | 8 The controller | 9 Service and repository | 10 Responses and status codes | 11 Recap\n\n" +
    "Based on Spring Boot Full Course Lecture 11 (Hindi). Next video: the MySQL connection and the remaining CRUD endpoints.\n\n#SpringBoot #Java #CRUD #CodeOrCap",
  tags: ["Spring Boot", "CRUD", "REST API", "Spring Data JPA", "Controller Service Repository", "Postman", "MySQL", "Spring Boot tutorial", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "spring11-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
