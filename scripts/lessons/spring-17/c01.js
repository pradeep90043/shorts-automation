// Chapters 1-2: why exception handling, what a professional API response looks like, our CRUD app, and cleaning the endpoints.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const SCENARIOS = ["Data is available", "Data is not available", "The id format is wrong", "The database is down", "The server is down", "A bug in our code"];
const OK_BODY = ["{", "  \"id\": 1,", "  \"name\": \"Aditya\",", "  \"email\": \"ad@gmail.com\"", "}"];
const OLD_CTRL = ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  @PostMapping(\"/create\")", "  @GetMapping(\"/get\")", "  @GetMapping(\"/getAll\")", "  @PutMapping(\"/update\")", "  @DeleteMapping(\"/delete\")", "}"];
const NEW_CTRL = ["@RestController", "@RequestMapping(\"/api/students\")", "public class StudentController {", "  @PostMapping", "  @GetMapping(\"/{id}\")", "  @GetMapping", "  @PutMapping(\"/{id}\")", "  @DeleteMapping(\"/{id}\")", "}"];

module.exports = () => {
  // ═══════════════ 1 · Why exception handling ═══════════════
  chapter("1 · Why exception handling?", "stage");
  add("Welcome back, coders. Today we study a very important topic: exception handling in Spring Boot.", { pose: "present", mood: "excited" });
  add("You may know exception handling from Java. In Spring Boot, it matters even more.", { pose: "point" });
  add("When something goes wrong in your backend, the client must get a proper response that says what happened.", { pose: "present", mood: "worried", ...alert("warning", "Something went wrong", "Does the client know what?") });
  add("Then the client knows which endpoint failed and why. And you can show a clear message.", { pose: "point", mood: "happy" });
  add("This topic is important for interviews, and for the apps you build yourself.", { pose: "smug", props: [{ type: "bulb" }] });
  add("So what is an API response? It has three parts: a status code, headers, and a body.", { pose: "present", ...steps(["Status code", "Headers", "Body"], 0) });
  add("The body is the data we give the client, usually in JSON format.", { pose: "point", ...steps(["Status code", "Headers", "Body"], 2) });
  add("Headers are key and value pairs. They carry extra information, or metadata, about the response.", { pose: "present", ...steps(["Status code", "Headers", "Body"], 1) });
  add("The status code is the most important part. It tells us what the response actually means.", { pose: "point", mood: "excited", ...steps(["Status code", "Headers", "Body"], 0) });
  add("Did it succeed? Did it fail? Could we fetch the data? Could we store it?", { pose: "think", mood: "confused" });
  add("This is where a professional API is very different from a beginner API.", { pose: "present" });
  add("A beginner API treats these three parts carelessly. A professional API uses each one on purpose.", { pose: "point", ...compare("versus", [{ title: "Beginner API", points: ["Same status for everything", "Random body"] }, { title: "Professional API", points: ["Right status code", "Clear, same-shape body"] }]) });
  add("Our job is to make our APIs professional, and better for every client.", { pose: "smug", mood: "happy" });
  add("The client may be Postman, or a front end application. Either way, give a better response.", { pose: "present" });
  add("This is why HTTP has many kinds of status codes. They come in five families.", { pose: "point", ttsText: "This is why H T T P has many kinds of status codes. They come in five families." });
  add("We will study each family soon. First, let us see what a professional API really means.", { pose: "present" });
  add("Imagine a GET request arrives at slash api slash students, for the student with id 1.", { pose: "point", ttsText: "Imagine a get request arrives at slash api slash students, for the student with id one.", ...browser("GET /api/students/1", "json", ["Host: localhost:8080"]) });
  add("The request has headers, and a host. Let us say the app runs on localhost, port 8080.", { pose: "present", ...browser("GET /api/students/1", "json", ["Host: localhost:8080"]) });
  add("Now, many things can happen to this one request.", { pose: "point", ...steps(SCENARIOS, 0) });
  add("The student data may be available. That is the happy case.", { pose: "present", mood: "happy", ...steps(SCENARIOS, 0) });
  add("Or the data may not be available at all.", { pose: "point", ...steps(SCENARIOS, 1) });
  add("Or the id format may be wrong. We expected a request parameter, but the client sent a path variable.", { pose: "present", ...steps(SCENARIOS, 2) });
  add("And some things are not in our hands. The database may be down, or the server may be down.", { pose: "point", mood: "worried", ...steps(SCENARIOS, 3) });
  add("Or maybe our own code has a bug.", { pose: "shrug", mood: "worried", props: [{ type: "bug" }], ...steps(SCENARIOS, 5) });
  add("A beginner makes one big mistake here. They give the same status to every response.", { pose: "point", mood: "worried" });
  add("Data found? They send 200. Data not found? They still send 200, with a message that says not found.", { pose: "present", mood: "confused", ...browser("200 OK", "json", ["{", "  \"message\": \"No data found\"", "}"]) });
  add("That is wrong. The meaning of 200 is success. Everything worked.", { pose: "point", mood: "angry", ...alert("error", "Wrong status", "200 says success, but the data was not found") });
  add("A wrong id format needs a different status. A database or server problem needs another. And a bug needs another.", { pose: "present", ...steps(SCENARIOS, 4) });
  add("A professional API handles each situation in its own way. Let us see an example.", { pose: "smug", mood: "excited" });
  add("Case one, the happy case. The data is available. We answer with 200 OK.", { pose: "present", mood: "happy", ...browser("200 OK", "json", OK_BODY) });
  add("The body is a student in JSON format, with the id, the name, and the email.", { pose: "point", ...browser("200 OK", "json", OK_BODY) });
  add("Case two. The student is not available. We must not send 200 here.", { pose: "present", mood: "worried" });
  add("The status code made for this is 404, which means not found.", { pose: "point", ...browser("404 Not Found", "json", ["{", "  \"message\": \"Student with id 100 not found\"", "}"]) });
  add("Be careful. Not found is 404. Some people confuse it with 400.", { pose: "smug", mood: "confused", ...compare("versus", [{ title: "404", points: ["Not Found", "The thing was not there"] }, { title: "400", points: ["Bad Request", "The request was wrong"] }]) });
  add("Case three. The client sent an invalid request, for example a wrong id format.", { pose: "present" });
  add("Whose fault is this? The client's. There is no problem on our server.", { pose: "point", mood: "happy" });
  add("For this we use 400, which means bad request. The request was bad, so we cannot serve it.", { pose: "present", ...browser("400 Bad Request", "json", ["{", "  \"message\": \"Student id must be a number\"", "}"]) });
  add("In the body, we can explain exactly what the client did wrong.", { pose: "point", mood: "happy" });
  add("Case four. The database is down, the server is down, or there is a bug we cannot identify.", { pose: "present", mood: "worried" });
  add("It is not a bad request, and it is not a success. Here we send 500, internal server error.", { pose: "point", ...browser("500 Internal Server Error", "json", ["{", "  \"message\": \"Something went wrong\"", "}"]) });
  add("You have seen 500 many times. It is a very generic error, and it can mean many things.", { pose: "smug", mood: "shrug" });
  add("When we do not know the problem, the safe message is: something went wrong.", { pose: "present" });
  add("So we saw four status codes: 200, 400, 404, and 500. We will use them all in exception handling.", { pose: "point", mood: "excited", ...compare("versus", [{ title: "Success", points: ["200 OK"] }, { title: "Problems", points: ["400 Bad Request", "404 Not Found", "500 Server Error"] }]) });
  add("Enough theory. Let us go to the code and make our API professional.", { pose: "celebrate", mood: "excited" });
  ask("The student id does not exist. Which status code?", ["200 OK", "404 Not Found", "500 Internal Server Error", "201 Created"], 1,
    "The request was fine, but the resource is not there. That is 404.");

  // ═══════════════ 2 · Our app and cleaner endpoints ═══════════════
  chapter("2 · Our app and cleaner endpoints", "office");
  add("Our example is the CRUD application we built in this series. Create, read, update, and delete.", { pose: "present", ...steps(["Create", "Read", "Update", "Delete"], 0) });
  add("It follows the usual layers: a controller, a service, and a repository, with a MySQL database.", { pose: "point", ...flow(["Controller", "Service", "Repository", "MySQL"], 0, "request") });
  add("We have a Student entity, and many DTOs. The create DTO and the update DTO are different.", { pose: "present", mood: "happy" });
  add("Use the project from video 16. Its notes have the download link, so we need not start from scratch.", { pose: "point", props: [{ type: "check" }] });
  add("Let us look at the folder structure. The package has controller, repository, service, entity, and DTO.", { pose: "present", ...steps(["controller", "service", "repository", "entity", "dto"], 0) });
  add("There is one controller, StudentController. Its service is StudentService, and its repository is StudentRepository.", { pose: "point", ttsText: "There is one controller, Student Controller. Its service is Student Service, and its repository is Student Repository." });
  add("We use JPA, so we do not write queries. The database is MySQL, and it holds two rows for now.", { pose: "present", ...table("student", ["id", "name", "email"], [["1", "Saurabh", "saurabh@gmail.com"], ["2", "Aditya", "ad@gmail.com"]], 1) });
  add("The Student entity has an id, name, age, email, roll number, subject, and a deleted flag.", { pose: "point", ...snap("Student.java", "java", ["@Entity", "public class Student {", "  @Id @GeneratedValue", "  private Long id;", "  private String name;", "  private int age;", "  private String email;", "  private boolean deleted;", "  // rollNumber, subject, createdAt, updatedAt", "}"], { highlight: [3, 4, 5, 6, 7] }) });
  add("The deleted flag is for soft delete. The id is the primary key, and it is generated automatically.", { pose: "present" });
  add("Now the controller. The class endpoint is slash api slash students.", { pose: "point", ...snap("StudentController.java", "java", OLD_CTRL, { highlight: [1] }) });
  add("But look at the methods. We have slash create, slash get, slash get all, slash update, and slash delete.", { pose: "present", mood: "worried", ...snap("StudentController.java", "java", OLD_CTRL, { highlight: [3, 4, 5, 6, 7] }) });
  add("This does not follow the Spring Boot standard for REST APIs. First, let us fix that.", { pose: "point", mood: "think" });
  add("Any request to slash api slash students goes to this controller. We do not need slash create after it.", { pose: "present" });
  add("A POST request to slash api slash students can only mean create. The method already tells us.", { pose: "point", mood: "excited", ...alert("success", "HTTP method says it", "POST means create, so no create in the URL") });
  add("A GET request with an id in the path means get one student. A GET without an id means get all.", { pose: "present", ...compare("versus", [{ title: "GET /api/students/1", points: ["Get one student"] }, { title: "GET /api/students", points: ["Get all students"] }]) });
  add("PUT means update, and DELETE means delete. So each pair of URL and method stays unique.", { pose: "point", ...compare("versus", [{ title: "PUT /api/students/1", points: ["Update"] }, { title: "DELETE /api/students/1", points: ["Delete"] }]) });
  add("So our first step to a professional API is to remove these extra endpoints.", { pose: "smug", mood: "happy" });
  add("The POST mapping becomes just PostMapping, with no path.", { pose: "present", ...snap("StudentController.java", "java", NEW_CTRL, { highlight: [3] }) });
  add("GET by id becomes GetMapping with slash id in curly brackets. Then we take the id as a path variable.", { pose: "point", ttsText: "Get by id becomes Get Mapping with slash id in curly brackets. Then we take the id as a path variable.", ...snap("StudentController.java", "java", NEW_CTRL, { highlight: [4] }) });
  add("Where we had RequestParam, we now write PathVariable. The id now comes from the path.", { pose: "present", ...snap("StudentController.java", "java", ["@GetMapping(\"/{id}\")", "public ResponseEntity<StudentResponseDTO> getStudent(", "    @PathVariable Long id) {", "  // ...", "}"], { highlight: [2] }) });
  add("GET with nothing else is get all. And PUT and DELETE also take the id from the path.", { pose: "point", ...snap("StudentController.java", "java", NEW_CTRL, { highlight: [5, 6, 7] }) });
  add("The soft delete uses PATCH. We leave it as it is, because it has no fixed endpoint.", { pose: "present", mood: "happy" });
  add("PATCH means you change one particular thing in the record. It is not only for soft delete.", { pose: "point" });
  add("We improved our endpoints. Let us run the application and test with Postman.", { pose: "celebrate", mood: "excited", ...term(["$ mvn spring-boot:run", "Started DemoApplication in 4.2 seconds"], "Run") });
  add("We choose POST, slash api slash students, and we leave the body for the next step.", { pose: "present", ttsText: "We choose post, slash api slash students, and we put a student in the body.", ...browser("POST /api/students", "json", ["{", "  \"name\": \"Rohit\",", "  \"age\": 29,", "  \"email\": \"rohit@gmail.com\",", "  \"rollNumber\": 103,", "  \"subject\": \"NodeJS\"", "}"]) });
  add("The create DTO expects a name, age, email, roll number, and subject. And it already has validations.", { pose: "point" });
  add("We send it, and the response is 201 Created, with the full student. It works.", { pose: "present", mood: "happy", ...browser("201 Created", "json", ["{", "  \"id\": 3,", "  \"name\": \"Rohit\",", "  \"email\": \"rohit@gmail.com\"", "}"]) });
  add("Refresh the table in DBeaver, and the new record is there. Nothing is broken.", { pose: "celebrate", mood: "happy", ...table("student", ["id", "name", "email"], [["1", "Saurabh", "saurabh@gmail.com"], ["2", "Aditya", "ad@gmail.com"], ["3", "Rohit", "rohit@gmail.com"]], 2) });
  add("But using the Spring Boot standard did not solve all our problems. Many remain.", { pose: "shrug", mood: "worried" });
  add("Our API still looks like a beginner API. To see why, look closely at the controller.", { pose: "point", mood: "think" });
  ask("Why do we no longer need slash create in the URL?", ["POST already means create", "Spring blocks it", "It is slower", "Postman cannot send it"], 0,
    "The HTTP method tells the action, so the pair of URL and method stays unique.");
};
