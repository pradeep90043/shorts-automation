// Chapters 8-10: one error DTO for every exception, validation errors with field messages, recap.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const DTO = ["public class ExceptionResponseDTO {", "  private LocalDateTime timestamp;", "  private int statusCode;", "  private String error;", "  private String message;", "  private String path;", "  // constructor, getters and setters", "}"];
const BUILD = ["ExceptionResponseDTO response =", "    new ExceptionResponseDTO(", "        LocalDateTime.now(),", "        HttpStatus.NOT_FOUND.value(),", "        HttpStatus.NOT_FOUND.getReasonPhrase(),", "        ex.getMessage(),", "        request.getRequestURI());"];
const H_NEW = ["@ExceptionHandler(ResourceNotFoundException.class)", "public ResponseEntity<ExceptionResponseDTO>", "    handleResourceNotFound(", "        ResourceNotFoundException ex,", "        HttpServletRequest request) {", "  ExceptionResponseDTO response = ...;", "  return ResponseEntity", "      .status(HttpStatus.NOT_FOUND)", "      .body(response);", "}"];
const VAL_DTO = ["public class ValidationExceptionResponseDTO {", "  private LocalDateTime timestamp;", "  private int statusCode;", "  private String error;", "  private String message;", "  private String path;", "  private Map<String, String> fieldErrors;", "}"];
const VAL_HANDLER = ["@ExceptionHandler(", "    MethodArgumentNotValidException.class)", "public ResponseEntity<ValidationExceptionResponseDTO>", "    handleValidation(", "        MethodArgumentNotValidException ex,", "        HttpServletRequest request) {", "  Map<String, String> fieldErrors = new HashMap<>();", "  ex.getBindingResult().getFieldErrors()", "      .forEach(error -> fieldErrors.put(", "          error.getField(),", "          error.getDefaultMessage()));", "  // build the DTO and return 400", "}"];
const FIELD_JSON = ["{", "  \"statusCode\": 400,", "  \"error\": \"Bad Request\",", "  \"message\": \"Validation failed\",", "  \"path\": \"/api/students\",", "  \"fieldErrors\": {", "    \"name\": \"Name cannot be null\",", "    \"email\": \"Student email must be valid\",", "    \"age\": \"Student must be at least 18\"", "  }", "}"];

module.exports = () => {
  // ═══════════════ 8 · One response format ═══════════════
  chapter("8 · One error response for everyone", "office");
  add("There is one thing left. Our handlers return a plain String. That is not good.", { pose: "present", mood: "worried" });
  add("A plain string in JSON looks bare. The client gets no details, and it does not feel professional.", { pose: "point", ...browser("404 Not Found", "json", ["Student with id 100 not found"]) });
  add("So we make our own error DTO. Every error will use the same one response format.", { pose: "present", mood: "excited" });
  add("In the DTO package, create a new class, ExceptionResponseDTO.", { pose: "point", ttsText: "In the D T O package, create a new class, Exception Response D T O.", ...snap("ExceptionResponseDTO.java", "java", DTO, { highlight: [0] }) });
  add("It holds mostly what Spring Boot's default body had, because those are the right things to keep.", { pose: "present" });
  add("A timestamp, to know when the error happened. A status code. The error name.", { pose: "point", ...snap("ExceptionResponseDTO.java", "java", DTO, { highlight: [1, 2, 3] }) });
  add("Then a meaningful message, our own. Remember, the default message gave the client internal details.", { pose: "present", ...snap("ExceptionResponseDTO.java", "java", DTO, { highlight: [4] }) });
  add("And the path, which tells us from which endpoint the exception came.", { pose: "point", ...snap("ExceptionResponseDTO.java", "java", DTO, { highlight: [5] }) });
  add("We generate a constructor, and getters and setters, with the IDE.", { pose: "smug", mood: "happy" });
  add("Now we change every handler to return this DTO, and not a String.", { pose: "present", ...snap("GlobalExceptionHandler.java", "java", H_NEW, { highlight: [1] }) });
  add("We build the object right inside the handler. First the time: LocalDateTime dot now.", { pose: "point", ttsText: "We build the object right inside the handler. First the time: Local Date Time dot now.", ...snap("GlobalExceptionHandler.java", "java", BUILD, { highlight: [2] }) });
  add("Then the status code. We want 404, so we take it from HttpStatus dot NOT FOUND, with dot value.", { pose: "present", ttsText: "Then the status code. We want four oh four, so we take it from Http Status dot not found, with dot value.", ...snap("GlobalExceptionHandler.java", "java", BUILD, { highlight: [3] }) });
  add("HttpStatus is an enum, so we take its value. For the error name, we take the reason phrase.", { pose: "point", ...snap("GlobalExceptionHandler.java", "java", BUILD, { highlight: [3, 4] }) });
  add("The message is the exception's own message.", { pose: "present", ...snap("GlobalExceptionHandler.java", "java", BUILD, { highlight: [5] }) });
  add("And for the path, we need the HttpServletRequest. It holds all the information about the request.", { pose: "point", ttsText: "And for the path, we need the Http Servlet Request. It holds all the information about the request.", ...snap("GlobalExceptionHandler.java", "java", H_NEW, { highlight: [3, 4] }) });
  add("The dispatcher servlet creates it, so we simply take it as a parameter, and ask for the request URI.", { pose: "present", ...snap("GlobalExceptionHandler.java", "java", BUILD, { highlight: [6] }) });
  add("We put this response in the body of the ResponseEntity, and it goes to the client.", { pose: "point", mood: "happy", ...snap("GlobalExceptionHandler.java", "java", H_NEW, { highlight: [6, 7, 8] }) });
  add("We do the same for every other handler. The duplicate handler uses CONFLICT, which is 409.", { pose: "present", ttsText: "We do the same for every other handler. The duplicate handler uses Conflict, which is four oh nine." });
  add("The runtime handler and the generic handler use INTERNAL SERVER ERROR. The shape stays the same.", { pose: "point", mood: "happy" });
  add("The values change, but the format is always alike. Let us see it.", { pose: "present", mood: "excited" });
  add("We run it, and fetch student 100 again.", { pose: "point", ...browser("GET /api/students/100", "json", ["Host: localhost:8080"]) });
  add("Now we get a proper body. The time, 404, Not Found, our message, and the exact path.", { pose: "celebrate", mood: "happy", ...browser("404 Not Found", "json", ["{", "  \"timestamp\": \"2026-10-12T12:05:44\",", "  \"statusCode\": 404,", "  \"error\": \"Not Found\",", "  \"message\": \"Student with id 100 not found\",", "  \"path\": \"/api/students/100\"", "}"]) });

  // ═══════════════ 9 · Validation errors ═══════════════
  chapter("9 · Validation errors with field messages", "classroom");
  add("One thing is still missing. In the last lecture, we added validations on our request DTOs.", { pose: "present" });
  add("We wanted those messages to reach the client. Right now they do not.", { pose: "point", mood: "worried", ...snap("CreateStudentRequestDTO.java", "java", ["@NotBlank(message = \"Name cannot be null\")", "private String name;", "@Min(value = 18, message = \"Student must be at least 18\")", "private int age;"], { highlight: [0, 2] }) });
  add("Spring Boot's default handling ran, and hid them. Now that we control things, we can show them.", { pose: "present", mood: "excited" });
  add("When a validation fails, Spring throws a specific exception. Its name is MethodArgumentNotValidException.", { pose: "point", ttsText: "When a validation fails, Spring throws a specific exception. Its name is Method Argument Not Valid Exception." });
  add("It already exists in Spring, so we do not write it. But we have no method for it yet.", { pose: "present" });
  add("So the generic handler would catch it, because Exception is the parent of everything.", { pose: "point", mood: "worried" });
  add("We add a handler for exactly this exception. Whenever a validation fails, it will run.", { pose: "present", mood: "excited", ...snap("GlobalExceptionHandler.java", "java", VAL_HANDLER, { highlight: [0, 1, 4] }) });
  add("There may be many errors at once. The name may be blank, the age too low, and the email wrong.", { pose: "point", mood: "think" });
  add("So we need a list of all of them. A simple message is not enough.", { pose: "present" });
  add("We need a new DTO, ValidationExceptionResponseDTO. It has the same five fields as before.", { pose: "point", ttsText: "We need a new D T O, Validation Exception Response D T O. It has the same five fields as before.", ...snap("ValidationExceptionResponseDTO.java", "java", VAL_DTO, { highlight: [1, 2, 3, 4, 5] }) });
  add("Plus one more: a Map of String and String, named fieldErrors.", { pose: "present", ttsText: "Plus one more: a Map of String and String, named field Errors.", ...snap("ValidationExceptionResponseDTO.java", "java", VAL_DTO, { highlight: [6] }) });
  add("The key is the field name, and the value is the error message for that field.", { pose: "point", ...compare("versus", [{ title: "Key", points: ["name", "email", "age"] }, { title: "Value", points: ["Name cannot be null", "Email must be valid", "At least 18"] }]) });
  add("Where do we get the map? From the exception. Spring puts all failed validations in it.", { pose: "present", mood: "excited" });
  add("We call getBindingResult on the exception, and then getFieldErrors. That is a list of field errors.", { pose: "point", ttsText: "We call get Binding Result on the exception, and then get Field Errors. That is a list of field errors.", ...snap("GlobalExceptionHandler.java", "java", VAL_HANDLER, { highlight: [7] }) });
  add("Each field error has the field name, and a default message, which is our message from the annotation.", { pose: "present", ...snap("GlobalExceptionHandler.java", "java", VAL_HANDLER, { highlight: [9, 10] }) });
  add("We loop with forEach, and put each field and message into a new HashMap.", { pose: "point", ...snap("GlobalExceptionHandler.java", "java", VAL_HANDLER, { highlight: [6, 8, 9, 10] }) });
  add("Then we pass this map into the new DTO, with the other values.", { pose: "present", ...snap("GlobalExceptionHandler.java", "java", VAL_HANDLER, { highlight: [11] }) });
  add("The status here must not be 409. A failed validation is a bad request, so we use 400.", { pose: "point", mood: "happy", ttsText: "The status here must not be four oh nine. A failed validation is a bad request, so we use four hundred." });
  add("For the main message, we do not use the exception's long message. It would show too many details.", { pose: "present", mood: "worried" });
  add("We write our own, short one: Validation failed. It sounds simpler.", { pose: "point", mood: "happy" });
  add("Let us test. We post a student with a very bad name, an age of 17, and an invalid email.", { pose: "present", mood: "excited", ...browser("POST /api/students", "json", ["{", "  \"name\": \"\",", "  \"age\": 17,", "  \"email\": \"saurabh.gmail.com\"", "}"]) });
  add("We get the time, the status 400, the error, and the message: Validation failed.", { pose: "point", ...browser("400 Bad Request", "json", FIELD_JSON) });
  add("And look at the field errors. The name cannot be null. The email must be valid. The student must be at least 18.", { pose: "celebrate", mood: "happy", ...browser("400 Bad Request", "json", FIELD_JSON) });
  add("What a neatly formatted response for the client. It sounds very professional.", { pose: "smug", mood: "excited" });
  add("And the path tells us which endpoint this came from.", { pose: "point" });
  add("Now we post correct data, a new student with a fresh email. We get 201 Created, as expected.", { pose: "present", mood: "happy", ...browser("201 Created", "json", ["{", "  \"id\": 4,", "  \"name\": \"Alia\",", "  \"email\": \"alia@gmail.com\"", "}"]) });
  add("And if we reuse an email already in use, we get 409 Conflict, in the same clean format.", { pose: "point", ttsText: "And if we reuse an email already in use, we get four oh nine Conflict, in the same clean format.", ...browser("409 Conflict", "json", ["{", "  \"statusCode\": 409,", "  \"error\": \"Conflict\",", "  \"message\": \"Student with email already exists\",", "  \"path\": \"/api/students\"", "}"]) });
  add("Our exception handling now works well, and our API is far more professional.", { pose: "celebrate", mood: "happy" });
  ask("Which exception does Spring throw when @Valid fails?", ["MethodArgumentNotValidException", "ResourceNotFoundException", "NullPointerException", "ArithmeticException"], 0,
    "Spring throws MethodArgumentNotValidException, and its binding result holds all the field errors.");

  // ═══════════════ 10 · Recap ═══════════════
  chapter("10 · Recap", "stage");
  add("Let us recap what we built today. First, we cleaned up the endpoints to follow the Spring Boot standard.", { pose: "present", mood: "happy", ...steps(["Clean endpoints", "Exception flow", "GlobalExceptionHandler", "Custom exceptions", "One error DTO", "Field errors"], 0) });
  add("We split our flow in two. The controller handles the happy flow, and exceptions go another way.", { pose: "point", ...steps(["Clean endpoints", "Exception flow", "GlobalExceptionHandler", "Custom exceptions", "One error DTO", "Field errors"], 1) });
  add("We wrote a GlobalExceptionHandler, with RestControllerAdvice and ExceptionHandler methods.", { pose: "present", ttsText: "We wrote a Global Exception Handler, with Rest Controller Advice and Exception Handler methods.", ...steps(["Clean endpoints", "Exception flow", "GlobalExceptionHandler", "Custom exceptions", "One error DTO", "Field errors"], 2) });
  add("We created our own exceptions, ResourceNotFound for 404, and DuplicateResource for 409.", { pose: "point", ttsText: "We created our own exceptions, Resource Not Found for four oh four, and Duplicate Resource for four oh nine.", ...steps(["Clean endpoints", "Exception flow", "GlobalExceptionHandler", "Custom exceptions", "One error DTO", "Field errors"], 3) });
  add("We gave every error the same shape, with one DTO. And validation errors list each field.", { pose: "present", ...steps(["Clean endpoints", "Exception flow", "GlobalExceptionHandler", "Custom exceptions", "One error DTO", "Field errors"], 5) });
  add("Our controller and service now look premium. You can see that this API was built professionally.", { pose: "smug", mood: "excited" });
  add("I hope you enjoyed it, and learned a lot. That is all for this lecture.", { pose: "celebrate", mood: "happy" });
  add("Try the project yourself, and add one new exception of your own. See you in the next video. Thank you so much.", { pose: "present", mood: "happy", props: [{ type: "rocket" }] });
};
