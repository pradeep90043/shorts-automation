// Chapters 8-11: the request DTO, mapping in the service and the response DTO, the demo, and the proof of decoupling.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const REQ_DTO = ["public class CreateStudentRequestDTO {", "  private String name;", "  private int age;", "  private String email;", "  private int rollNumber;", "  private String subject;", "  // getters and setters", "}"];
const RES_DTO = ["public class CreateStudentResponseDTO {", "  private Long id;", "  private String name;", "  private int age;", "  private String email;", "  private int rollNumber;", "  private String subject;", "  private String message;", "  // getters and setters", "}"];
const TO_ENTITY = ["private Student mapToEntity(", "    CreateStudentRequestDTO dto) {", "  Student student = new Student();", "  student.setName(dto.getName());", "  student.setAge(dto.getAge());", "  student.setEmail(dto.getEmail());", "  student.setRollNumber(dto.getRollNumber());", "  student.setSubject(dto.getSubject());", "  student.setDeleted(false);", "  return student;", "}"];
const TO_DTO = ["private CreateStudentResponseDTO mapToDTO(", "    Student student) {", "  CreateStudentResponseDTO dto =", "      new CreateStudentResponseDTO();", "  dto.setId(student.getId());", "  dto.setName(student.getName());", "  // age, email, rollNumber, subject the same way", "  dto.setMessage(\"Student saved successfully\");", "  return dto;", "}"];
const CREATE = ["public CreateStudentResponseDTO createStudent(", "    CreateStudentRequestDTO request) {", "  Student student = mapToEntity(request);", "  Student saved = studentRepository.save(student);", "  return mapToDTO(saved);", "}"];

module.exports = () => {
  // ═══════════════ 8 · The request DTO ═══════════════
  chapter("8 · Building the request DTO", "office");
  add("Time to build. First, make a new package called dto.", { pose: "present", ttsText: "Time to build. First, make a new package called D T O.", ...steps(["controller", "service", "repository", "entity", "dto (new)"], 4) });
  add("Inside it, a class for the create request: CreateStudentRequestDTO.", { pose: "point", ...snap("CreateStudentRequestDTO.java", "java", REQ_DTO, { highlight: [0] }) });
  add("It has only the fields we want from the client: name, age, email, roll number, and subject.", { pose: "present", ...snap("CreateStudentRequestDTO.java", "java", REQ_DTO, { highlight: [1, 2, 3, 4, 5] }) });
  add("There is no id, because the server generates it. And no deleted, no timestamps.", { pose: "point", mood: "happy", ...compare("versus", [{ title: "Client sends", points: ["name", "age", "email", "rollNumber", "subject"] }, { title: "Server controls", points: ["id", "deleted", "createdAt", "updatedAt"] }]) });
  add("Then we generate the getters and setters, as usual.", { pose: "present" });
  add("Now the controller expects this DTO in the request body, instead of the entity.", { pose: "point", ...snap("StudentController.java", "java", ["public ResponseEntity<CreateStudentResponseDTO> create(", "    @RequestBody CreateStudentRequestDTO request) {", "  // pass the DTO to the service", "}"], { highlight: [1] }) });
  add("Look at what we gained. The client cannot send deleted by mistake, because the controller does not expect it.", { pose: "smug", mood: "happy", ...alert("success", "Protected", "Unknown fields are simply ignored") });
  add("Our API contract is now exactly these five keys.", { pose: "present", ...steps(["name", "age", "email", "rollNumber", "subject"], 4) });
  add("There is one problem. The service gets a DTO, but the repository only saves entities.", { pose: "point", mood: "confused", ...flow(["DTO", "Service", "Repository"], 1, "?") });
  add("Someone must convert the DTO into an entity. But who? The controller, the service, or the repository?", { pose: "think", props: [{ type: "question" }] });
  add("Not the repository. Its only job is talking to the database.", { pose: "point" });
  add("For now, we use the service, because that is where business logic lives.", { pose: "present", mood: "happy" });
  add("In bigger projects, you move this work into separate mapper classes, which the service calls.", { pose: "smug", ...flow(["Service", "Mapper", "Entity"], 1, "convert") });

  // ═══════════════ 9 · Mapping and the response DTO ═══════════════
  chapter("9 · Mapping and the response DTO", "office");
  add("Inside the service, we write a private method: mapToEntity.", { pose: "present", ...snap("StudentService.java", "java", TO_ENTITY.slice(0, 2), { highlight: [0] }) });
  add("It creates a new Student, then copies the fields from the DTO, one by one.", { pose: "point", ...snap("StudentService.java", "java", TO_ENTITY.slice(0, 8), { highlight: [2, 3, 4, 5, 6, 7] }) });
  add("Then it sets deleted to false. The server decides this, not the client.", { pose: "present", mood: "happy", ...snap("StudentService.java", "java", TO_ENTITY, { highlight: [8] }) });
  add("The protection we wrote by hand earlier now lives right here, in one place.", { pose: "point", ...alert("success", "One place", "deleted is always false on create") });
  add("Copying fields one by one is not perfect. You can forget a key.", { pose: "shrug", mood: "worried" });
  add("A later video shows the Builder pattern, which makes this safer.", { pose: "point", mood: "happy" });
  add("After we save, the repository returns an entity. We must not send it to the client.", { pose: "present", ...flow(["Repository", "Student entity", "Client"], 2, "no!") });
  add("So we make a response DTO, with the fields we are happy to share.", { pose: "point", ...snap("CreateStudentResponseDTO.java", "java", RES_DTO, { highlight: [0] }) });
  add("It has the id, so the front end can fetch this student later.", { pose: "present", ...snap("CreateStudentResponseDTO.java", "java", RES_DTO, { highlight: [1] }) });
  add("It also has a message. That is an extra key that is not in the entity at all.", { pose: "point", ...snap("CreateStudentResponseDTO.java", "java", RES_DTO, { highlight: [7] }) });
  add("This message is only to show the idea. Proper response bodies come in the exception handling videos.", { pose: "shrug", mood: "happy" });
  add("Now the second mapping method: mapToDTO. It turns an entity into a response DTO.", { pose: "present", ...snap("StudentService.java", "java", TO_DTO.slice(0, 4), { highlight: [0] }) });
  add("It copies the id, the name, and the other fields, from the entity.", { pose: "point", ...snap("StudentService.java", "java", TO_DTO.slice(0, 7), { highlight: [4, 5, 6] }) });
  add("And it sets the message: Student saved successfully.", { pose: "present", ...snap("StudentService.java", "java", TO_DTO, { highlight: [7] }) });
  add("Both mapping methods are private, because nobody outside the service uses them.", { pose: "smug" });
  add("Now the create method ties it together. Map to entity, save, and map to DTO.", { pose: "present", ...snap("StudentService.java", "java", CREATE, { highlight: [2, 3, 4] }) });
  add("The controller returns the response DTO, so the client now gets exactly what we choose.", { pose: "point", mood: "happy", ...flow(["Client", "Request DTO", "Service", "Entity"], 3, "map") });
  add("The whole flow, with DTOs: the client sends a request DTO, and the service turns it into an entity.", { pose: "present", ...flow(["Client", "Request DTO", "Service", "Entity"], 2, "convert") });
  add("The entity is saved. Then the service turns it into a response DTO, and sends that back.", { pose: "point", ...flow(["Entity", "Service", "Response DTO", "Client"], 3, "convert") });

  // ═══════════════ 10 · The demo ═══════════════
  chapter("10 · It works: the demo", "office");
  add("Let us run it. In Postman, we create a student named Saurav.", { pose: "present", mood: "excited", ...browser("POST /api/students/create", "json", ["{", "  \"name\": \"Saurav\",", "  \"age\": 27,", "  \"email\": \"saurav@gmail.com\",", "  \"rollNumber\": 108,", "  \"subject\": \"React\"", "}"]) });
  add("The response comes back with a message, and only the keys we chose.", { pose: "point", mood: "happy", ...browser("201 Created", "json", ["{", "  \"id\": 1,", "  \"name\": \"Saurav\",", "  \"age\": 27,", "  \"rollNumber\": 108,", "  \"message\": \"Student saved successfully\"", "}"]) });
  add("Notice what is missing. There is no deleted flag in the response.", { pose: "smug", mood: "happy", ...alert("success", "No deleted flag", "The client only sees what we chose") });
  add("We are in full control, of what we take from the user, and what we give back.", { pose: "celebrate", mood: "excited" });

  // ═══════════════ 11 · Decoupling proof ═══════════════
  chapter("11 · Proof: the client does not change", "classroom");
  add("Now let us prove the decoupling. We add two fields to the entity: createdAt and updatedAt.", { pose: "present", ...snap("Student.java", "java", ["private LocalDateTime createdAt;", "private LocalDateTime updatedAt;", "// getters and setters"], { highlight: [0, 1] }) });
  add("They use LocalDateTime, the Java class for a date and a time.", { pose: "point" });
  add("The controller still expects the same request DTO. So the client's request does not change at all.", { pose: "present", mood: "excited", ...flow(["Client", "Request DTO", "Controller"], 1, "same") });
  add("In the service, on creation, we set both fields to the current time.", { pose: "point", ...snap("StudentService.java", "java", ["student.setCreatedAt(LocalDateTime.now());", "student.setUpdatedAt(LocalDateTime.now());"], { highlight: [0, 1] }) });
  add("When a record is updated later, only updatedAt changes.", { pose: "present", mood: "happy" });
  add("We want the client to see these dates, so we add them to the response DTO.", { pose: "point", ...snap("CreateStudentResponseDTO.java", "java", ["private LocalDateTime createdAt;", "private LocalDateTime updatedAt;", "// getters and setters"], { highlight: [0, 1] }) });
  add("And in mapToDTO, we copy them across from the entity.", { pose: "present", ...snap("StudentService.java", "java", ["dto.setCreatedAt(student.getCreatedAt());", "dto.setUpdatedAt(student.getUpdatedAt());"], { highlight: [0, 1] }) });
  add("If we did not want the client to see them, we would simply not set them.", { pose: "smug", mood: "happy" });
  add("The database gets two new date time columns. We create another student.", { pose: "point", ...table("student", ["id", "name", "createdAt"], [["1", "Saurav", "2026-10-12 10:30"]], 0) });
  add("The response now includes the dates, and the database row has every field.", { pose: "present", mood: "happy", ...browser("201 Created", "json", ["{", "  \"id\": 1,", "  \"name\": \"Saurav\",", "  \"message\": \"Student saved successfully\",", "  \"createdAt\": \"2026-10-12T10:30:00\",", "  \"updatedAt\": \"2026-10-12T10:30:00\"", "}"]) });
  add("The client request did not change. The database did. That is decoupling.", { pose: "celebrate", mood: "excited", ...alert("success", "Decoupled", "Change the entity, and the client does not care") });
};
