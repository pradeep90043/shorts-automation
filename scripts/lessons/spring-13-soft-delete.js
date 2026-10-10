// Generates the plan-only JSON for the 20-minute interactive English tutorial:
// "Spring Boot CRUD Project with Soft Delete: Spring JPA Custom Methods" (Spring Boot Full Course #13)
// Sources: the lecture transcript (.srt) and the course repo (adityatandon15/Spring-Framework-Full-Course, Lecture 13 code).
// Class names, endpoints, method names, queries and test results come from them. Interactive parts: "pause and think"
// quizzes and "your turn" challenges.
// Known repo discrepancy, called out in the lesson: Lecture 13's StudentService.getStudent calls plain findById, but
// the video shows (and the soft-delete rule needs) findByIdAndDeletedIsFalse.
//   node spring-13-soft-delete.js out.json
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

const COLS = ["id", "name", "roll_no", "deleted"];
const ENDPOINTS = [["POST", "/create", "create"], ["GET", "/get?id=1", "read one"], ["GET", "/getAll", "read all"], ["PUT", "/update?id=1", "update"], ["DELETE", "/delete?id=1", "hard delete"], ["PATCH", "/delete-soft?id=1", "soft delete"]];
const STUDENT = ["@Entity", "public class Student {", "  @Id", "  private Long id;", "  private String name;", "  private int age;", "  private String email;", "  private int rollNo;", "  private String subject;", "}"];
const STUDENT_DEL = ["@Entity", "public class Student {", "  @Id", "  private Long id;", "  private String name;", "  private int age;", "  private String email;", "  private int rollNo;", "  private String subject;", "  private Boolean deleted;", "}"];
const STUDENT_GEN = ["@Entity", "public class Student {", "  @Id", "  @GeneratedValue(strategy = GenerationType.IDENTITY)", "  private Long id;", "  private String name;", "  private int age;", "  private String email;", "  private int rollNo;", "  private String subject;", "  private Boolean deleted;", "}"];
const REPO_1 = ["public interface StudentRepository", "    extends JpaRepository<Student, Long> {", "}"];
const REPO_2 = ["public interface StudentRepository", "    extends JpaRepository<Student, Long> {", "", "  Optional<Student> findByIdAndDeletedIsFalse(Long id);", "}"];
const REPO_3 = ["public interface StudentRepository", "    extends JpaRepository<Student, Long> {", "", "  Optional<Student> findByIdAndDeletedIsFalse(Long id);", "", "  List<Student> findByDeletedIsFalse();", "}"];
const POST_JSON = ["{", "  \"name\": \"Rahul\",", "  \"email\": \"rahul@gmail.com\",", "  \"age\": 29,", "  \"rollNo\": 103,", "  \"subject\": \"Django\"", "}"];

// ═══════════════════════ 1 · Where we are ═══════════════════════
chapter("1 · Where we are", "stage");
add("Today we upgrade our CRUD project with something real applications do all the time: soft delete.", { pose: "present", mood: "excited", ...steps(["Hard delete vs soft delete", "A deleted field", "Custom repository methods", "Request parameters"], 0) });
add("It is a topic few courses cover, yet companies use it constantly.", { pose: "point", mood: "happy" });
add("We continue the project from the last two lessons: controller, service, repository, entity, and MySQL.", { pose: "present", ...flow(["Controller", "Service", "Repository", "MySQL"], 3, "Student") });
add("If you missed them, watch those first, or download the project from the course repository.", { pose: "point" });
add("This lesson is interactive. Whenever a question appears, pause and answer before the reveal.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });
add("By the end, you will soft delete a record, hide it from every read, and still delete it for good when you must.", { pose: "present", mood: "excited", ...steps(["Soft delete a record", "Hide it from reads", "Hard delete when needed"], 2) });

// ═══════════════════════ 2 · Hard delete vs soft delete ═══════════════════════
chapter("2 · Hard delete vs soft delete", "classroom");
add("Start with how delete has worked so far. The database holds a student: id one, Aditya, roll number 1001.", { pose: "present", ...table("student", ["id", "name", "roll_no"], [["1", "Aditya", "1001"]], 0) });
add("We ask JPA to delete by id, and it runs a query that removes the row.", { pose: "point", ...term(["Hibernate: delete from student where id=?"], "Server log") });
add("The record is gone from the database. That is called a hard delete.", { pose: "present", mood: "worried", ...table("student", ["id", "name", "roll_no"], [["-", "-", "-"]], 0) });
add("In SQL terms, a hard delete is a delete statement, and it removes the row.", { pose: "point", ...code("hard-delete.sql", "text", ["DELETE FROM student", "WHERE id = 1;"], { highlight: [0], animate: "type" }) });
add("A hard delete removes the data directly from the database, and there is no way back.", { pose: "point", ...alert("warning", "Hard delete", "Row removed directly from the database") });
add("Is that a problem? Tomorrow you may need every user who ever left your platform.", { pose: "think", mood: "worried" });
add("Real applications keep records, pull logs, and sometimes recover old accounts.", { pose: "present", ...steps(["Keep records", "Pull logs", "Recover accounts", "Lock accounts"], 3) });
add("So instead, we use a soft delete. We do not erase the row.", { pose: "smug", mood: "happy" });
add("We add one extra column, named deleted, which is zero by default.", { pose: "present", ...table("student", COLS, [["1", "Aditya", "1001", "0"]], 0) });
add("Zero means active. The record has not been deleted.", { pose: "point", mood: "happy" });
add("Now add a second student, Rohit, but with the deleted flag set to one.", { pose: "present", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "1"]], 1) });
add("One means deleted. Rohit is still in the table, but marked as deleted.", { pose: "point", mood: "worried", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "1"]], 1) });
add("A soft delete is only an update statement. It flips the flag, and keeps the row.", { pose: "present", ...code("soft-delete.sql", "text", ["UPDATE student", "SET deleted = 1", "WHERE id = 2;"], { highlight: [1], animate: "type" }) });
add("So a soft delete means: mark the record as deleted, and do not remove it.", { pose: "smug", ...compare("versus", [{ title: "Hard delete", points: ["Row removed", "No way back"] }, { title: "Soft delete", points: ["Row stays", "deleted = 1", "Can be recovered"] }]) });
add("Question time. Someone asks for the student with id two. What should we say?", { pose: "think", ...quiz("Rohit has deleted = 1. A client asks for id 2. What do we answer?", ["Return Rohit", "Not found", "Delete the row now", "Return an empty list"], 1, 0.7) });
add("Not found. For us, a soft-deleted record no longer exists, even though it is physically there.", { pose: "present", mood: "happy", ...alert("error", "404 Not Found", "id 2 is soft deleted") });
add("It also cannot be updated, because to us the record does not exist.", { pose: "point", ...steps(["Read: not found", "Update: not found", "Read all: hidden", "Soft delete again: not found"], 1) });
add("And a read-all request must leave Rohit out of the list.", { pose: "point", ...steps(["Read: not found", "Update: not found", "Read all: hidden", "Soft delete again: not found"], 2) });
add("So a deleted record takes part in no CRUD operation at all.", { pose: "smug", mood: "excited" });
add("Meanwhile it stays in the database for locking, reports, and recovery.", { pose: "present", ...steps(["Locking accounts", "Reports and logs", "Recovering a user"], 2) });
add("Why keep it? Disk space is cheap, and data is valuable. You can always count your active users.", { pose: "point", mood: "happy" });
add("Hard delete still has its place, when you know the data will never be useful again.", { pose: "shrug" });
add("But in enterprise projects, soft delete is the default choice.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 3 · Add the deleted field ═══════════════════════
chapter("3 · Add the deleted field", "office");
add("Let us build it. Open the Student entity. It has an id, a name, an age, an email, a roll number, and a subject.", { pose: "present", ...snap("Student.java", "java", STUDENT) });
add("Nothing here marks a record as deleted. So we add one more field.", { pose: "point", ...snap("Student.java", "java", STUDENT, { animate: "lines", highlight: [8] }) });
add("A Boolean named deleted. True means soft deleted, false means active.", { pose: "present", ...snap("Student.java", "java", STUDENT_DEL, { highlight: [9] }) });
add("Generate the getter and setter for it, and the entity is ready.", { pose: "point", ...snap("Student.java", "java", STUDENT_DEL, { highlight: [9], animate: "lines" }) });
add("Because ddl auto is set to update, we simply drop the old student table and restart.", { pose: "present", ...steps(["Drop the student table", "Restart the application", "Hibernate recreates it"], 1) });
add("Hibernate recreates the table, and the deleted column appears, stored as a bit.", { pose: "celebrate", mood: "happy", ...table("student", ["id", "name", "email", "deleted"], [["-", "-", "-", "-"]], 0) });
add("Insert a row by hand, leaving out the flag, and it defaults to zero, as it should.", { pose: "point", ...table("student", ["id", "name", "roll_no", "deleted"], [["1", "Aditya", "1001", "0"]], 0) });
add("Here is the catch. This one field changes every operation we wrote.", { pose: "think", mood: "worried", props: [{ type: "warning" }] });

// ═══════════════════════ 4 · Why the standard methods fail ═══════════════════════
chapter("4 · Why the standard methods fail", "classroom");
add("Take read one. We call find by id, and Hibernate runs a select with where id equals one.", { pose: "present", ...code("Query behind findById", "text", ["SELECT * FROM student", "WHERE id = 1"], { animate: "lines" }) });
add("But if that row is soft deleted, this query still finds it. It never looks at the flag.", { pose: "point", mood: "worried", ...table("student", COLS, [["2", "Rohit", "102", "1"]], 0) });
add("What we need is a different query: id equals one, and deleted equals false.", { pose: "present", ...code("The query we need", "text", ["SELECT * FROM student", "WHERE id = 1", "  AND deleted = false"], { highlight: [1, 2], animate: "lines" }) });
add("The same goes for read all. It must only return rows where deleted is false.", { pose: "point", ...code("Read all, fixed", "text", ["SELECT * FROM student", "WHERE deleted = false"], { highlight: [1], animate: "lines" }) });
add("Even exists by id would need the same check, if we wanted it to ignore deleted rows.", { pose: "present", ...code("exists, fixed", "text", ["SELECT COUNT(*) FROM student", "WHERE id = 1 AND deleted = false"], { animate: "lines" }) });
add("The query to find an active student, and the query to list active students, side by side.", { pose: "point", ...code("Two queries we need", "text", ["-- read one", "SELECT * FROM student", "WHERE id = ? AND deleted = false;", "", "-- read all", "SELECT * FROM student", "WHERE deleted = false;"], { highlight: [2, 6], animate: "lines" }) });
add("And now the problem: there is no ready-made method for any of these queries.", { pose: "think", mood: "confused", props: [{ type: "question" }] });
add("Save, find by id, find all, and exists by id are standard methods. This query is a special case.", { pose: "point", ...compare("versus", [{ title: "Standard methods", points: ["findById", "findAll", "save", "existsById"] }, { title: "Our special case", points: ["id AND deleted = false"] }]) });
add("Must we write the query ourselves? We would have to implement a method inside an interface.", { pose: "think", ...code("StudentRepository.java", "java", ["public interface StudentRepository {", "  // an interface has no method bodies,", "  // so where would the query go?", "}"], { animate: "lines" }) });
add("No. And this is one of the most powerful features of Spring Data JPA.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });
add("It builds the query from the name of your method. You only choose the name.", { pose: "present", mood: "excited", ...flow(["Method name", "Spring Data JPA", "SQL query"], 2, "reads the name") });
add("Today it feels like magic. In later lessons we open the box and see how it works.", { pose: "shrug", mood: "happy" });

// ═══════════════════════ 5 · Derived query methods ═══════════════════════
chapter("5 · Derived query methods", "office");
add("Our goal: find by id, and deleted is false. So the method name says exactly that.", { pose: "present", ...snap("StudentRepository.java", "java", REPO_1) });
add("Find by id, then and, then deleted, then is false.", { pose: "point", ...snap("StudentRepository.java", "java", REPO_2, { highlight: [3] }) });
add("Type it, and IntelliJ even suggests endings: is, is false, is after, between, containing, and more.", { pose: "present", ...steps(["IsFalse", "IsTrue", "Between", "Containing", "After, Before"], 0) });
add("Methods that do not exist anywhere yet, and Spring offers to generate them. You only supply the name.", { pose: "smug", mood: "excited" });
add("We declare it in the repository, and nothing else. No body, and no query.", { pose: "point", ...snap("StudentRepository.java", "java", REPO_2, { highlight: [3], animate: "lines" }) });
add("The return type is an Optional of Student, and it takes the id as a Long.", { pose: "present", ...snap("StudentRepository.java", "java", REPO_2, { highlight: [3], animate: "lines" }) });
add("Spring Data JPA writes the implementation at runtime, just as it did for save and find by id.", { pose: "point", ...flow(["Your declaration", "Spring Data JPA", "Generated query"], 2, "runtime") });
add("Next, the one for read all: find by deleted is false, returning a list.", { pose: "present", ...snap("StudentRepository.java", "java", REPO_3, { highlight: [5] }) });
add("Now a trap. Someone tries find all and deleted is false, and the application refuses to start.", { pose: "think", mood: "worried", ...alert("error", "Application failed to start", "No property 'all' found for type Student") });
add("The rule: a derived method name starts with find by. Then a field name. Then a condition.", { pose: "present", ...steps(["Start: findBy", "Then a field: Deleted", "Then a condition: IsFalse", "Join fields with And"], 2) });
add("Find all is a different, ready-made method, so you cannot attach And to it.", { pose: "point", mood: "worried" });
add("Pause and think. Which of these names is valid?", { pose: "think", ...quiz("Which method name is valid?", ["findAllAndDeletedIsFalse", "findByDeletedIsFalse", "getDeletedFalse", "fetchNotDeleted"], 1, 0.7) });
add("Find by deleted is false. It starts with find by, names a field, and states a condition.", { pose: "smug", mood: "happy" });
add("With one field there is no And. Two fields, like id and deleted, are joined with And.", { pose: "present", ...table("Method names", ["method", "fields"], [["findByDeletedIsFalse", "deleted"], ["findByIdAndDeletedIsFalse", "id, deleted"]], 1) });
add("Read each name as a sentence. Find by, then the field, then the condition.", { pose: "present", ...code("Name to query", "text", ["findByDeletedIsFalse()", "  WHERE deleted = false", "", "findByIdAndDeletedIsFalse(id)", "  WHERE id = ? AND deleted = false"], { highlight: [1, 4], animate: "lines" }) });
add("The query is built from the name, and you never write a line of SQL.", { pose: "smug", mood: "happy" });
add("Your turn. Without looking ahead, write the method that finds a student by name and roll number.", { pose: "smug", mood: "excited", ...steps(["Start with findBy", "Name the first field", "Join with And", "Name the second field"], 0) });
add("The answer is find by name and roll no. Fields, joined with And.", { pose: "point", ...code("Your turn: answer", "java", ["Optional<Student> findByNameAndRollNo(", "    String name, int rollNo);"], { animate: "lines" }) });

// ═══════════════════════ 6 · Updating the service ═══════════════════════
chapter("6 · Updating the service", "office");
add("Now fix every operation, one by one. First, create. A new student must start as not deleted.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student createStudent(Student studentReq) {", "    studentReq.setDeleted(false);", "    return studentRepository.save(studentReq);", "  }"], { highlight: [1] }) });
add("We always set deleted to false ourselves, because the client must not decide that.", { pose: "point", mood: "worried", ...alert("warning", "Never trust the client", "deleted: true in the body is ignored") });
add("Suppose someone sends deleted true in a create request. We ignore it, and set false.", { pose: "present", ...browser("POST /api/students/create", "json", ["{", "  \"name\": \"Rohit\",", "  \"deleted\": true", "}"]) });
add("Test it. Even with true in the body, the database shows deleted equals zero.", { pose: "celebrate", mood: "happy", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "0"]], 1) });
add("A client must never create a record that is already deleted. Only our soft delete may do that.", { pose: "smug" });
add("The create endpoint itself does not change. It still returns two hundred and one, created.", { pose: "present", ...snap("StudentController.java", "java", ["  @PostMapping(\"/create\")", "  public ResponseEntity<Student> createStudent(", "      @RequestBody Student student) {", "    Student created =", "      studentService.createStudent(student);", "    return ResponseEntity", "      .status(HttpStatus.CREATED).body(created);", "  }"], { highlight: [3, 4] }) });
add("Now read one. It must use our new method, find by id and deleted is false.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student getStudent(Long id) {", "    Optional<Student> found =", "      studentRepository.findByIdAndDeletedIsFalse(id);", "    if (found.isPresent()) {", "      return found.get();", "    }", "    return null;", "  }"], { highlight: [2] }) });
add("Here are both new methods in the repository, and the services use only these.", { pose: "point", ...snap("StudentRepository.java", "java", REPO_3, { highlight: [3, 5], animate: "lines" }) });
add("A warning. In the course repository, the get student method still calls plain find by id.", { pose: "point", mood: "worried", ...alert("warning", "Check your copy", "Plain findById would return soft-deleted rows") });
add("With plain find by id, a soft-deleted student would still come back. Use the new method.", { pose: "present" });
add("Read all follows the same idea. It calls find by deleted is false.", { pose: "point", ...snap("StudentService.java", "java", ["  public List<Student> getAllStudent() {", "    return studentRepository.findByDeletedIsFalse();", "  }"], { highlight: [1] }) });
add("Update must also ignore deleted rows. So it starts with find by id and deleted is false.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> existing =", "      studentRepository.findByIdAndDeletedIsFalse(id);", "    if (existing.isEmpty()) {", "      return null;", "    }", "  }"], { highlight: [2, 3, 4] }) });
add("If the record is deleted, nothing comes back, and the update returns not found.", { pose: "point", mood: "happy" });
add("Otherwise, copy the new details onto the stored student, and set deleted to false again.", { pose: "present", ...snap("StudentService.java", "java", ["  public Student updateStudent(Long id, Student req) {", "    Optional<Student> existing =", "      studentRepository.findByIdAndDeletedIsFalse(id);", "    if (existing.isEmpty()) {", "      return null;", "    }", "    Student toSave = existing.get();", "    toSave.setName(req.getName());", "    // age, email, rollNo and subject the same way", "    toSave.setDeleted(false);", "    return studentRepository.save(toSave);", "  }"], { highlight: [8, 9] }) });
add("Why set deleted to false on an update? So a client can never mark a record deleted through update.", { pose: "smug", mood: "happy" });
add("What about hard delete? We leave it exactly as it was.", { pose: "present", ...snap("StudentService.java", "java", ["  public Boolean deleteStudent(Long id) {", "    Boolean exists = studentRepository.existsById(id);", "    if (!exists) return false;", "    studentRepository.deleteById(id);", "    return true;", "  }"], { highlight: [1, 3] }) });
add("It uses exists by id, which ignores the flag. So a hard delete works on any row, soft deleted or not.", { pose: "point", ...compare("versus", [{ title: "Soft delete", points: ["Skips deleted rows"] }, { title: "Hard delete", points: ["Works on any row", "Used rarely"] }]) });
add("You could also hide deleted rows from hard delete. That is a business decision, and yours to make.", { pose: "shrug" });

// ═══════════════════════ 7 · The soft delete endpoint ═══════════════════════
chapter("7 · The soft delete endpoint", "office");
add("Finally, the soft delete itself. We need a new endpoint beside the hard delete.", { pose: "present", ...snap("StudentController.java", "java", ["  @DeleteMapping(\"/delete\")", "  public ResponseEntity<String> deleteStudent(", "      @RequestParam Long id) {", "  }"], { highlight: [0] }) });
add("Which HTTP method should it use? Delete, put, or something else?", { pose: "think", ...quiz("Soft delete changes one field. Which HTTP method fits best?", ["POST", "PUT", "PATCH", "GET"], 2, 0.7) });
add("Patch. We are not removing anything. We are changing a single field, from zero to one.", { pose: "present", mood: "happy", ...compare("versus", [{ title: "PUT", points: ["Replaces the whole record"] }, { title: "PATCH", points: ["Changes one field", "Best for soft delete"] }]) });
add("So the mapping is Patch Mapping, with the path slash delete dash soft.", { pose: "point", ...snap("StudentController.java", "java", ["  @PatchMapping(\"/delete-soft\")", "  public ResponseEntity<String> deleteStudentSoftly(", "      @RequestParam Long id) {", "  }"], { highlight: [0, 1] }) });
add("It responds with a string, like hard delete, and the id arrives as a request parameter.", { pose: "present", ...snap("StudentController.java", "java", ["  @PatchMapping(\"/delete-soft\")", "  public ResponseEntity<String> deleteStudentSoftly(", "      @RequestParam Long id) {", "    Boolean isDeleted =", "      studentService.deleteStudentSoftly(id);", "  }"], { highlight: [3, 4] }) });
add("If the service says false, the record never existed, so we answer not found.", { pose: "point", ...snap("StudentController.java", "java", ["  @PatchMapping(\"/delete-soft\")", "  public ResponseEntity<String> deleteStudentSoftly(", "      @RequestParam Long id) {", "    Boolean isDeleted =", "      studentService.deleteStudentSoftly(id);", "    if (!isDeleted) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(\"Record deleted\");", "  }"], { highlight: [5, 6, 8] }) });
add("Now the service. A soft delete takes three steps. Get the record, mark it, and save it.", { pose: "present", ...steps(["1. Get the record", "2. Set deleted to true", "3. Save it"], 0) });
add("Step one: find by id and deleted is false. We can only soft delete a record that is not already deleted.", { pose: "point", ...snap("StudentService.java", "java", ["  public Boolean deleteStudentSoftly(Long id) {", "    Optional<Student> existing =", "      studentRepository.findByIdAndDeletedIsFalse(id);", "    if (existing.isEmpty()) {", "      return false;", "    }", "  }"], { highlight: [2, 3, 4] }) });
add("If nothing comes back, we return false. The record is missing, or already soft deleted.", { pose: "present" });
add("Step two: take the student out of the Optional, and set deleted to true.", { pose: "point", ...snap("StudentService.java", "java", ["  public Boolean deleteStudentSoftly(Long id) {", "    Optional<Student> existing =", "      studentRepository.findByIdAndDeletedIsFalse(id);", "    if (existing.isEmpty()) {", "      return false;", "    }", "    Student toSave = existing.get();", "    toSave.setDeleted(true);", "  }"], { highlight: [6, 7] }) });
add("Step three: save it, and return true.", { pose: "present", ...snap("StudentService.java", "java", ["  public Boolean deleteStudentSoftly(Long id) {", "    Optional<Student> existing =", "      studentRepository.findByIdAndDeletedIsFalse(id);", "    if (existing.isEmpty()) {", "      return false;", "    }", "    Student toSave = existing.get();", "    toSave.setDeleted(true);", "    studentRepository.save(toSave);", "    return true;", "  }"], { highlight: [8, 9] }) });
add("Save sees an existing id, so it runs an update. A simple, three-step operation.", { pose: "smug", mood: "happy" });
add("Remember the earlier trap? Because I wrote find all and, the whole application refused to start.", { pose: "think", mood: "worried", ...alert("error", "Bean creation failed", "Invalid derived query method name") });
add("A broken method name in the repository stops everything, so read the message and check the name.", { pose: "point", mood: "happy" });

// ═══════════════════════ 8 · Testing it all ═══════════════════════
chapter("8 · Testing it all", "stage");
add("Time to test. Two students: Aditya and Rohit, both with deleted equal to zero.", { pose: "present", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "0"]], 0) });
add("Send a patch request to delete soft, with id equals two.", { pose: "point", ...browser("PATCH localhost:8080/api/students/delete-soft?id=2", "page", ["Query parameter: id = 2", "No request body"], "Postman") });
add("Two hundred OK, with the message: record deleted.", { pose: "celebrate", mood: "happy", ...alert("success", "Record deleted", "200 OK") });
add("The log shows two queries: a select with id and deleted is false, then an update.", { pose: "present", ...term(["Hibernate: select ... from student", "  where id=? and deleted=?", "Hibernate: update student set deleted=? ..."], "Server log") });
add("In the database, Rohit's deleted flag is now one. He is still there.", { pose: "point", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "1"]], 1) });
add("Now try to read Rohit. Get with id equals two.", { pose: "present", ...browser("GET localhost:8080/api/students/get?id=2", "page", ["Query parameter: id = 2"], "Postman") });
add("Not found, four oh four. As far as the application is concerned, Rohit does not exist.", { pose: "smug", mood: "happy", ...alert("error", "404 Not Found", "Soft deleted records are hidden") });
add("Get with id one still returns Aditya's full record.", { pose: "point", ...browser("200 OK", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"deleted\": false", "}"]) });
add("The log for read all shows a select, with where deleted equals the value false.", { pose: "present", ...term(["Hibernate: select s1_0.id, s1_0.age, ...", "  from student s1_0", "  where s1_0.deleted=?"], "Server log") });
add("Prediction time. If we now read all students, what comes back?", { pose: "think", ...quiz("After soft deleting Rohit, what does get all return?", ["Aditya and Rohit", "Only Aditya", "Only Rohit", "404 Not Found"], 1, 0.7) });
add("Only Aditya. Rohit stays hidden, because the query asks for deleted equals false.", { pose: "celebrate", mood: "happy", ...browser("GET /api/students/getAll", "json", ["[", "  { \"id\": 1, \"name\": \"Aditya\" }", "]"]) });
add("Add a third student: Rahul, roll number 103. The create request works as before.", { pose: "present", ...browser("POST /api/students/create", "json", POST_JSON) });
add("Soft delete Rahul, then check the database: his flag is now one.", { pose: "point", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "1"], ["3", "Rahul", "103", "1"]], 2) });
add("Can we hard delete a soft-deleted record? Send a delete request for id three.", { pose: "think", ...browser("DELETE /api/students/delete?id=3", "page", ["Query parameter: id = 3"], "Postman") });
add("It works. Record deleted. Refresh the database, and Rahul's row is really gone.", { pose: "celebrate", mood: "happy", ...table("student", COLS, [["1", "Aditya", "1001", "0"], ["2", "Rohit", "102", "1"]], 1) });
add("The log for the hard delete is a plain delete statement. No flag involved.", { pose: "point", ...term(["Hibernate: delete from student", "  where id=?"], "Server log") });
add("So hard delete removes any row, and soft delete only marks it. Both work as designed.", { pose: "smug" });

// ═══════════════════════ 9 · A bug in create ═══════════════════════
chapter("9 · A bug in create", "classroom");
add("Now a subtle bug, and a great lesson. So far, we sent the id ourselves when creating students.", { pose: "present", ...browser("POST /api/students/create", "json", ["{", "  \"id\": 3,", "  \"name\": \"Rahul\",", "  \"rollNo\": 103", "}"]) });
add("Post a new student, Rohan, but with id two, which already exists. What happens?", { pose: "think", ...quiz("We create Rohan with id 2, but id 2 already exists. What does save do?", ["Creates a second row", "Throws an error", "Updates the existing row", "Ignores the request"], 2, 0.7) });
add("It updates the existing row. Rohit becomes Rohan, and we never asked for an update.", { pose: "point", mood: "worried", ...table("student", ["id", "name", "roll_no"], [["1", "Aditya", "1001"], ["2", "Rohan", "104"]], 1) });
add("The logs explain it: a select, finds the id, then an update instead of an insert.", { pose: "present", ...term(["Hibernate: select ... from student where id=?", "Hibernate: update student set ... where id=?"], "Server log") });
add("Remember: save inserts when the id is new, and updates when it already exists.", { pose: "smug" });
add("So the client must not choose ids. The database should assign them.", { pose: "present", mood: "excited", ...two("lab", ["person-worried", "Client picks ids"], ["database", "Database assigns ids", "green"]) });
add("The fix: Generated Value with the identity strategy, on the id.", { pose: "point", ...snap("Student.java", "java", STUDENT_GEN, { highlight: [3] }) });
add("Identity means auto increment. The database counts upward by itself, one, two, three.", { pose: "present", mood: "happy" });
add("One catch. The table already exists, and Hibernate only builds the structure when it creates the table.", { pose: "think", mood: "worried", ...alert("warning", "Table already exists", "ddl-auto=update will not add auto_increment") });
add("So drop the table again, and restart. Now the create table query says: auto increment.", { pose: "present", ...term(["Hibernate: create table student (", "  id bigint not null auto_increment,", "  deleted bit,", "  primary key (id))"]) });
add("Post a student without any id, and the database assigns id one.", { pose: "celebrate", mood: "happy", ...table("student", ["id", "name", "roll_no", "deleted"], [["1", "Rohit", "102", "0"]], 0) });
add("Post another, and it gets id two. We can never overwrite a record by accident again.", { pose: "point", ...table("student", ["id", "name", "roll_no", "deleted"], [["1", "Rohit", "102", "0"], ["2", "Aditya", "1001", "0"]], 1) });
add("That is the clean way to design create: the client sends details, and the server owns the id.", { pose: "smug", mood: "happy" });

// ═══════════════════════ 10 · Request parameters ═══════════════════════
chapter("10 · Request parameters", "office");
add("One more improvement. So far, ids travelled inside the path: slash get slash one.", { pose: "present", ...browser("GET /api/students/get/1", "page", ["Path variable", "The id is part of the path"], "Before") });
add("There is another way to pass values: request parameters, also called query parameters.", { pose: "point", ...browser("GET /api/students/get?id=1", "page", ["Request parameter", "?id=1 after the question mark"], "Now") });
add("Websites do this all the time: a question mark, then a name, an equals sign, and a value.", { pose: "present" });
add("Need two values? Join them with an ampersand: id equals one, and name equals Aditya.", { pose: "point", ...browser("GET /api/students/get?id=1&name=Aditya", "page", ["id = 1", "name = Aditya"], "Many parameters") });
add("Request parameters travel with the URL, so Postman has a params table for them.", { pose: "present", ...table("Params", ["key", "value"], [["id", "1"], ["name", "Aditya"]], 0) });
add("Which one should you use? Path variables suit one simple id. Request parameters suit many fields.", { pose: "smug", ...compare("versus", [{ title: "Path variable", points: ["One simple value", "/get/1"] }, { title: "Request parameter", points: ["Many values", "?id=1&name=A"] }]) });
add("With many fields, a path like slash one slash Aditya gets confusing. Which is the id, and which is the name?", { pose: "think", mood: "confused" });
add("In the controller, replace Path Variable with Request Param, and remove the id from the mapping.", { pose: "present", ...snap("StudentController.java", "java", ["  @GetMapping(\"/get\")", "  public ResponseEntity<Student> getStudent(", "      @RequestParam Long id) {", "    Student resp = studentService.getStudent(id);", "    if (resp == null) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(resp);", "  }"], { highlight: [0, 2] }) });
add("The parameter name must match the name in the URL. Id in the URL fills the id variable.", { pose: "point", ...flow(["?id=1", "@RequestParam", "Long id"], 2, "1") });
add("Update takes the id as a request parameter, and the new details as a JSON body.", { pose: "present", ...snap("StudentController.java", "java", ["  @PutMapping(\"/update\")", "  public ResponseEntity<Student> updateStudent(", "      @RequestParam Long id,", "      @RequestBody Student studentReq) {", "    Student resp =", "      studentService.updateStudent(id, studentReq);", "    if (resp == null) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(resp);", "  }"], { highlight: [2, 3] }) });
add("Hard delete follows the same pattern, with the delete mapping and a request parameter.", { pose: "point", ...snap("StudentController.java", "java", ["  @DeleteMapping(\"/delete\")", "  public ResponseEntity<String> deleteStudent(", "      @RequestParam Long id) {", "    Boolean isDeleted =", "      studentService.deleteStudent(id);", "    if (!isDeleted) {", "      return ResponseEntity.notFound().build();", "    }", "    return ResponseEntity.ok(\"Record deleted\");", "  }"], { highlight: [0, 2] }) });
add("Do the same for update, hard delete, and soft delete. Our final endpoints look like this.", { pose: "present", ...table("Endpoints", ["method", "endpoint", "action"], ENDPOINTS, 5) });
add("Test again. Get with id equals one works. But slash get slash one now gives not found.", { pose: "point", ...alert("error", "404 Not Found", "/get/1 matches no endpoint any more") });
add("Why? That path no longer exists. Our endpoint is just slash get, with a parameter.", { pose: "smug" });
add("Pause and think. Which request now reads the student with id two?", { pose: "think", ...quiz("Which request reads the student with id 2?", ["GET /get/2", "GET /get?id=2", "POST /get?id=2", "GET /get-2"], 1, 0.7) });
add("Get slash get, question mark, id equals two. Request parameters keep the endpoint stable.", { pose: "celebrate", mood: "happy" });

// ═══════════════════════ 11 · Recap and your turn ═══════════════════════
chapter("11 · Recap and your turn", "stage");
const RECAP = ["Hard delete erases; soft delete marks", "A deleted field hides rows from every read", "Method names become queries: findBy...", "Never let the client set deleted or the id", "Request parameters for several values"];
add("Let us recap with five ideas.", { pose: "present", mood: "happy", ...steps(RECAP, 0) });
add("One: hard delete removes the row for good. Soft delete only marks it, so it can be recovered.", { pose: "point", ...steps(RECAP, 0) });
add("Two: a deleted field changes every read and update, so each one must skip deleted rows.", { pose: "point", ...steps(RECAP, 1) });
add("Three: derived methods, like find by id and deleted is false, turn a name into a query.", { pose: "point", ...steps(RECAP, 2) });
add("Four: the client must never control deleted, and must never choose the id.", { pose: "point", ...steps(RECAP, 3) });
add("Five: request parameters carry several values in the URL, after the question mark.", { pose: "point", ...steps(RECAP, 4) });
const TASK = ["Add a restore endpoint: deleted true to false", "Add a rollNo check (1001 to 1099)", "Write findByNameAndDeletedIsFalse and test it"];
add("Now your turn. Three challenges, and the best way to learn is to try each one yourself.", { pose: "smug", mood: "excited", ...steps(TASK, 0) });
add("Challenge one: a restore endpoint, a patch that turns deleted from true back to false.", { pose: "point", ...steps(TASK, 0) });
add("Hint: you need a derived method that finds a record where deleted is true.", { pose: "think", ...code("Hint", "java", ["Optional<Student> findByIdAndDeletedIsTrue(Long id);"], { animate: "lines" }) });
add("Challenge two: in the service, reject a roll number outside your allowed range.", { pose: "point", ...steps(TASK, 1) });
add("That is real business logic, and it is why the service layer exists.", { pose: "smug", mood: "happy" });
add("Challenge three: write a derived method of your own, then check the SQL in the log.", { pose: "point", ...steps(TASK, 2) });
add("The more methods you invent, the faster the pattern sticks.", { pose: "present", mood: "happy" });
add("Next time, we look inside: how a server handles requests, from servlets to Spring MVC.", { pose: "present", mood: "excited", ...scene("sky", [{ asset: "server", x: 30, y: 52, size: 46, label: "Servlets", tint: "blue" }, { asset: "rocket", x: 70, y: 52, size: 46, label: "Spring MVC" }], [{ from: [42, 52], to: [58, 52] }]) });
add("Thanks for watching, and see you in the next lesson.", { pose: "celebrate", mood: "happy" });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const plan = {
  title: "Spring Boot CRUD Project with Soft Delete | Spring JPA Custom Methods | Spring Boot Full Course #13",
  description:
    "Upgrade the Spring Boot CRUD project with soft delete. You will learn the difference between hard delete and soft delete, why companies keep deleted data, how to add a deleted field to the entity, " +
    "and how Spring Data JPA builds queries from method names (findByIdAndDeletedIsFalse, findByDeletedIsFalse). You will also fix create so the client can never set deleted or the id, " +
    "build a PATCH soft-delete endpoint, and switch from path variables to request parameters. Interactive: pause-and-think questions and three challenges.\n\n" +
    "Chapters: 1 Where we are | 2 Hard delete vs soft delete | 3 Add the deleted field | 4 Why the standard methods fail | 5 Derived query methods | 6 Updating the service | 7 The soft delete endpoint | 8 Testing it all | 9 A bug in create | 10 Request parameters | 11 Recap and your turn\n\n" +
    "Code: github.com/adityatandon15/Spring-Framework-Full-Course (Lecture 13). Note: in the repository copy, StudentService.getStudent still calls plain findById; use findByIdAndDeletedIsFalse so soft-deleted rows stay hidden.\n\n" +
    "Based on Spring Boot Full Course Lecture 13 (Hindi). Next video: servlets and Spring MVC internals.\n\n#SpringBoot #Java #SpringDataJPA #SoftDelete #CodeOrCap",
  tags: ["Spring Boot", "soft delete", "Spring Data JPA", "derived query methods", "findBy", "RequestParam", "CRUD", "MySQL", "Spring Boot tutorial", "Java", "CodeOrCap"],
  scenes,
};
const out = process.argv[2] || "spring13-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} -> ${out}`);
