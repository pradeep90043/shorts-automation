// Chapters 5-7: the response leaks internals, tight coupling and the API contract, what a DTO is.
const L = require("./lib");
const { add, ask, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap } = L;

const PROBLEMS = ["One class, too many jobs", "Client tied to our internals", "Client can send sensitive data", "We can send sensitive data", "Checks forgotten in the service"];
const LEAKY = ["{", "  \"id\": 1,", "  \"name\": \"Ayesha\",", "  \"age\": 25,", "  \"email\": \"ayesha@gmail.com\",", "  \"deleted\": false,", "  \"createdAt\": \"2026-10-12\"", "}"];

module.exports = () => {
  // ═══════════════ 5 · Problem 2: the response leaks ═══════════════
  chapter("5 · Problem 2: the response leaks", "office");
  add("Now the other direction: the response. Look at what we return to the client.", { pose: "present", ...flow(["Database", "Service", "Controller", "Client"], 3, "Student") });
  add("We return the same entity. So every field on it goes out.", { pose: "point", mood: "worried" });
  add("Here is a response for a new student, Ayesha. Notice the last two lines.", { pose: "present", ...browser("200 OK", "json", LEAKY) });
  add("The client now sees our deleted flag, and our internal timestamps.", { pose: "point", mood: "shocked", ...browser("200 OK", "json", LEAKY) });
  add("Why should a React app know which internal keys your server uses?", { pose: "think", mood: "confused", props: [{ type: "question" }] });
  add("It gets worse. An entity may also hold sensitive data, like a password.", { pose: "point", mood: "worried", props: [{ type: "lock" }] });
  add("Return the entity, and everything on it goes out, unless you remember to hide it.", { pose: "shrug", mood: "worried", ...alert("warning", "The entity leaks", "Every field is sent to the client") });

  // ═══════════════ 6 · Problem 3: coupling and the contract ═══════════════
  chapter("6 · Problem 3: tight coupling", "classroom");
  add("Third problem: tight coupling. Imagine you later change your database.", { pose: "present", mood: "worried" });
  add("You split the name column into firstName and lastName.", { pose: "point", ...compare("beforeAfter", [{ title: "Before", points: ["name"] }, { title: "After", points: ["firstName", "lastName"] }]) });
  add("Because the entity is also your API, the JSON keys change too.", { pose: "present", mood: "shocked", ...browser("POST /api/students", "json", ["{", "  \"firstName\": \"Aditya\",", "  \"lastName\": \"Sharma\"", "}"]) });
  add("Every client that sends a name key now breaks. You must tell all of them to change.", { pose: "point", mood: "worried", ...alert("error", "Clients break", "The old name key no longer exists") });
  add("The fields you expect from the client, and promise to return, are your API contract.", { pose: "present", mood: "excited", props: [{ type: "check" }] });
  add("If the entity is your contract, every database change breaks that contract.", { pose: "smug", mood: "worried" });
  add("Here is a way to think about it: two worlds.", { pose: "present" });
  add("The external world is outside your application, where clients call you over the internet.", { pose: "point", ...scene("sky", [{ asset: "globe", x: 22, y: 52, size: 40, label: "External world" }, { asset: "server", x: 78, y: 52, size: 40, label: "Internal world", tint: "gold" }], [{ from: [34, 52], to: [66, 52] }]) });
  add("The internal world starts the moment a call reaches your controller.", { pose: "present", ...scene("sky", [{ asset: "globe", x: 22, y: 52, size: 40, label: "External world" }, { asset: "server", x: 78, y: 52, size: 40, label: "Internal world", tint: "gold" }], [{ from: [34, 52], to: [66, 52] }]) });
  add("The entity must live in the internal world only. Its message is simply: what to store in the database.", { pose: "point", mood: "happy", ...flow(["Client", "Controller", "Service", "Entity"], 3, "internal only") });
  add("So we need another class, one that talks to the client, while the entity stays hidden.", { pose: "present", mood: "excited", props: [{ type: "bulb" }] });
  add("Let us collect all the problems we found.", { pose: "point" });
  add("One class has too many jobs. And the client gets tied to our internal world.", { pose: "present", ...steps(PROBLEMS, 1) });
  add("The client can send sensitive data, and we can send sensitive data back.", { pose: "point", ...steps(PROBLEMS, 3) });
  add("And we need many checks in the service layer. If we forget one, bad data is stored.", { pose: "present", mood: "worried", ...steps(PROBLEMS, 4) });
  add("We do not want to give the client the power to send our internal keys.", { pose: "smug", mood: "angry" });
  ask("Why is the entity risky as a request body?", ["It is slower", "The client can send fields like deleted or createdAt", "It cannot be saved", "JSON cannot map to it"], 1,
    "The client can send fields that only the server should set.");

  // ═══════════════ 7 · What is a DTO ═══════════════
  chapter("7 · What is a DTO?", "classroom");
  add("A DTO is a Data Transfer Object. The name sounds fancy, but the idea is simple.", { pose: "present", mood: "happy" });
  add("It is a normal Java class, with private fields, getters and setters. Just like the entity.", { pose: "point", ...snap("StudentDTO.java", "java", ["public class StudentDTO {", "  private String name;", "  private String email;", "  // getters and setters", "}"], { highlight: [1, 2] }) });
  add("The difference is its purpose: it carries data to and from the client.", { pose: "present", ...flow(["Client", "DTO", "Controller"], 1, "data") });
  add("It holds only the fields you want to receive, or only the fields you want to give back.", { pose: "point", ...compare("versus", [{ title: "Entity", points: ["id", "name", "age", "email", "deleted", "createdAt"] }, { title: "DTO", points: ["name", "age", "email"] }]) });
  add("You can think of a DTO as a smaller piece of the entity.", { pose: "smug", mood: "happy" });
  add("A request and a response can differ. So we make two kinds: a request DTO and a response DTO.", { pose: "present", ...compare("versus", [{ title: "Request DTO", points: ["name", "age", "email", "rollNumber", "subject"] }, { title: "Response DTO", points: ["id, name, age, email", "rollNumber, subject", "message"] }]) });
  add("This is a very standard practice in Spring Boot, and you will see it in every real project.", { pose: "point", mood: "excited" });
  add("Now the client talks to DTOs at the edge, and the entity stays inside.", { pose: "present", ...flow(["Client", "DTO", "Service", "Entity"], 1, "DTO") });
  add("And the entity can finally focus on a single job: the database.", { pose: "celebrate", mood: "happy", ...alert("success", "Responsibilities split", "DTO talks to the client, the entity talks to the database") });
};
