// Chapters 9-10: embedded Tomcat, the three dependencies, and the Student REST app (entity, repository, service, controller).
const L = require("./lib");
const { add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const DEPS = ["Spring MVC (spring-webmvc)", "Embedded Tomcat", "Jackson (JSON ↔ Java)"];
const LAYERS = ["StudentController", "StudentService", "StudentRepository", "HashMap (डेटाबेस)"];

const STUDENT = ["public class Student {", "  private Long id;", "  private String name;", "  private String email;", "  // getters और setters", "}"];
const REPO = [
  "@Repository",
  "public class StudentRepository {",
  "  private Map<Long, Student> studentDB;",
  "",
  "  public StudentRepository() {",
  "    studentDB = new HashMap<>();",
  "  }",
  "}",
];
const REPO_METHODS = [
  "public Student save(Student student) {",
  "  studentDB.put(student.getId(), student);",
  "  return student;",
  "}",
  "public Student findById(Long id) {",
  "  return studentDB.get(id);",
  "}",
  "public List<Student> findAll() {",
  "  return new ArrayList<>(studentDB.values());",
  "}",
];
const SERVICE = [
  "@Service",
  "public class StudentService {",
  "  private StudentRepository studentRepository;",
  "",
  "  public StudentService(StudentRepository repo) {",
  "    this.studentRepository = repo;",
  "  }",
  "}",
];
const SERVICE_METHODS = [
  "public Student createStudent(Student s) {",
  "  return studentRepository.save(s);",
  "}",
  "public Student getStudent(Long id) {",
  "  return studentRepository.findById(id);",
  "}",
  "public List<Student> getAllStudent() {",
  "  return studentRepository.findAll();",
  "}",
];
const CONTROLLER = [
  "@RestController",
  "@RequestMapping(\"/students\")",
  "public class StudentController {",
  "  private StudentService studentService;",
  "",
  "  public StudentController(StudentService service) {",
  "    this.studentService = service;",
  "  }",
  "}",
];

module.exports = () => {
  // ═══════════════ 9 · Embedded Tomcat and the dependencies ═══════════════
  chapter("9 · बिना Boot के प्रोजेक्ट की तैयारी", "office");
  add("अब वही सब खुद बनाकर देखते हैं। पहले एक सवाल: Tomcat का इस्तेमाल दो तरह से होता है।", { pose: "present", ...compare("versus", [{ title: "External Tomcat", points: ["WAR फ़ाइल बनाओ", "अलग सर्वर पर डिप्लॉय करो"] }, { title: "Embedded Tomcat", points: ["Tomcat ऐप के अंदर", "JAR चलाते ही सर्वर चालू"] }]) });
  add("External में WAR फ़ाइल बनती है, और उसे अलग Tomcat सर्वर पर डिप्लॉय करते हैं।", { pose: "point", ...compare("versus", [{ title: "External Tomcat", points: ["WAR फ़ाइल बनाओ", "अलग सर्वर पर डिप्लॉय करो"] }, { title: "Embedded Tomcat", points: ["Tomcat ऐप के अंदर", "JAR चलाते ही सर्वर चालू"] }]) });
  add("Embedded में Tomcat हमारे ऐप के अंदर ही रहता है। काम दोनों में एक जैसा है।", { pose: "present", ...flow(["Client", "Tomcat", "DispatcherServlet"], 2, "") });
  add("Tomcat सुनता है, और रिक्वेस्ट DispatcherServlet को दे देता है। हम Embedded चुनते हैं।", { pose: "point", mood: "happy" });
  add("IntelliJ में नया Maven प्रोजेक्ट बनाइए, नाम रखिए spring-mvc-demo।", { pose: "present", ttsText: "इंटेलीजे में नया मेवन प्रोजेक्ट बनाइए, नाम रखिए स्प्रिंग एमवीसी डेमो।", ...browser("IntelliJ IDEA", "page", ["नया प्रोजेक्ट: spring-mvc-demo", "बिल्ड सिस्टम: Maven", "JDK 23"], "New Project") });
  add("Spring Boot के बिना हमें तीन चीज़ें खुद जोड़नी होंगी। इसके लिए Boot में सिर्फ़ एक स्टार्टर काफ़ी होता है।", { pose: "point", ...steps(DEPS, 0) });
  add("पहली, Spring MVC। इसी से @GetMapping और @RestController जैसे एनोटेशन्स आते हैं।", { pose: "present", ...snap("pom.xml", "xml", ["<dependency>", "  <artifactId>spring-webmvc</artifactId>", "  <version>7.0.7</version>", "</dependency>"], { highlight: [1] }) });
  add("दूसरी, Embedded Tomcat, यानी tomcat-embed-core, ताकि सर्वर हमारे ऐप में चल सके।", { pose: "point", ttsText: "दूसरी, एम्बेडेड टॉमकैट, यानी टॉमकैट एम्बेड कोर, ताकि सर्वर हमारे ऐप में चल सके।", ...snap("pom.xml", "xml", ["<dependency>", "  <artifactId>tomcat-embed-core</artifactId>", "  <version>11.0.22</version>", "</dependency>"], { highlight: [1] }) });
  add("तीसरी, Jackson, जो JSON को Java ऑब्जेक्ट में, और वापस JSON में बदलती है।", { pose: "present", ...snap("pom.xml", "xml", ["<dependency>", "  <artifactId>jackson-databind</artifactId>", "</dependency>"], { highlight: [1] }) });
  add("Spring Boot में एक ही डिपेंडेंसी, spring-boot-starter-web, ये तीनों ले आती है।", { pose: "smug", ...compare("versus", [{ title: "Spring Boot", points: ["spring-boot-starter-web", "बस एक लाइन"] }, { title: "सिर्फ़ Spring MVC", points: ["तीनों डिपेंडेंसी हाथ से", "ज़्यादा कॉन्फ़िगरेशन"] }]) });
  add("एम्बेडेड Tomcat के साथ WAR की ज़रूरत नहीं। JAR चलाइए, और सर्वर अपने आप उठ जाएगा।", { pose: "present", mood: "happy" });

  // ═══════════════ 10 · The Student REST app ═══════════════
  chapter("10 · Student ऐप: चार क्लासें", "office");
  add("अब एक छोटा ऐप बनाते हैं। पहले चार परतें तय करते हैं।", { pose: "present", ...flow(LAYERS, 3, "") });
  add("सबसे पहले Student क्लास। इसमें तीन फ़ील्ड हैं: id, name और email।", { pose: "point", ...snap("Student.java", "java", STUDENT, { highlight: [1, 2, 3] }) });
  add("id का टाइप है Long, और साथ में सारे getters और setters भी।", { pose: "present", ...snap("Student.java", "java", STUDENT, { highlight: [1, 4] }) });
  add("पैकेज के नाम हमेशा छोटे अक्षरों में रखिए, जैसे entity। ये अभी JPA एंटिटी नहीं है।", { pose: "smug", ...alert("success", "package entity", "कोई JPA एनोटेशन नहीं, सिर्फ़ एक साधारण क्लास") });
  add("अब Repository। असली डेटाबेस की जगह हम एक HashMap इस्तेमाल करेंगे।", { pose: "point", ...snap("StudentRepository.java", "java", REPO, { highlight: [2, 5] }) });
  add("इसका नाम studentDB है, और @Repository के अंदर भी @Component छिपा है।", { pose: "present", ...snap("StudentRepository.java", "java", REPO, { highlight: [0, 2] }) });
  add("पहला मेथड save: Student को HashMap में id के साथ रख देता है।", { pose: "point", ...snap("StudentRepository.java", "java", REPO_METHODS.slice(0, 4), { highlight: [1] }) });
  add("दूसरा findById: id से एक Student ढूँढता है।", { pose: "present", ...snap("StudentRepository.java", "java", REPO_METHODS.slice(0, 7), { highlight: [4, 5] }) });
  add("और तीसरा findAll: सारे Students की लिस्ट लौटाता है।", { pose: "point", ...snap("StudentRepository.java", "java", REPO_METHODS, { highlight: [7, 8] }) });
  add("JPA और JDBC बाद में आएँगे। अभी हमारा ध्यान सिर्फ़ Spring MVC पर है।", { pose: "shrug", mood: "happy" });
  add("अब Service। इसके कंस्ट्रक्टर में Repository आता है, इसलिए @Autowired की ज़रूरत नहीं।", { pose: "present", ...snap("StudentService.java", "java", SERVICE, { highlight: [2, 4, 5] }) });
  add("Service में तीन मेथड हैं: createStudent, getStudent और getAllStudent।", { pose: "point", ...snap("StudentService.java", "java", SERVICE_METHODS, { highlight: [0, 3, 6] }) });
  add("हर मेथड सीधा काम Repository को सौंप देता है।", { pose: "present", ...flow(["StudentService", "StudentRepository", "HashMap"], 1, "save/find") });
  add("अब Controller। @RestController लगाया, और पूरी क्लास के लिए @RequestMapping में /students लिखा।", { pose: "point", ttsText: "अब कंट्रोलर। रेस्ट कंट्रोलर लगाया, और पूरी क्लास के लिए रिक्वेस्ट मैपिंग में स्लैश स्टूडेंट्स लिखा।", ...snap("StudentController.java", "java", CONTROLLER, { highlight: [0, 1] }) });
  add("Controller के कंस्ट्रक्टर में Service आता है। यहाँ भी कंस्ट्रक्टर इंजेक्शन है।", { pose: "present", ...snap("StudentController.java", "java", CONTROLLER, { highlight: [5, 6] }) });
  add("पहला एंडपॉइंट, POST। खाली पाथ काफ़ी है, क्योंकि क्लास पर /students पहले से लगा है।", { pose: "point", ttsText: "पहला एंडपॉइंट, पोस्ट। खाली पाथ काफ़ी है, क्योंकि क्लास पर स्लैश स्टूडेंट्स पहले से लगा है।", ...snap("StudentController.java", "java", ["@PostMapping", "public ResponseEntity<Student> createAStudent(", "    @RequestBody Student studentRequest) {", "  Student response =", "    studentService.createStudent(studentRequest);", "  return ResponseEntity.ok(response);", "}"], { highlight: [0, 2] }) });
  add("@RequestBody का मतलब है कि बॉडी का JSON Student ऑब्जेक्ट बन जाए, और जवाब में 200 OK लौटे।", { pose: "present", ...snap("StudentController.java", "java", ["@PostMapping", "public ResponseEntity<Student> createAStudent(", "    @RequestBody Student studentRequest) {", "  Student response =", "    studentService.createStudent(studentRequest);", "  return ResponseEntity.ok(response);", "}"], { highlight: [2, 5] }) });
  add("दूसरा एंडपॉइंट, id से एक Student पाने के लिए GET, @PathVariable के साथ।", { pose: "point", ...snap("StudentController.java", "java", ["@GetMapping(\"/{id}\")", "public ResponseEntity<Student> getStudent(", "    @PathVariable(\"id\") Long id) {", "  Student response = studentService.getStudent(id);", "  if (response == null) {", "    return ResponseEntity.notFound().build();", "  }", "  return ResponseEntity.ok(response);", "}"], { highlight: [0, 2] }) });
  add("अगर Student न मिले, तो 404 Not Found लौटता है। मिल जाए, तो 200 OK के साथ Student।", { pose: "present", ...snap("StudentController.java", "java", ["@GetMapping(\"/{id}\")", "public ResponseEntity<Student> getStudent(", "    @PathVariable(\"id\") Long id) {", "  Student response = studentService.getStudent(id);", "  if (response == null) {", "    return ResponseEntity.notFound().build();", "  }", "  return ResponseEntity.ok(response);", "}"], { highlight: [4, 5, 7] }) });
  add("तीसरा एंडपॉइंट, सारे Students की लिस्ट के लिए GET, बिना किसी id के।", { pose: "point", ...snap("StudentController.java", "java", ["@GetMapping", "public ResponseEntity<List<Student>> getAll() {", "  List<Student> students =", "    studentService.getAllStudent();", "  return ResponseEntity.ok(students);", "}"], { highlight: [0, 1] }) });
  add("तीनों एंडपॉइंट तैयार हैं: POST, GET by id, और GET all।", { pose: "celebrate", mood: "happy", ...table("हमारे एंडपॉइंट", ["मेथड", "पाथ", "काम"], [["POST", "/students", "Student बनाना"], ["GET", "/students/{id}", "एक Student"], ["GET", "/students", "सारे Students"]], 0) });
  add("अब अगर ये Spring Boot होता, तो हम सीधे Run दबा देते।", { pose: "smug", mood: "smug" });
  add("पर यहाँ सिर्फ़ Spring MVC है। इसलिए हमें सब कुछ खुद कॉन्फ़िगर करना होगा।", { pose: "point", mood: "worried", ...alert("warning", "अभी ये नहीं चलेगा", "न Tomcat है, न DispatcherServlet") });
};
