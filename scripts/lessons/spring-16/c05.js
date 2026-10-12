// Chapters 13-17: why validations, the starter, the annotations and @Valid, the demo (and its honest ending), the recap.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const BAD = ["{", "  \"name\": \"   \",", "  \"age\": 4,", "  \"email\": \"abc\",", "  \"rollNumber\": 0,", "  \"subject\": \"\"", "}"];
const POM = ["<dependency>", "  <groupId>org.springframework.boot</groupId>", "  <artifactId>spring-boot-starter-validation</artifactId>", "</dependency>"];
const ERR400 = ["{", "  \"timestamp\": \"2026-10-12T11:30:00\",", "  \"status\": 400,", "  \"error\": \"Bad Request\",", "  \"path\": \"/api/students/create\"", "}"];
const RECAP = ["Entities do too many jobs", "DTOs split request and response", "The service maps entity and DTO", "Validations stop bad data", "Next: exception handling"];

module.exports = () => {
  // ═══════════════ 13 · Why validations ═══════════════
  chapter("13 · Why we need validations", "classroom");
  add("DTOs protect us from extra fields. But the client can still send bad data.", { pose: "present", mood: "worried" });
  add("Look at this request. Everything in it is wrong, yet nothing stops it.", { pose: "point", mood: "shocked", ...browser("POST /api/students/create", "json", BAD) });
  add("The name is only spaces. The email is not an email. The subject is empty.", { pose: "point", mood: "worried", ...browser("POST /api/students/create", "json", BAD) });
  add("And the age is four. Do we want a four year old using our college app?", { pose: "shrug", mood: "confused", ...browser("POST /api/students/create", "json", BAD) });
  add("Right now, our service trusts the client blindly. It maps the data, adds the dates, and saves.", { pose: "present", mood: "worried", ...flow(["Client", "Controller", "Service", "Database"], 3, "bad data") });
  add("That is very dangerous. Bad data is stored in the database.", { pose: "point", mood: "shocked", ...alert("error", "Bad data saved", "Nothing checked what the client sent") });
  add("We could write validation code inside the service. But the service is special.", { pose: "think" });
  add("It is where your real business logic lives, like complex calculations. We should protect it.", { pose: "present", mood: "happy", props: [{ type: "lock" }] });
  add("Basic checks should stop at the controller. If one fails, the request never reaches the service.", { pose: "point", ...flow(["Client", "Controller + checks", "Service", "Database"], 1, "rejected") });
  add("Spring Boot gives us annotation based validation. We write the rules directly on the DTO fields.", { pose: "smug", mood: "excited", props: [{ type: "bulb" }] });
  add("Complex business rules still belong in the service. Only the basic checks move out.", { pose: "present" });

  // ═══════════════ 14 · The dependency ═══════════════
  chapter("14 · Adding the validation starter", "office");
  add("First, we add a dependency: spring-boot-starter-validation.", { pose: "present", ...snap("pom.xml", "xml", POM, { highlight: [2] }) });
  add("You do not need to memorize this name. On Spring Initializr, just search for validation.", { pose: "point", mood: "happy", ...browser("start.spring.io", "page", ["Add dependencies", "Search: validation", "Validation (I/O)"], "Spring Initializr") });
  add("For an existing project, search Maven Central, and copy the dependency into your pom file.", { pose: "present", ...snap("pom.xml", "xml", POM, { highlight: [1, 2] }) });
  add("But remove the version. Our project uses the Spring Boot parent, which manages compatible versions.", { pose: "point", mood: "excited", ...snap("pom.xml", "xml", POM, { highlight: [1, 2] }) });
  add("That avoids a mismatch between starters, like data JPA and validation on different versions.", { pose: "present", ...alert("success", "No version needed", "The parent manages every starter version") });
  add("Reload Maven, and the validation starter appears in the dependency list.", { pose: "point", mood: "happy", ...steps(["spring-boot-starter-data-jpa", "spring-boot-starter-webmvc", "spring-boot-starter-validation", "mysql-connector-j"], 2) });

  // ═══════════════ 15 · The annotations ═══════════════
  chapter("15 · Annotations on the request DTO", "office");
  add("Validation rules go on the request DTO, because that is the object the client fills in.", { pose: "present", ...snap("CreateStudentRequestDTO.java", "java", ["public class CreateStudentRequestDTO {", "  private String name;", "  private int age;", "  // other fields", "}"], { highlight: [0] }) });
  add("For the name, we use NotBlank. It rejects null, empty text, and text with only spaces.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", ["public class CreateStudentRequestDTO {", "  @NotBlank", "  private String name;", "  private int age;", "  // other fields", "}"], { highlight: [1] }) });
  add("For the age, we use Min, with a value of eighteen. Nobody younger can register.", { pose: "present", ...snap("CreateStudentRequestDTO.java", "java", ["public class CreateStudentRequestDTO {", "  @NotBlank", "  private String name;", "  @Min(value = 18)", "  private int age;", "  // other fields", "}"], { highlight: [3] }) });
  add("For the email, we use Email. Spring checks the proper email format for us.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", ["@Email", "private String email;", "", "@NotBlank", "private String subject;"], { highlight: [0] }) });
  add("The subject is text too, so it also gets NotBlank.", { pose: "present", ...snap("CreateStudentRequestDTO.java", "java", ["@Email", "private String email;", "", "@NotBlank", "private String subject;"], { highlight: [3] }) });
  add("There are many more annotations. Here are the common ones.", { pose: "point", ...table("Common validation annotations", ["Annotation", "What it checks"], [["NotNull", "value is not null"], ["NotBlank", "text has real characters"], ["Email", "valid email format"], ["Min, Max", "number limits"], ["Size", "text length"], ["Past, Future", "dates"]], 1) });
  add("The three most common are easy to mix up. Let us compare them.", { pose: "think" });
  add("NotNull only checks for null. An empty text, or a text of spaces, still passes.", { pose: "present", ...table("Which values are rejected?", ["Annotation", "null", "empty text", "only spaces"], [["NotNull", "rejected", "allowed", "allowed"], ["NotEmpty", "rejected", "rejected", "allowed"], ["NotBlank", "rejected", "rejected", "rejected"]], 0) });
  add("NotEmpty rejects null and empty text, but spaces still pass.", { pose: "point", ...table("Which values are rejected?", ["Annotation", "null", "empty text", "only spaces"], [["NotNull", "rejected", "allowed", "allowed"], ["NotEmpty", "rejected", "rejected", "allowed"], ["NotBlank", "rejected", "rejected", "rejected"]], 1) });
  add("NotBlank rejects all three. So for text, prefer NotBlank.", { pose: "smug", mood: "happy", ...table("Which values are rejected?", ["Annotation", "null", "empty text", "only spaces"], [["NotNull", "rejected", "allowed", "allowed"], ["NotEmpty", "rejected", "rejected", "allowed"], ["NotBlank", "rejected", "rejected", "rejected"]], 2) });
  add("Quick check. Which one rejects null, empty text, and only spaces?", { pose: "think" });
  add("Which annotation rejects all three?", { pose: "point", ...quiz("Which annotation rejects null, empty text, and only spaces?", ["NotNull", "NotEmpty", "NotBlank", "Size"], 2) });
  add("Correct. NotBlank is the strictest of the three, and the best choice for text.", { pose: "celebrate", mood: "happy" });
  add("Numbers need a small fix. A primitive int can never be null.", { pose: "present", mood: "worried" });
  add("So for age and roll number, we use the wrapper type Integer, with a capital I, and NotNull.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", ["@NotNull", "@Min(value = 18)", "private Integer age;", "", "@NotNull", "private Integer rollNumber;"], { highlight: [0, 2, 4, 5] }) });
  add("Now the important part. Nothing happens yet. We must also add Valid in the controller.", { pose: "point", mood: "excited", ...alert("warning", "Not enough yet", "The annotations do nothing without Valid") });
  add("We put Valid before the request body parameter.", { pose: "present", ...snap("StudentController.java", "java", ["public ResponseEntity<CreateStudentResponseDTO> create(", "    @Valid @RequestBody CreateStudentRequestDTO request) {", "  // ...", "}"], { highlight: [1] }) });
  add("Valid tells Spring to apply every rule on the DTO. Without it, no validation runs.", { pose: "smug" });
  add("Which annotation switches the rules on?", { pose: "point", ...quiz("What must you add to the controller parameter so the rules actually run?", ["Valid", "Validate", "Check", "Nothing, it is automatic"], 0) });
  add("Valid, exactly. You can add the same rules to the update DTO, in the same way.", { pose: "celebrate", mood: "happy" });

  // ═══════════════ 16 · The demo and the honest ending ═══════════════
  chapter("16 · The demo", "office");
  add("Let us test it. We send a request with a blank name and a blank email.", { pose: "present", mood: "excited", ...browser("POST /api/students/create", "json", ["{", "  \"name\": \"\",", "  \"age\": 27,", "  \"email\": \"\",", "  \"rollNumber\": 105,", "  \"subject\": \"React\"", "}"]) });
  add("The response is four hundred, Bad Request. The request was rejected.", { pose: "point", mood: "happy", ...browser("400 Bad Request", "json", ERR400) });
  add("It never reached the service. So the validation is working.", { pose: "celebrate", mood: "happy", ...flow(["Client", "Controller + checks", "Service"], 1, "rejected") });
  add("But the response does not say what was wrong. The client is left guessing.", { pose: "shrug", mood: "worried", ...browser("400 Bad Request", "json", ERR400) });
  add("So we add a custom message to each annotation. First, the name.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", ["@NotBlank(message = \"Name can not be blank\")", "@Size(min = 2, max = 50,", "      message = \"Name must be 2 to 50 characters\")", "private String name;"], { highlight: [0, 1, 2] }) });
  add("Size limits the length. Names shorter than two, or longer than fifty, are rejected.", { pose: "present", ...snap("CreateStudentRequestDTO.java", "java", ["@NotBlank(message = \"Name can not be blank\")", "@Size(min = 2, max = 50,", "      message = \"Name must be 2 to 50 characters\")", "private String name;"], { highlight: [1, 2] }) });
  add("Now the age, with a message for the missing value, and a message for the minimum.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", ["@NotNull(message = \"Age is required\")", "@Min(value = 18,", "     message = \"Student must be at least 18\")", "private Integer age;"], { highlight: [0, 1, 2] }) });
  add("The email gets two rules: it must not be blank, and it must be valid.", { pose: "present", ...snap("CreateStudentRequestDTO.java", "java", ["@NotBlank(message = \"Email can not be blank\")", "@Email(message = \"Email must be valid\")", "private String email;"], { highlight: [0, 1] }) });
  add("And messages for the roll number and the subject, in the same way.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", ["@NotNull(message = \"Roll number is required\")", "private Integer rollNumber;", "", "@NotBlank(message = \"Subject is required\")", "private String subject;"], { highlight: [0, 3] }) });
  add("We restart, and send the same bad request again. We expect our messages.", { pose: "think", mood: "excited" });
  add("Surprise. The response is still the plain four hundred, with no custom messages.", { pose: "shocked", mood: "confused", ...browser("400 Bad Request", "json", ERR400) });
  add("Why? The validation works, and the request is rejected. But Spring Boot's default error response is used.", { pose: "point", mood: "think", props: [{ type: "question" }] });
  add("Until we customize how errors are handled, the same generic response always goes out.", { pose: "present" });
  add("Customizing that is called exception handling, and it is the topic of the next video.", { pose: "smug", mood: "excited", props: [{ type: "rocket" }] });
  add("One last question. Why does Postman still show only a generic four hundred?", { pose: "think" });
  add("Why only a generic 400?", { pose: "point", ...quiz("Why does the response still show only a generic 400 Bad Request?", ["The validations are broken", "Spring's default error response is used until we customize it", "Postman hides the messages", "The database is down"], 1) });
  add("Yes. The validation works. The messages need exception handling, which comes next.", { pose: "celebrate", mood: "happy" });
  add("Finally, fix the body: a real name, an age of nineteen, and a valid email. The request is accepted.", { pose: "present", mood: "excited", ...browser("201 Created", "json", ["{", "  \"id\": 2,", "  \"name\": \"Aditya\",", "  \"age\": 19,", "  \"email\": \"adi@gmail.com\",", "  \"message\": \"Student saved successfully\"", "}"]) });

  // ═══════════════ 17 · Recap and next ═══════════════
  chapter("17 · Recap and what is next", "stage");
  add("Let us recap. First, the entity should only map to the database.", { pose: "present", ...steps(RECAP, 0) });
  add("Second, DTOs split the request and the response from the entity.", { pose: "point", ...steps(RECAP, 1) });
  add("Third, the service maps between entities and DTOs, so the client sees only what you choose.", { pose: "present", ...steps(RECAP, 2) });
  add("Fourth, validation annotations and Valid stop bad data at the controller.", { pose: "point", ...steps(RECAP, 3) });
  add("This makes your API safer, cleaner, and ready to grow.", { pose: "celebrate", mood: "happy" });
  add("Next, we will handle exceptions properly, so clients see exactly which rule they broke.", { pose: "present", mood: "excited", ...steps(RECAP, 4) });
  add("Later, we will also see the Builder pattern, and separate mapper classes.", { pose: "point", mood: "happy" });
  add("Your task: add validation annotations to the update DTO, and test each rule in Postman.", { pose: "smug", mood: "excited", props: [{ type: "rocket" }] });
  add("If anything is unclear, ask in the comments, and see you in the next video.", { pose: "celebrate", mood: "happy" });
};
