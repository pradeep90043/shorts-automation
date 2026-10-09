// Generates the plan-only JSON for the 20-minute English tutorial:
// "Spring Boot CRUD Project with MySQL: Spring Data JPA Methods" (Spring Boot Full Course #12)
// Source: the lecture transcript (continues lesson #11). Class names, endpoints, properties, queries and console
// behaviour come from it. One detail the lecture glosses over is added because the code needs it: the id must be
// generated (GeneratedValue with the identity strategy) for inserts without an id to work.
//   node spring-12-jpa-crud.js out.json
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

const JPA_METHODS = ["save(entity): insert or update", "findAll(): every row", "findById(id): one row", "deleteById(id): remove a row", "existsById(id): true or false"];
const FLOW = ["Postman", "Controller", "Service", "Repository", "MySQL"];
const PROPS_URL = ["spring.datasource.url=\\", "  jdbc:mysql://localhost:3306/student_crud_db"];
const PROPS_USER = [...PROPS_URL, "spring.datasource.username=root", "spring.datasource.password=<your-password>"];
const PROPS_DDL = [...PROPS_USER, "spring.jpa.hibernate.ddl-auto=update"];
const PROPS_ALL = [...PROPS_DDL, "spring.jpa.show-sql=true", "spring.jpa.properties.hibernate.format_sql=true"];
const REPO_LINES = ["public interface StudentRepository", "    extends JpaRepository<Student, Long> {", "}"];
const POST_JSON = ["{", "  \"name\": \"Aditya\",", "  \"email\": \"aditya@gmail.com\",", "  \"age\": 28,", "  \"rollNumber\": 1001,", "  \"subject\": \"Spring Framework\"", "}"];

// ═══════════════════════ 1 · Where we left off ═══════════════════════
chapter("1 · Where we left off", "stage");
add("Last time we built the skeleton of a CRUD application, but nothing reached a database.", { pose: "present", ...flow(FLOW, 3, "Student") });
add("The controller, service, repository, and entity were all talking, and the create endpoint worked.", { pose: "point", ...steps(["Controller", "Service", "Repository", "Student entity"], 3) });
add("Today we finish the project. Every record will really be stored in MySQL.", { pose: "present", mood: "excited", ...two("lab", ["laptop", "Spring Boot", "blue"], ["database", "MySQL", "green"]) });
add("We will add read, update, and delete, and test each one with real data.", { pose: "point", mood: "excited", ...steps(["Create", "Read one", "Read all", "Update", "Delete"], 0) });
add("And we will meet the real magic of Spring Data JPA: no SQL queries, and no repository code.", { pose: "smug", props: [{ type: "bulb" }] });
add("If you skipped the last video, watch it first, because we build directly on it.", { pose: "point", mood: "happy" });

// ═══════════════════════ 2 · Clean up ═══════════════════════
chapter("2 · Clean up", "office");
add("First, clean up. Remove every print statement we added only to explain the flow.", { pose: "present", ...snap("StudentService.java", "java", ["public Student createStudent(Student request) {", "  System.out.println(\"Inside StudentService\");", "  return studentRepository.saveStudent(request);", "}"], { highlight: [1] }) });
add("Delete them from the controller, the service, and the repository.", { pose: "point", ...snap("StudentService.java", "java", ["public Student createStudent(Student request) {", "  return studentRepository.saveStudent(request);", "}"]) });
add("We also drop the dummy student. Return null for now, so the code compiles.", { pose: "think", ...code("StudentRepository.java", "java", ["public Student saveStudent(Student request) {", "  return null; // temporary", "}"], { highlight: [1], animate: "lines" }) });
add("Because from now on, the repository must store real data.", { pose: "present", mood: "happy" });

// ═══════════════════════ 3 · Repository methods ═══════════════════════
chapter("3 · Repository methods", "classroom");
add("The repository layer talks to the database. It stores values and retrieves values.", { pose: "present", ...flow(["Repository", "Database"], 1, "store and fetch") });
add("We promised not to write SQL queries by hand. So what do we use instead?", { pose: "think", mood: "confused", props: [{ type: "question" }] });
add("Methods. Spring Data JPA gives us ready-made methods for every basic database task.", { pose: "present", mood: "excited", ...steps(JPA_METHODS, 0) });
add("JPA stands for Jakarta Persistence API. In older code you see imports starting with javax. Now it is jakarta.", { pose: "point", ...compare("versus", [{ title: "Old code", points: ["javax.persistence"] }, { title: "New code", points: ["jakarta.persistence"] }]) });
add("The first method is save. It stores a value, much like an insert query.", { pose: "present", ...steps(JPA_METHODS, 0) });
add("To read everything, there is findAll. It runs a select on the whole table.", { pose: "point", ...steps(JPA_METHODS, 1) });
add("To read one record, there is findById. It adds a where clause on the id.", { pose: "point", ...steps(JPA_METHODS, 2) });
add("To remove a record, there is deleteById.", { pose: "present", ...steps(JPA_METHODS, 3) });
add("What about updating? There is no update method. The save method does both jobs.", { pose: "think", mood: "confused", ...compare("versus", [{ title: "Id is new", points: ["save runs INSERT"] }, { title: "Id exists", points: ["save runs UPDATE"] }]) });
add("How does it know? It looks at the primary key. We will see the details when we study Hibernate.", { pose: "smug" });
add("One more handy method: existsById, which returns true or false for a given id.", { pose: "present", ...steps(JPA_METHODS, 4) });
add("These five methods will carry our whole CRUD application.", { pose: "smug", mood: "happy", ...steps(JPA_METHODS, 4) });
add("Which method can both create a new record and update an existing one?", { pose: "point", ...quiz("Which one creates and also updates a record?", ["insert", "update", "save", "persistOrMerge"], 2, 0.7) });

// ═══════════════════════ 4 · The repository interface ═══════════════════════
chapter("4 · The repository interface", "office");
add("Now the surprising part. We turn the repository class into an interface.", { pose: "present", ...snap("StudentRepository.java", "java", ["public interface StudentRepository {", "}"]) });
add("It extends an existing interface: JpaRepository.", { pose: "point", ...snap("StudentRepository.java", "java", ["public interface StudentRepository", "    extends JpaRepository {", "}"], { highlight: [1] }) });
add("JpaRepository uses generics, and wants two things: which entity, and the type of its primary key.", { pose: "present", ...snap("StudentRepository.java", "java", REPO_LINES, { highlight: [1] }) });
add("Our entity is Student, and its primary key is a Long.", { pose: "point", ...snap("StudentRepository.java", "java", REPO_LINES, { highlight: [1], animate: "lines" }) });
add("That is the whole repository. No methods, and no code inside.", { pose: "smug", mood: "excited", ...snap("StudentRepository.java", "java", REPO_LINES, { highlight: [0, 1, 2], animate: "lines" }) });
add("Why an interface? If it were a class, we would write every query ourselves.", { pose: "think", ...compare("versus", [{ title: "Class", points: ["You write the queries", "Insert into student..."] }, { title: "Interface", points: ["Spring writes the code", "You only call methods"] }]) });
add("Because it extends JpaRepository, all the ready-made methods come along.", { pose: "present", ...flow(["JpaRepository", "StudentRepository"], 1, "methods") });
add("Open the save method, and you find a CrudRepository interface. It holds the basics.", { pose: "point", ...steps(["CrudRepository", "ListCrudRepository", "JpaRepository", "StudentRepository"], 0) });
add("JpaRepository extends ListCrudRepository, which extends CrudRepository.", { pose: "present", ...steps(["CrudRepository", "ListCrudRepository", "JpaRepository", "StudentRepository"], 2) });
add("A whole hierarchy. Each level adds methods, and our repository inherits all of them.", { pose: "point", ...steps(["CrudRepository", "ListCrudRepository", "JpaRepository", "StudentRepository"], 3) });
add("There are more, like saveAll for many records, and saveAndFlush. We will meet them later.", { pose: "shrug" });
add("Wait. An interface has no code. Who implements these methods?", { pose: "think", mood: "confused", props: [{ type: "question" }] });
add("Normally you must implement every method of an interface. Here, we implement nothing.", { pose: "present", ...code("StudentRepositoryImpl.java", "java", ["// what you would normally write:", "public class StudentRepositoryImpl", "    implements StudentRepository {", "  @Override", "  public Student save(Student s) { ... }", "}"], { animate: "lines" }) });
add("Spring Data JPA writes the implementation for us, at runtime.", { pose: "smug", mood: "excited", ...flow(["Your interface", "Spring Data JPA", "Generated class"], 2, "runtime") });
add("It creates the bean, stores it in the IoC container, and manages it. We do nothing.", { pose: "point", ...scene("lab", [{ asset: "gear", x: 28, y: 52, size: 40, label: "Spring Data JPA" }, { asset: "server", x: 72, y: 52, size: 40, label: "IoC container", tint: "blue" }], [{ from: [42, 52], to: [58, 52] }]) });
add("An empty interface, and yet every database method works. That is the magic.", { pose: "celebrate", mood: "excited" });
add("You may see a Repository annotation on repositories. For this interface, it makes no difference.", { pose: "present", ...compare("versus", [{ title: "@Repository", points: ["Marks a repository", "Clear for teammates"] }, { title: "Our interface", points: ["No annotation needed", "JPA creates the bean"] }]) });
add("An interface cannot become a bean on its own, but the generated class can.", { pose: "point" });
add("We will use the Repository annotation later, when we write our own repository classes.", { pose: "smug" });
add("That is useful for complicated queries, such as joins, which the ready-made methods do not cover.", { pose: "present", ...table("When to write your own", ["need", "approach"], [["Basic CRUD", "JpaRepository methods"], ["Own query methods", "Declare in interface"], ["Complex joins", "Write the query"]], 0) });
add("For now, the ready-made methods are all we need.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 5 · Using save in the service ═══════════════════════
chapter("5 · Using save in the service", "office");
add("Now the service. It currently calls a method that no longer exists, so there is an error.", { pose: "point", ...alert("error", "Cannot find saveStudent", "Repository is now an interface") });
add("Replace it with the repository's save method, and pass the incoming student.", { pose: "present", ...snap("StudentService.java", "java", ["public Student createStudent(Student request) {", "  return studentRepository.save(request);", "}"], { highlight: [1] }) });
add("Save returns the stored student, and the service passes it straight back.", { pose: "point", ...snap("StudentService.java", "java", ["public Student createStudent(Student request) {", "  Student saved = studentRepository.save(request);", "  return saved;", "}"], { highlight: [1, 2] }) });
add("The error is gone. Save is available on our interface through the hierarchy we just saw.", { pose: "smug", mood: "happy" });
add("The primary key must be generated by the database, so add Generated Value with the identity strategy.", { pose: "present", ...snap("Student.java", "java", ["@Id", "@GeneratedValue(strategy =", "    GenerationType.IDENTITY)", "private Long id;"], { highlight: [1, 2] }) });
add("Then we never send an id when creating a student. The database counts upward for us.", { pose: "point", mood: "happy" });

// ═══════════════════════ 6 · Connect to MySQL ═══════════════════════
chapter("6 · Connect to MySQL", "office");
add("Next, connect the application to MySQL. This takes a few settings.", { pose: "present", ...steps(["Create the database", "Open a DBeaver connection", "Add four properties", "Remove the exclude"], 0) });
add("First check that MySQL is installed. In a terminal, ask for the version.", { pose: "point", ...term(["$ mysql --version", "mysql  Ver 8.x for macos"], "Terminal") });
add("Then connect with the root user and your password, using dash u and dash p.", { pose: "present", ...term(["$ mysql -u root -p", "Enter password: ******", "mysql>"], "Terminal") });
add("Show databases lists them all. Use a database name to switch to it.", { pose: "point", ...term(["mysql> SHOW DATABASES;", "mysql> USE student_crud_db;", "mysql> SHOW TABLES;", "Empty set"], "MySQL") });
add("But we want a visual tool, so open DBeaver and click New Database Connection.", { pose: "present", ...steps(["New Database Connection", "Choose MySQL", "Host, port, user, password", "Test connection"], 0) });
add("Choose MySQL, then Next. It asks for a host, a port, a username, and a password.", { pose: "point", ...steps(["New Database Connection", "Choose MySQL", "Host, port, user, password", "Test connection"], 2) });
add("The host is localhost. MySQL listens on port 3306 by default, just as our server uses 8080.", { pose: "present", ...table("Ports", ["program", "port"], [["Spring Boot server", "8080"], ["MySQL server", "3306"]], 1) });
add("Leave the database name empty, because we will create it ourselves.", { pose: "point" });
add("The username is root, and the password is the one you set when installing MySQL.", { pose: "present", ...steps(["Host: localhost", "Port: 3306", "User: root", "Password: your own"], 3) });
add("A simple password is fine on a laptop, but never on a production server.", { pose: "smug", mood: "worried", props: [{ type: "warning" }] });
add("Press Test Connection. When it says connected, finish the setup.", { pose: "present", mood: "happy", ...alert("success", "Connected", "localhost:3306") });
add("Open the connection, and you see your databases. Ours does not exist yet, so we create it.", { pose: "point", ...steps(["Open SQL editor", "CREATE DATABASE", "Select and run", "Refresh"], 1) });
add("One query is enough: create database student crud db.", { pose: "present", ...code("create-db.sql", "text", ["CREATE DATABASE student_crud_db;"], { animate: "type" }) });
add("Run it, refresh, and the new database appears. Its tables list is empty.", { pose: "point", ...table("student_crud_db", ["tables"], [["(none yet)"]], 0) });
add("Do we create the student table by hand? No. JPA will create it for us.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });
add("The only thing we ever create ourselves is the database.", { pose: "point" });

// ═══════════════════════ 7 · application.properties ═══════════════════════
chapter("7 · application.properties", "office");
add("Now tell Spring Boot how to reach it. All these key value pairs go in application dot properties.", { pose: "present", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo"], { animate: "lines" }) });
add("The first key is the data source URL, a JDBC address that starts with jdbc colon mysql.", { pose: "point", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_URL], { highlight: [1, 2] }) });
add("Then the host, localhost, the port, 3306, and finally the database name.", { pose: "present", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_URL], { highlight: [2], animate: "lines" }) });
add("In production, you would swap localhost for the address of your MySQL server.", { pose: "smug" });
add("The URL tells Spring Boot which database to connect to. It also needs credentials.", { pose: "point", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_USER], { highlight: [3, 4] }) });
add("So we add the username, root, and the password. Use whatever you chose.", { pose: "present", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_USER], { highlight: [3, 4], animate: "lines" }) });
add("With these three, Spring Boot can open a connection, exactly as we did in DBeaver.", { pose: "smug", mood: "happy" });
add("Remember the auto-configuration error from last time, when the data source had no URL?", { pose: "think", ...alert("error", "Failed to configure a DataSource", "'url' attribute is not specified") });
add("These settings fix that error for good, so the exclude we added earlier can go.", { pose: "point", mood: "happy" });
add("The fourth key is ddl auto, set to update. It controls how tables are created.", { pose: "present", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_DDL], { highlight: [5] }) });
add("It tells Hibernate, the engine under JPA, that it may create and change tables for us.", { pose: "point", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_DDL], { highlight: [5], animate: "lines" }) });
add("From the Student class, it builds a table. The class name becomes the table name.", { pose: "present", ...flow(["Student class", "Hibernate", "student table"], 1, "DDL") });
add("Every field becomes a column: id, name, age, email, roll number, and subject.", { pose: "point", ...table("student", ["id", "name", "age", "email", "roll_number", "subject"], [["-", "-", "-", "-", "-", "-"]], 0) });
add("Other values exist, like create, create drop, and none. We cover them with Hibernate.", { pose: "shrug" });
add("For now, update means: if my structure changes, change the table to match.", { pose: "smug" });
add("In the main class, remove the exclude and its brackets. Keep only Spring Boot Application.", { pose: "present", ...snap("CrudSpringBootDemoApplication.java", "java", ["@SpringBootApplication", "public class CrudSpringBootDemoApplication {", "  public static void main(String[] args) {", "    SpringApplication.run(", "      CrudSpringBootDemoApplication.class, args);", "  }", "}"], { highlight: [0] }) });
add("Also delete the Hello World line. We do not need it anymore.", { pose: "point" });

// ═══════════════════════ 8 · First run ═══════════════════════
chapter("8 · First run", "stage");
add("Start the application. Before it does anything, the student table is empty or missing.", { pose: "present", ...term(["Started CrudSpringBootDemoApplication", "Tomcat started on port 8080"]) });
add("Refresh DBeaver, and the student table has appeared on its own, with every column.", { pose: "celebrate", mood: "excited", ...table("student", ["id", "age", "email", "name", "roll_number", "subject"], [["-", "-", "-", "-", "-", "-"]], 0) });
add("We wrote no create table query. Hibernate read our Student entity and built it.", { pose: "smug", mood: "happy" });
add("Where is that query? To see it, add one more property: show sql, set to true.", { pose: "point", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_ALL.slice(0, 6), "spring.jpa.show-sql=true"], { highlight: [6] }) });
add("It prints every query the application runs. The default is false.", { pose: "present", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_ALL.slice(0, 6), "spring.jpa.show-sql=true"], { highlight: [6], animate: "lines" }) });
add("Restart, drop the table first, and then the create table query appears in the log.", { pose: "point", ...term(["Hibernate: create table student (", "  id bigint not null auto_increment,", "  age integer,", "  email varchar(255),", "  name varchar(255),", "  primary key (id))"]) });
add("It is messy to read, so add a format property to make the query pretty.", { pose: "present", ...snap("application.properties", "properties", ["spring.application.name=crud-spring-boot-demo", ...PROPS_ALL], { highlight: [7] }) });
add("The key is long, and nobody memorises it. Copy it from the notes whenever you need it.", { pose: "shrug", mood: "happy" });
add("Restart once more. The create table query is now neatly formatted, with a primary key on id.", { pose: "present", ...term(["Hibernate:", "    create table student (", "        id bigint not null auto_increment,", "        age integer,", "        primary key (id)", "    )"]) });
add("All of this came from one annotated class, the Student entity.", { pose: "smug" });

// ═══════════════════════ 9 · Create ═══════════════════════
chapter("9 · Create", "office");
add("Now test create. In Postman, send a POST to the create endpoint with the first student.", { pose: "present", ...browser("POST localhost:8080/api/students/create", "json", POST_JSON) });
add("Two hundred and one created, and the response holds the stored student, with its new id.", { pose: "celebrate", mood: "happy", ...alert("success", "201 Created", "Body: the saved student, with an id") });
add("Refresh the database, and the first row is there. Our very first stored value.", { pose: "present", mood: "excited", ...table("student", ["id", "name", "age", "email"], [["1", "Aditya", "28", "aditya@gmail.com"]], 0) });
add("Now look at the log. First comes a select, then an insert.", { pose: "point", ...term(["Hibernate: select s1_0.id, ... from student s1_0", "  where s1_0.id=?", "Hibernate: insert into student", "  (age, email, name, roll_number, subject)", "  values (?, ?, ?, ?, ?)"], "Server log") });
add("The question marks are filled with the values from our Student object.", { pose: "present" });
add("Why a select first? Save checks whether this record already exists.", { pose: "think", ...flow(["save(student)", "select by id", "found?"], 1, "check") });
add("If it does not exist, it runs insert. If it does, it runs update instead.", { pose: "point", ...compare("versus", [{ title: "Not found", points: ["INSERT a new row"] }, { title: "Found", points: ["UPDATE the row"] }]) });
add("That is how one save method handles both creating and updating.", { pose: "smug", mood: "happy" });
add("Send a second student, Rohit, with different details. A second row appears.", { pose: "present", ...table("student", ["id", "name", "age", "roll_number"], [["1", "Aditya", "28", "1001"], ["2", "Rohit", "29", "102"]], 1) });

// ═══════════════════════ 10 · Read one ═══════════════════════
chapter("10 · Read one", "office");
add("Next, read one record. The create method is the pattern, so we add a get method beside it.", { pose: "present", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get/{id}\")", "  public ResponseEntity<Student> getStudent(", "      @PathVariable Long id) {", "  }"], { highlight: [0, 2] }) });
add("It is a GET request, so we use Get Mapping, and the path is slash get slash id.", { pose: "point", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get/{id}\")", "  public ResponseEntity<Student> getStudent(", "      @PathVariable Long id) {", "  }"], { highlight: [0], animate: "lines" }) });
add("But the id changes with each request. It cannot be hard-coded into the URL.", { pose: "think", mood: "worried" });
add("So the id travels as a path variable, written inside curly braces.", { pose: "present", ...browser("GET localhost:8080/api/students/get/1", "page", ["Path: /api/students/get/1", "{id} = 1", "Path variable"], "Request") });
add("There is another way, called query parameters: a question mark, then id equals one.", { pose: "point", ...browser("GET /api/students/get?id=1&name=Aditya", "page", ["Query parameters", "id = 1", "name = Aditya"], "Request") });
add("You can send several of them. We will use path variables today, and meet query parameters later.", { pose: "present", mood: "happy" });
add("To receive the path variable, the method takes a Long id with the Path Variable annotation.", { pose: "point", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get/{id}\")", "  public ResponseEntity<Student> getStudent(", "      @PathVariable Long id) {", "    Student student = studentService.getStudent(id);", "    return ResponseEntity.ok(student);", "  }"], { highlight: [2, 3, 4] }) });
add("Compare it with Request Body: that one maps a JSON body, this one maps a piece of the URL.", { pose: "present", ...compare("versus", [{ title: "@RequestBody", points: ["JSON in the body", "Becomes an object"] }, { title: "@PathVariable", points: ["Part of the URL", "Becomes the id"] }]) });
add("The controller then asks the service for the student with that id.", { pose: "point" });
add("In the service, call the repository's find by id method.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student getStudent(Long id) {", "    studentRepository.findById(id);", "  }"], { highlight: [1] }) });
add("Assign the result to a Student, and the compiler complains. It returns something else.", { pose: "shrug", mood: "confused", ...alert("error", "Type mismatch", "Optional<Student> cannot become Student") });
add("What does it return?", { pose: "think", ...quiz("What does findById return?", ["Student, or null", "Optional<Student>", "A list of students", "A boolean"], 1, 0.7) });
add("An Optional is a safe box. Inside there may be a student, or nothing at all.", { pose: "present", ...compare("versus", [{ title: "Id 1", points: ["Box holds a student"] }, { title: "Id 3", points: ["Box is empty", "No NullPointerException"] }]) });
add("We have two students, with ids one and two. Ask for id three, and no record exists.", { pose: "point", ...table("student", ["id", "name"], [["1", "Aditya"], ["2", "Rohit"]], 1) });
add("Returning null would be dangerous. The Optional keeps us safe.", { pose: "smug" });
add("So take the Optional, and check is present. If it is, return what is inside.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student getStudent(Long id) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isPresent()) {", "      return found.get();", "    }", "    return null;", "  }"], { highlight: [3, 4] }) });
add("Get returns the student from the box. Otherwise, we return null.", { pose: "point", ...snap("StudentService.java", "java", ["  public Student getStudent(Long id) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isPresent()) {", "      return found.get();", "    }", "    return null;", "  }"], { highlight: [4, 6], animate: "lines" }) });
add("Restart, and send a GET for student one. Nothing comes back, but the status is not found.", { pose: "present", ...alert("error", "404 Not Found", "The URL matched no endpoint yet") });
add("The path variable was never named in the mapping. The URL has no id placeholder in it.", { pose: "think", mood: "worried" });
add("The fix: put the id in curly braces in the mapping, so Spring can read it from the URL.", { pose: "point", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get/{id}\")", "  public ResponseEntity<Student> getStudent(", "      @PathVariable Long id) {"], { highlight: [0] }) });
add("Without the braces, the URL slash get slash one matches nothing, so you get a four oh four.", { pose: "smug" });
add("Restart, and send the request again. We get Aditya's record in full.", { pose: "celebrate", mood: "happy", ...browser("200 OK", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"age\": 28", "}"]) });
add("The log shows one select, with a where clause on the id.", { pose: "present", ...term(["Hibernate: select s1_0.id, s1_0.age ...", "  from student s1_0 where s1_0.id=?"], "Server log") });
add("Ask for id two, and Rohit appears. Ask for id three, and we still get two hundred OK. That is wrong.", { pose: "point", mood: "worried", ...alert("warning", "200 OK for a missing record", "It should be 404 Not Found") });
add("If nothing was found, the client must hear not found. So we check the result in the controller.", { pose: "present", ...snap("StudentController.java", "java", ["    Student student = studentService.getStudent(id);", "    if (student == null) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(student);", "  }"], { highlight: [1, 2] }) });
add("Not found is a ready-made response. Call build, and the body stays empty.", { pose: "point", ...snap("StudentController.java", "java", ["    if (student == null) {", "      return ResponseEntity.notFound().build();", "    }"], { highlight: [1], animate: "lines" }) });
add("Now id three returns four oh four, and ids one and two still return two hundred.", { pose: "celebrate", mood: "happy", ...table("Responses", ["id", "status"], [["1", "200 OK"], ["2", "200 OK"], ["3", "404 Not Found"]], 2) });

// ═══════════════════════ 11 · Read all ═══════════════════════
chapter("11 · Read all", "office");
add("Now read every student. The endpoint is slash get all, and it takes no id.", { pose: "present", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get-all\")", "  public ResponseEntity<List<Student>> getAll() {", "  }"], { highlight: [0, 1] }) });
add("It returns a list of students, so the response type is a Response Entity of List of Student.", { pose: "point", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get-all\")", "  public ResponseEntity<List<Student>> getAll() {", "  }"], { highlight: [1], animate: "lines" }) });
add("No path variable, no body. The method calls the service's get all students.", { pose: "present", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get-all\")", "  public ResponseEntity<List<Student>> getAll() {", "    List<Student> students =", "      studentService.getAllStudents();", "    return ResponseEntity.ok(students);", "  }"], { highlight: [2, 3] }) });
add("If the list is empty, we should answer not found. Otherwise we return the whole list.", { pose: "point", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get-all\")", "  public ResponseEntity<List<Student>> getAll() {", "    List<Student> students =", "      studentService.getAllStudents();", "    if (students.isEmpty()) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(students);", "  }"], { highlight: [4, 5] }) });
add("In the service, the repository already has a find all method.", { pose: "present", ...snap("StudentService.java", "java", ["  public List<Student> getAllStudents() {", "    return studentRepository.findAll();", "  }"], { highlight: [1] }) });
add("It returns a list of students, which we simply pass back.", { pose: "smug", mood: "happy" });
add("Restart, and send a GET to slash get all. No body, no variables.", { pose: "present", ...browser("GET localhost:8080/api/students/get-all", "json", ["[", "  { \"id\": 1, \"name\": \"Aditya\" },", "  { \"id\": 2, \"name\": \"Rohit\" }", "]"]) });
add("Both students arrive in a list. Read all works.", { pose: "celebrate", mood: "happy" });

// ═══════════════════════ 12 · Update ═══════════════════════
chapter("12 · Update", "office");
add("Now update. An update changes an existing record, so the HTTP method is PUT.", { pose: "present", ...snap("StudentController.java", "java", ["  @PutMapping(\"/update/{id}\")", "  public ResponseEntity<Student> update(", "      @PathVariable Long id,", "      @RequestBody Student studentRequest) {", "  }"], { highlight: [0] }) });
add("The mapping is Put Mapping, with the path slash update slash id.", { pose: "point", ...snap("StudentController.java", "java", ["  @PutMapping(\"/update/{id}\")", "  public ResponseEntity<Student> update(", "      @PathVariable Long id,", "      @RequestBody Student studentRequest) {", "  }"], { highlight: [0], animate: "lines" }) });
add("Two inputs: the id of the student to change, and the new details, sent as a JSON body.", { pose: "present", ...steps(["Path variable: which student", "Request body: new details"], 1) });
add("So we need both annotations: Path Variable for the id, Request Body for the student.", { pose: "point", ...snap("StudentController.java", "java", ["  @PutMapping(\"/update/{id}\")", "  public ResponseEntity<Student> update(", "      @PathVariable Long id,", "      @RequestBody Student studentRequest) {", "  }"], { highlight: [2, 3], animate: "lines" }) });
add("The controller asks the service to update the student, and checks the result.", { pose: "present", ...snap("StudentController.java", "java", ["  @PutMapping(\"/update/{id}\")", "  public ResponseEntity<Student> update(", "      @PathVariable Long id,", "      @RequestBody Student studentRequest) {", "    Student updated =", "      studentService.updateStudent(id, studentRequest);", "    if (updated == null) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(updated);", "  }"], { highlight: [4, 5, 6] }) });
add("If the service returns null, the record does not exist, so we answer not found.", { pose: "point", ...snap("StudentController.java", "java", ["    if (updated == null) {", "      return ResponseEntity.notFound().build();", "    }"], { highlight: [0, 1], animate: "lines" }) });
add("The service first looks for the existing student, using find by id.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isEmpty()) {", "      return null;", "    }", "  }"], { highlight: [1, 2, 3, 4] }) });
add("If the box is empty, there is nothing to update, so we return null.", { pose: "point", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isEmpty()) {", "      return null;", "    }", "  }"], { highlight: [3, 4], animate: "lines" }) });
add("A cleaner design hands the Optional straight to the controller. We keep it simple for now.", { pose: "shrug" });
add("Otherwise, take the stored student out of the box, and call it the one to save.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isEmpty()) {", "      return null;", "    }", "    Student toSave = found.get();", "  }"], { highlight: [6] }) });
add("Then copy the new details onto it, one field at a time: name, age, email, roll number, subject.", { pose: "point", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isEmpty()) {", "      return null;", "    }", "    Student toSave = found.get();", "    toSave.setName(req.getName());", "    toSave.setAge(req.getAge());", "    // email, rollNumber and subject the same way", "  }"], { highlight: [7, 8, 9] }) });
add("We do not touch the id. Whatever id arrives, the stored one stays the same.", { pose: "smug", mood: "happy" });
add("Finally, call save with the updated student, and return the result.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> found =", "      studentRepository.findById(id);", "    if (found.isEmpty()) {", "      return null;", "    }", "    Student toSave = found.get();", "    toSave.setName(req.getName());", "    toSave.setAge(req.getAge());", "    // email, rollNumber and subject the same way", "    return studentRepository.save(toSave);", "  }"], { highlight: [10] }) });
add("Save sees an existing id, so it runs an update and not an insert.", { pose: "point", ...compare("versus", [{ title: "Id exists", points: ["save runs UPDATE"] }, { title: "No id", points: ["save runs INSERT"] }]) });
add("Test it. Rohit has age twenty nine and roll number one oh two. We change them.", { pose: "present", ...table("student", ["id", "name", "age", "roll_number"], [["1", "Aditya", "28", "1001"], ["2", "Rohit", "29", "102"]], 1) });
add("Send a PUT for id two, with age twenty eight and roll number one oh five.", { pose: "point", ...browser("PUT localhost:8080/api/students/update/2", "json", ["{", "  \"name\": \"Rohit\",", "  \"age\": 28,", "  \"rollNumber\": 105,", "  \"subject\": \"MERN\"", "}"]) });
add("A typo in the path gives a four oh four. Fix the spelling, and send it again.", { pose: "think", mood: "worried" });
add("This time it succeeds. In the database, Rohit is now twenty eight, with roll number one oh five.", { pose: "celebrate", mood: "happy", ...table("student", ["id", "name", "age", "roll_number"], [["1", "Aditya", "28", "1001"], ["2", "Rohit", "28", "105"]], 1) });
add("The log shows the update query. The same save method, doing a different job.", { pose: "smug", ...term(["Hibernate: select ... from student where id=?", "Hibernate: update student", "  set age=?, email=?, name=?, roll_number=?", "  where id=?"], "Server log") });

// ═══════════════════════ 13 · Delete ═══════════════════════
chapter("13 · Delete", "office");
add("The last operation is delete. The HTTP method is DELETE, and the path is slash delete slash id.", { pose: "present", ...snap("StudentController.java", "java", ["  @DeleteMapping(\"/delete/{id}\")", "  public ResponseEntity<String> delete(", "      @PathVariable Long id) {", "  }"], { highlight: [0] }) });
add("The id arrives as a path variable again, and there is no body.", { pose: "point", ...snap("StudentController.java", "java", ["  @DeleteMapping(\"/delete/{id}\")", "  public ResponseEntity<String> delete(", "      @PathVariable Long id) {", "  }"], { highlight: [2], animate: "lines" }) });
add("The service tells us whether the delete worked, with a boolean named is deleted.", { pose: "present", ...snap("StudentController.java", "java", ["  @DeleteMapping(\"/delete/{id}\")", "  public ResponseEntity<String> delete(", "      @PathVariable Long id) {", "    boolean isDeleted =", "      studentService.deleteStudent(id);", "  }"], { highlight: [3, 4] }) });
add("If it is false, the record was never there, so we return not found.", { pose: "point", ...snap("StudentController.java", "java", ["  @DeleteMapping(\"/delete/{id}\")", "  public ResponseEntity<String> delete(", "      @PathVariable Long id) {", "    boolean isDeleted =", "      studentService.deleteStudent(id);", "    if (!isDeleted) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(\"Record deleted\");", "  }"], { highlight: [5, 6] }) });
add("Otherwise we return two hundred, with the message: record deleted.", { pose: "present", ...snap("StudentController.java", "java", ["    if (!isDeleted) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(\"Record deleted\");"], { highlight: [3], animate: "lines" }) });
add("A message is friendlier than true or false, so the body is a string.", { pose: "smug", mood: "happy" });
add("In the service, first ask the repository whether the id exists, using exists by id.", { pose: "present", ...snap("StudentService.java", "java", ["  public boolean deleteStudent(Long id) {", "    boolean exists =", "      studentRepository.existsById(id);", "    if (!exists) {", "      return false;", "    }", "  }"], { highlight: [1, 2] }) });
add("If it does not exist, return false. That false travels up, and becomes a four oh four.", { pose: "point", ...flow(["Service: false", "Controller", "404 Not Found"], 2, "false") });
add("If it exists, call delete by id. It returns nothing, so we return true ourselves.", { pose: "present", ...snap("StudentService.java", "java", ["  public boolean deleteStudent(Long id) {", "    boolean exists =", "      studentRepository.existsById(id);", "    if (!exists) {", "      return false;", "    }", "    studentRepository.deleteById(id);", "    return true;", "  }"], { highlight: [6, 7] }) });
add("Restart, and try deleting id three, which does not exist. Four oh four, and nothing else happens.", { pose: "point", ...alert("error", "404 Not Found", "No record with id 3") });
add("Now delete id two, Rohit. We get: record deleted.", { pose: "present", mood: "happy", ...alert("success", "Record deleted", "DELETE /api/students/delete/2") });
add("Refresh the database, and Rohit's row is gone. Delete works.", { pose: "celebrate", mood: "happy", ...table("student", ["id", "name", "age"], [["1", "Aditya", "28"]], 0) });

// ═══════════════════════ 14 · Recap ═══════════════════════
chapter("14 · Recap and next steps", "stage");
const RECAP = ["JpaRepository gives save, findAll, findById", "Extend it: no SQL, no implementation", "Four properties connect Spring Boot to MySQL", "Path variable, request body, ResponseEntity", "Not found when nothing exists"];
add("Let us recap with five ideas.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: JpaRepository gives us ready-made methods, so we write no queries.", { pose: "point", ...steps(RECAP, 0) });
add("Two: an empty interface that extends it is enough, because Spring writes the implementation at runtime.", { pose: "point", ...steps(RECAP, 1) });
add("Three: four properties connect Spring Boot to MySQL, and ddl auto creates the table.", { pose: "point", ...steps(RECAP, 2) });
add("Four: path variables and request bodies carry the input, and Response Entity chooses the status.", { pose: "point", ...steps(RECAP, 3) });
add("Five: when nothing is found, answer with four oh four.", { pose: "point", ...steps(RECAP, 4) });
add("We built create, read one, read all, update, and delete, all stored in MySQL.", { pose: "smug", mood: "happy", ...steps(["Create", "Read one", "Read all", "Update", "Delete"], 4) });
add("You can add more, like delete all, or update many records at once.", { pose: "present", mood: "happy" });
add("Next time we meet soft delete. Instead of erasing a row, we mark it as deleted.", { pose: "present", mood: "excited", ...table("student", ["id", "name", "is_deleted"], [["1", "Aditya", "1"]], 0) });
add("It is the habit of real applications, and it changes how fetching and updating work.", { pose: "point" });
const TASK = ["Add a delete-all endpoint", "Return 404 when nothing exists", "Test it with Postman"];
add("Your challenge: add a delete all endpoint, without looking at the code.", { pose: "smug", mood: "excited", ...steps(TASK, 0) });
add("Use a ready-made repository method, answer not found when nothing exists, and test it.", { pose: "point", ...steps(TASK, 2) });
add("Thanks for watching, and see you in the next lesson.", { pose: "celebrate", mood: "happy" });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "Spring Boot CRUD Project with MySQL | Spring JPA Methods | Spring Boot Full Course #12",
  description:
    "Finish the Spring Boot CRUD project from the last lesson with a real MySQL database. You will learn how Spring Data JPA gives you save, findAll, findById, deleteById and existsById without writing SQL, " +
    "why the repository is just an interface that extends JpaRepository, how to connect Spring Boot to MySQL with four properties, how ddl auto creates the table for you, and how to build the read, update and delete endpoints " +
    "with path variables, request bodies, Optional and Response Entity (including 404 Not Found).\n\n" +
    "Chapters: 1 Where we left off | 2 Clean up | 3 Repository methods | 4 The repository interface | 5 Using save in the service | 6 Connect to MySQL | 7 application.properties | 8 First run | 9 Create | 10 Read one | 11 Read all | 12 Update | 13 Delete | 14 Recap\n\n" +
    "Based on Spring Boot Full Course Lecture 12 (Hindi). Next video: soft delete.\n\n#SpringBoot #Java #SpringDataJPA #CodeOrCap",
  tags: ["Spring Boot", "Spring Data JPA", "JpaRepository", "CRUD", "MySQL", "REST API", "Spring Boot tutorial", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "spring12-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
