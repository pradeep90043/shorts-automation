// Chapters 1-4: the hook, the entity that does too many jobs, the code before DTOs, the first problem (fields the client must not send).
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const LAYERS = ["Client", "Controller", "Service", "Repository", "Database"];
const ROADMAP = ["The problem with entities", "What a DTO is", "Building DTOs", "Validations"];
const JOBS = ["Takes the request from the client", "Travels through every layer", "Maps to a database table", "Becomes the response"];
const ENTITY = ["@Entity", "public class Student {", "  @Id", "  @GeneratedValue(strategy = GenerationType.IDENTITY)", "  private Long id;", "  private String name;", "  private String email;", "  // getters and setters", "}"];
const CONTROLLER = ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  public ResponseEntity<Student> create(", "      @RequestBody Student student) {", "    Student response =", "        studentService.createStudent(student);", "    return ResponseEntity.ok(response);", "  }", "}"];
const SERVICE = ["@Service", "public class StudentService {", "  public Student createStudent(Student request) {", "    return studentRepository.save(request);", "  }", "}"];
const REPO = ["public interface StudentRepository", "    extends JpaRepository<Student, Long> {", "}"];
const FIELDS = ["private Long id;", "private String name;", "private Integer age;", "private String email;", "private Integer rollNumber;", "private String subject;", "private boolean deleted;"];

module.exports = () => {
  // ═══════════════ 1 · The hook ═══════════════
  chapter("1 · Your API works. Is it safe?", "stage");
  add("Your Spring Boot API works. You send a request, and data is saved. But is it safe?", { pose: "present", mood: "excited", ...flow(LAYERS.slice(0, 3).concat(["Database"]), 3, "POST") });
  add("There is a hidden problem in almost every beginner project. Today we fix it.", { pose: "point", mood: "worried", props: [{ type: "bug" }] });
  add("We will learn two ideas: DTOs and validations. Both are standard in professional projects.", { pose: "smug", mood: "happy", props: [{ type: "bulb" }] });
  add("First, why DTOs exist, by looking at what goes wrong without them.", { pose: "point", ...steps(ROADMAP, 0) });
  add("Then we build them, one request at a time, and see how they protect us.", { pose: "present", ...steps(ROADMAP, 2) });
  add("Finally, validations: how to stop bad data before it reaches your code.", { pose: "present", mood: "excited", ...steps(ROADMAP, 3) });
  add("Quick recap first. You already know three layers: controller, service, and repository.", { pose: "point", ...flow(["Controller", "Service", "Repository"], 2, "layers") });
  add("A client sends a request, for example POST to slash api slash students, with a JSON body.", { pose: "present", ttsText: "A client sends a request, for example post to slash A P I slash students, with a Jason body.", ...browser("POST /api/students", "json", ["{", "  \"id\": 1,", "  \"name\": \"Aditya\"", "}"]) });
  add("The controller turns that JSON into an object. Here, it is the Student entity.", { pose: "point", ...flow(["JSON", "Controller", "Student entity"], 2, "convert") });
  add("The request then moves to the service, where business logic can run.", { pose: "present", ...flow(["Controller", "Service"], 1, "Student") });
  add("Then it goes to the repository, which stores the data in the database.", { pose: "point", ...flow(["Service", "Repository", "Database"], 2, "save") });
  add("The answer travels back the same way. The controller turns the entity back into JSON.", { pose: "present", ...flow(LAYERS, 0, "response") });
  add("Under the hood, Spring uses the Jackson library to convert JSON to objects and back.", { pose: "smug", ...flow(["JSON", "Jackson", "Java object"], 2, "convert") });

  // ═══════════════ 2 · The entity does too many jobs ═══════════════
  chapter("2 · One class, too many jobs", "classroom");
  add("The entity class is one of the most important classes in your project.", { pose: "present" });
  add("Its name becomes the table name, and each field becomes a column.", { pose: "point", ...table("student", ["id", "name", "email"], [["1", "Aditya", "aditya@gmail.com"]], 0) });
  add("So the entity has one real job: mapping to the database. How data is stored in a table.", { pose: "point", mood: "happy", ...alert("success", "The entity's job", "Describe how data is stored in a table") });
  add("But look at what we make it do in our code.", { pose: "think", mood: "worried" });
  add("First, it takes the request. The client's JSON is turned into the entity.", { pose: "present", ...steps(JOBS, 0) });
  add("Second, the same object travels through the controller, service, and repository.", { pose: "point", ...steps(JOBS, 1) });
  add("Third, it maps to the database table, which is its proper job.", { pose: "present", ...steps(JOBS, 2) });
  add("And fourth, the same object is turned back into JSON, and becomes the response.", { pose: "point", ...steps(JOBS, 3) });
  add("That is four jobs for one class. Too many responsibilities.", { pose: "shrug", mood: "worried", ...alert("warning", "Too many responsibilities", "One class, four jobs") });
  add("In a tiny project, this works fine. In a growing project, it causes real trouble.", { pose: "point", props: [{ type: "warning" }] });
  add("The fix is a DTO, short for Data Transfer Object. It takes some jobs away from the entity.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });
  add("Before we see it, one quick question. Think about it.", { pose: "think" });
  add("What should the entity be responsible for?", { pose: "point", ...quiz("What should the entity class be responsible for?", ["Taking the client's JSON", "Mapping data to the database table", "Sending the HTTP response", "Validating email addresses"], 1) });
  add("Right. Database mapping, and nothing else. Everything else belongs to other classes.", { pose: "celebrate", mood: "happy" });

  // ═══════════════ 3 · Before DTO ═══════════════
  chapter("3 · Before DTOs: the entity everywhere", "office");
  add("Let us look at the code before DTOs. A new project, with Spring Web, Spring Data JPA, and MySQL.", { pose: "present", ...steps(["Spring Web", "Spring Data JPA", "MySQL Driver"], 2) });
  add("We start with the entity. A Student with an id, a name, and an email.", { pose: "point", ...snap("Student.java", "java", ENTITY, { highlight: [0, 4, 5, 6] }) });
  add("The entity needs a primary key, so we mark the id with Id.", { pose: "present", ttsText: "The entity needs a primary key, so we mark the I D with Id.", ...snap("Student.java", "java", ENTITY, { highlight: [2, 4] }) });
  add("We also ask the database to generate it, with GeneratedValue and the identity strategy.", { pose: "point", ...snap("Student.java", "java", ENTITY, { highlight: [3] }) });
  add("Now the controller. The create method takes a Student, straight from the request body.", { pose: "present", ...snap("StudentController.java", "java", CONTROLLER, { highlight: [3, 4] }) });
  add("It passes that Student to the service, and returns whatever the service gives back.", { pose: "point", ...snap("StudentController.java", "java", CONTROLLER, { highlight: [5, 6, 7] }) });
  add("The service receives the entity and hands it to the repository to save.", { pose: "present", ...snap("StudentService.java", "java", SERVICE, { highlight: [2, 3] }) });
  add("The repository is an interface that extends JpaRepository, with the entity and its key type.", { pose: "point", ...snap("StudentRepository.java", "java", REPO, { highlight: [1] }) });
  add("Follow the object. JSON becomes a Student, which travels to the service, to the repository, and into the database.", { pose: "present", ...flow(["JSON", "Student", "Service", "Database"], 3, "Student") });
  add("Then the same Student comes back out, and goes to the client.", { pose: "point", ...flow(["Database", "Service", "Controller", "Client"], 3, "Student") });
  add("Everywhere, we only played with the entity. One class takes the request, travels, and gives the response.", { pose: "smug", mood: "worried", ...alert("warning", "Entity everywhere", "Request, travel object, and response: all one class") });

  // ═══════════════ 4 · Problem 1: fields the client must not send ═══════════════
  chapter("4 · Problem 1: the client sends too much", "office");
  add("Our real project has more fields. Along with name and email, it has age, roll number, and subject.", { pose: "present", ...snap("Student.java", "java", FIELDS, { highlight: [2, 4, 5] }) });
  add("It also has a field called deleted. That is a soft delete flag.", { pose: "point", ...snap("Student.java", "java", FIELDS, { highlight: [6] }) });
  add("Soft delete means the row stays in the table, but is marked as deleted.", { pose: "present", ...table("student", ["id", "name", "deleted"], [["1", "Aditya", "false"], ["2", "Rohit", "true"]], 1) });
  add("That flag belongs to the server. A client should never decide it.", { pose: "point", mood: "worried" });
  add("Now we add two more fields: createdAt and updatedAt.", { pose: "present", ...snap("Student.java", "java", FIELDS.concat(["private String createdAt;", "private String updatedAt;"]), { highlight: [7, 8] }) });
  add("They record when a record was created, and when it was last changed.", { pose: "point", mood: "happy" });
  add("But our controller accepts the whole entity. So the client can send these fields too.", { pose: "present", mood: "worried", ...browser("POST /api/students", "json", ["{", "  \"name\": \"Aditya\",", "  \"deleted\": true,", "  \"createdAt\": \"1999-01-01\"", "}"]) });
  add("This request sets deleted to true, and a made-up creation date. The server just accepts it.", { pose: "shocked", mood: "shocked", ...alert("error", "Client sets internal fields", "deleted = true, createdAt = 1999") });
  add("A student could delete their own record, or invent their own timestamps.", { pose: "point", mood: "worried" });
  add("To stay safe, the service must override every internal field, by hand.", { pose: "present", ...snap("StudentService.java", "java", ["// reset the fields the client must not set", "student.setDeleted(false);", "student.setCreatedAt(now);", "student.setUpdatedAt(now);"], { highlight: [1, 2, 3] }) });
  add("And you must repeat this in every single endpoint.", { pose: "shrug", mood: "worried" });
  add("Forget it once, and bad data goes straight into your database.", { pose: "point", mood: "shocked", props: [{ type: "bug" }] });
  add("So expecting a whole entity from the client is a very bad practice.", { pose: "smug", mood: "angry", ...alert("warning", "Bad practice", "The client can send values it should never send") });
};
