// Chapter 12: separate DTOs for create and update, the update demo, converting the GET endpoints.
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const UPDATE_REQ = ["public class UpdateStudentRequestDTO {", "  private String name;", "  private int age;", "  private int rollNumber;", "  private String subject;", "  // getters and setters", "}"];
const UPDATE_RES = ["public class UpdateStudentResponseDTO {", "  private Long id;", "  private String name;", "  private int age;", "  private String email;", "  private int rollNumber;", "  private String subject;", "  private String message;", "  private LocalDateTime updatedAt;", "}"];
const UPDATE_CTRL = ["@PutMapping(\"/update\")", "public ResponseEntity<UpdateStudentResponseDTO> update(", "    @RequestParam Long id,", "    @RequestBody UpdateStudentRequestDTO request) {", "  // call the service", "}"];
const UPDATE_A = ["public UpdateStudentResponseDTO updateStudent(", "    Long id, UpdateStudentRequestDTO request) {", "  Optional<Student> existing =", "      studentRepository.findByIdAndDeletedFalse(id);", "  if (existing.isEmpty()) {", "    return null;", "  }", "  Student student = existing.get();"];
const UPDATE_B = ["  student.setName(request.getName());", "  student.setAge(request.getAge());", "  student.setRollNumber(request.getRollNumber());", "  student.setSubject(request.getSubject());", "  student.setUpdatedAt(LocalDateTime.now());", "  Student saved = studentRepository.save(student);", "  return mapToUpdateDTO(saved);", "}"];
const TO_UPDATE_DTO = ["private UpdateStudentResponseDTO mapToUpdateDTO(", "    Student student) {", "  UpdateStudentResponseDTO dto =", "      new UpdateStudentResponseDTO();", "  dto.setId(student.getId());", "  // name, age, email, rollNumber, subject", "  dto.setMessage(\"Student updated successfully\");", "  dto.setUpdatedAt(student.getUpdatedAt());", "  return dto;", "}"];

module.exports = () => {
  chapter("12 · Different DTOs for create and update", "office");
  add("The same idea works for every endpoint. Let us do the update endpoint.", { pose: "present", ...steps(["Create", "Read", "Update", "Delete"], 2) });
  add("When we create a student, the client sends everything. When we update, the rules can differ.", { pose: "point", mood: "think" });
  add("In our app, a student may change the name, age, roll number, or subject.", { pose: "present", ...compare("versus", [{ title: "Can change", points: ["name", "age", "rollNumber", "subject"] }, { title: "Cannot change", points: ["email", "id"] }]) });
  add("But not the email. Many apps do not allow an email change after signup. And the id never changes.", { pose: "point", ...compare("versus", [{ title: "Can change", points: ["name", "age", "rollNumber", "subject"] }, { title: "Cannot change", points: ["email", "id"] }]) });
  add("So the update request gets its own DTO, with only four fields.", { pose: "present", mood: "happy", ...snap("UpdateStudentRequestDTO.java", "java", UPDATE_REQ, { highlight: [1, 2, 3, 4] }) });
  add("There is no email in it. The client simply cannot send one.", { pose: "smug", ...alert("success", "No email field", "The rule is built into the class") });
  add("The update response DTO has the same keys as the create response, plus updatedAt.", { pose: "point", ...snap("UpdateStudentResponseDTO.java", "java", UPDATE_RES, { highlight: [7, 8] }) });
  add("It leaves out createdAt, just to show you the flexibility. You decide what each client sees.", { pose: "present", mood: "happy" });
  add("Why keep separate DTOs if they look alike today? Tomorrow, update may need more or fewer fields.", { pose: "smug", props: [{ type: "bulb" }] });
  add("In the controller, the update endpoint takes the id as a request parameter, and the DTO in the body.", { pose: "point", ...snap("StudentController.java", "java", UPDATE_CTRL, { highlight: [2, 3] }) });
  add("The service method starts by finding the student, using our custom method.", { pose: "present", ...snap("StudentService.java", "java", UPDATE_A, { highlight: [2, 3] }) });
  add("findByIdAndDeletedFalse skips students that are soft deleted.", { pose: "point", ...snap("StudentService.java", "java", UPDATE_A, { highlight: [3] }) });
  add("If nothing is found, we return null. Otherwise, we take the entity out.", { pose: "present", ...snap("StudentService.java", "java", UPDATE_A, { highlight: [4, 5, 7] }) });
  add("Then we copy the name, age, roll number, and subject from the DTO.", { pose: "point", ...snap("StudentService.java", "java", UPDATE_B, { highlight: [0, 1, 2, 3] }) });
  add("There is no setEmail line, because the update DTO does not even have an email.", { pose: "smug", ...snap("StudentService.java", "java", UPDATE_B, { highlight: [0, 1, 2, 3] }) });
  add("We set updatedAt to now, save, and map the result to the update response.", { pose: "present", ...snap("StudentService.java", "java", UPDATE_B, { highlight: [4, 5, 6] }) });
  add("The new mapping method fills the message, Student updated successfully, and updatedAt.", { pose: "point", ...snap("StudentService.java", "java", TO_UPDATE_DTO, { highlight: [6, 7] }) });
  add("Let us test it. A PUT request to update, with the id as a parameter.", { pose: "present", mood: "excited", ...browser("PUT /api/students/update?id=1", "json", ["{", "  \"name\": \"Saurabh\",", "  \"age\": 27,", "  \"rollNumber\": 1001,", "  \"subject\": \"MERN\"", "}"]) });
  add("We fix the spelling of the name, and change the subject. The body has no email.", { pose: "point", ...browser("PUT /api/students/update?id=1", "json", ["{", "  \"name\": \"Saurabh\",", "  \"age\": 27,", "  \"rollNumber\": 1001,", "  \"subject\": \"MERN\"", "}"]) });
  add("The response shows the new details and the new update time, but no createdAt.", { pose: "present", mood: "happy", ...browser("200 OK", "json", ["{", "  \"id\": 1,", "  \"name\": \"Saurabh\",", "  \"subject\": \"MERN\",", "  \"message\": \"Student updated successfully\",", "  \"updatedAt\": \"2026-10-12T11:05:00\"", "}"]) });
  add("The database row changed too. Different DTOs control exactly what can change.", { pose: "celebrate", mood: "happy", ...table("student", ["id", "name", "subject"], [["1", "Saurabh", "MERN"]], 0) });
  add("The get by id endpoint also returned an entity before. Now it calls mapToDTO instead.", { pose: "point", ...snap("StudentService.java", "java", ["// getStudent: after finding the entity", "return mapToDTO(student);"], { highlight: [1] }) });
  add("For get all, we convert every entity in the list, using a stream.", { pose: "present", ...snap("StudentService.java", "java", ["return students.stream()", "    .map(this::mapToDTO)", "    .collect(Collectors.toList());"], { highlight: [0, 1, 2] }) });
  add("If streams are new to you, a simple for loop does the same job.", { pose: "shrug", mood: "happy" });
  add("Delete and soft delete need no DTO. They take no entity, and return no entity.", { pose: "point" });
  add("The takeaway: DTOs make your application scalable, and keep the outside and inside worlds apart.", { pose: "smug", mood: "excited" });
  add("One question to check. Why does the update DTO have no email?", { pose: "think" });
  add("Why no email in the update DTO?", { pose: "point", ...quiz("Why does UpdateStudentRequestDTO have no email?", ["Email is not a valid field", "A business rule: email cannot change after creation", "Email is generated automatically", "DTOs cannot hold strings"], 1) });
  add("Right. It is a business rule, and the DTO makes the rule impossible to break.", { pose: "celebrate", mood: "happy" });
};
