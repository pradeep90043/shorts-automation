import fs from "fs";
import path from "path";

/**
 * Lesser-known stories and facts from Indian mythology and history: the seed of every mythology Short. The LLM writes the
 * telling; the topic decides WHAT is told, so the channel stays on stories that exist in the texts instead of whatever a
 * model invents. Each topic names the text it comes from, which goes into the prompt and the description.
 */
export interface MythTopic {
  id: string;
  /** what the Short is about, in English (the prompt language) */
  topic: string;
  /** the text or record it comes from, cited in the description */
  source: string;
}

export const MYTH_TOPICS: MythTopic[] = [
  { id: "karna-kavach", topic: "How Karna gave away his divine armour and earrings to Indra, knowing it would cost him his life", source: "Mahabharata, Vana Parva" },
  { id: "barbarik", topic: "Barbarik, the warrior who could end the Kurukshetra war in one minute with three arrows, and why Krishna asked for his head", source: "Skanda Purana" },
  { id: "eklavya-thumb", topic: "Eklavya cutting off his thumb as guru dakshina for Dronacharya", source: "Mahabharata, Adi Parva" },
  { id: "abhimanyu-chakravyuh", topic: "How Abhimanyu learned to enter the Chakravyuh while still in his mother's womb, and why he never learned to exit", source: "Mahabharata, Drona Parva" },
  { id: "bhishma-arrows", topic: "Bhishma lying on a bed of arrows for 58 days, waiting for Uttarayana to choose his own death", source: "Mahabharata, Bhishma and Anushasana Parva" },
  { id: "yaksha-prashna", topic: "The Yaksha's questions to Yudhishthira at the poisoned lake and the answer that saved his brothers", source: "Mahabharata, Vana Parva" },
  { id: "draupadi-akshaya", topic: "The Akshaya Patra given to the Pandavas and how one grain of rice fed sage Durvasa and his disciples", source: "Mahabharata, Vana Parva" },
  { id: "ghatotkacha", topic: "Ghatotkacha's last night at Kurukshetra and why Karna had to use his one-time weapon on him", source: "Mahabharata, Drona Parva" },
  { id: "shikhandi", topic: "Shikhandi, who was Amba in a past life and was born to cause Bhishma's fall", source: "Mahabharata, Udyoga Parva" },
  { id: "arjuna-brihannala", topic: "Arjuna living a year as Brihannala, a dance teacher, because of Urvashi's curse", source: "Mahabharata, Virata Parva" },
  { id: "krishna-death", topic: "How Krishna left the world: the hunter Jara's arrow and the end of Dwarka", source: "Mahabharata, Mausala Parva; Bhagavata Purana" },
  { id: "sanjaya-vision", topic: "Sanjaya's divine sight: how the Kurukshetra war was narrated live to blind Dhritarashtra", source: "Mahabharata, Bhishma Parva" },
  { id: "gandhari-blindfold", topic: "Why Gandhari blindfolded herself for life, and the one time she opened her eyes for Duryodhana", source: "Mahabharata, Adi and Stri Parva" },
  { id: "pandavas-swarga", topic: "The Pandavas' last journey to the Himalayas and the dog that followed Yudhishthira to heaven's gate", source: "Mahabharata, Mahaprasthanika Parva" },
  { id: "jarasandha", topic: "Jarasandha, the king born in two halves joined by a demoness, and how Bhima defeated him", source: "Mahabharata, Sabha Parva" },
  { id: "hanuman-sun", topic: "Child Hanuman leaping to swallow the sun, mistaking it for a fruit", source: "Valmiki Ramayana, Kishkindha Kanda" },
  { id: "hanuman-forgot", topic: "Why Hanuman forgot his own powers until Jambavan reminded him", source: "Valmiki Ramayana, Kishkindha Kanda" },
  { id: "ram-setu-squirrel", topic: "The squirrel that helped build Ram Setu and the stripes on its back", source: "Folk tradition linked to the Ramayana" },
  { id: "kumbhakarna-boon", topic: "How one slip of the tongue gave Kumbhakarna sleep instead of eternal rule", source: "Valmiki Ramayana, Uttara Kanda" },
  { id: "urmila-sleep", topic: "Urmila, Lakshmana's wife, who slept for fourteen years so he could stay awake guarding Rama", source: "Folk Ramayana traditions" },
  { id: "jatayu", topic: "Jatayu, the old vulture who fought Ravana to save Sita", source: "Valmiki Ramayana, Aranya Kanda" },
  { id: "vibhishana-choice", topic: "Vibhishana leaving his brother Ravana to join Rama, and what it cost him", source: "Valmiki Ramayana, Yuddha Kanda" },
  { id: "sanjeevani", topic: "Hanuman carrying the whole Dronagiri mountain because he could not find the Sanjeevani herb", source: "Valmiki Ramayana, Yuddha Kanda" },
  { id: "shabari", topic: "Shabari's years of waiting for Rama and the berries she tasted before offering them", source: "Ramayana traditions, Aranya Kanda" },
  { id: "ravana-veena", topic: "Ravana the scholar: the Shiva Tandava Stotram and the Rudra Veena", source: "Ramayana traditions; Shiva Tandava Stotram" },
  { id: "samudra-manthan", topic: "The churning of the ocean and why Shiva drank the poison Halahala", source: "Bhagavata Purana, Vishnu Purana" },
  { id: "ganga-descent", topic: "Bhagiratha's penance and how Shiva caught the Ganga in his hair", source: "Valmiki Ramayana, Bala Kanda; Bhagavata Purana" },
  { id: "markandeya", topic: "Markandeya, the boy destined to die at sixteen who held on to the Shiva linga when Yama came", source: "Markandeya Purana" },
  { id: "nachiketa", topic: "Nachiketa, the boy who waited three days at Yama's door and asked what happens after death", source: "Katha Upanishad" },
  { id: "savitri-satyavan", topic: "Savitri following Yama and winning back Satyavan's life with clever wishes", source: "Mahabharata, Vana Parva" },
  { id: "dhruva", topic: "Dhruva, the five-year-old whose penance made him the Pole Star", source: "Vishnu Purana, Bhagavata Purana" },
  { id: "prahlad-narasimha", topic: "Narasimha appearing from a pillar at dusk, neither man nor animal, to keep Brahma's boon intact", source: "Bhagavata Purana" },
  { id: "vamana", topic: "Vamana's three steps and King Bali's promise", source: "Bhagavata Purana" },
  { id: "ganesha-mahabharata", topic: "Ganesha writing the Mahabharata as Vyasa dictated, and the broken tusk", source: "Mahabharata, Adi Parva (later tradition)" },
  { id: "ganesha-moon", topic: "Why Ganesha cursed the moon, and why some avoid looking at it on Ganesh Chaturthi", source: "Puranic tradition" },
  { id: "kartikeya-race", topic: "The race around the world between Ganesha and Kartikeya", source: "Puranic tradition" },
  { id: "shiva-third-eye-kama", topic: "Kamadeva burned to ashes by Shiva's third eye", source: "Shiva Purana, Kumarasambhavam" },
  { id: "parvati-penance", topic: "Parvati's penance to win Shiva", source: "Shiva Purana" },
  { id: "kashi-never-destroyed", topic: "Why Kashi is said to rest on Shiva's trident and never be destroyed", source: "Kashi Khanda, Skanda Purana" },
  { id: "vishwamitra-trishanku", topic: "Vishwamitra creating a second heaven for King Trishanku", source: "Valmiki Ramayana, Bala Kanda" },
  { id: "harishchandra", topic: "King Harishchandra, who gave up his kingdom, family and freedom to keep his word", source: "Markandeya Purana" },
  { id: "dadhichi-bones", topic: "Sage Dadhichi giving his bones to make Indra's Vajra", source: "Rigveda tradition; Bhagavata Purana" },
  { id: "shakuntala-ring", topic: "Shakuntala, the lost ring and Durvasa's curse", source: "Mahabharata, Adi Parva; Kalidasa" },
  { id: "nala-damayanti", topic: "Nala and Damayanti: a swan messenger, a lost kingdom and a game of dice", source: "Mahabharata, Vana Parva" },
  { id: "konark-sun", topic: "The Konark Sun Temple: a stone chariot with 24 wheels that work as sundials", source: "History of Odisha, 13th century, King Narasimhadeva I" },
  { id: "nalanda-fire", topic: "Nalanda University's library, which is said to have burned for months", source: "History: Nalanda Mahavihara, 5th-12th century" },
  { id: "chola-navy", topic: "The Chola navy that sailed to Southeast Asia a thousand years ago", source: "History: Rajendra Chola I, 1025 CE" },
  { id: "kailasa-ellora", topic: "The Kailasa temple at Ellora, carved top-down from one single rock", source: "History: Rashtrakuta dynasty, 8th century" },
  { id: "iron-pillar", topic: "The 1,600-year-old Iron Pillar of Delhi that has barely rusted", source: "History: Gupta period, about 400 CE" },
  { id: "aryabhata-zero", topic: "Aryabhata, who said the Earth spins on its axis 1,500 years ago", source: "History: Aryabhatiya, 499 CE" },
  { id: "sushruta", topic: "Sushruta, who described plastic surgery of the nose 2,500 years ago", source: "History: Sushruta Samhita" },
  { id: "takshashila", topic: "Takshashila, one of the oldest centres of learning in the world, where Chanakya taught", source: "History: Taxila, from about 6th century BCE" },
  { id: "chanakya-chandragupta", topic: "How Chanakya found a boy named Chandragupta and made him emperor", source: "History and tradition: Maurya empire, 4th century BCE" },
  { id: "ashoka-kalinga", topic: "Emperor Ashoka after the Kalinga war: from conqueror to dhamma", source: "History: Ashoka's Rock Edict XIII" },
  { id: "hampi", topic: "Hampi, capital of the Vijayanagara empire, once one of the richest cities in the world", source: "History: Vijayanagara, 14th-16th century" },
  { id: "rani-durgavati", topic: "Rani Durgavati of Gondwana, who fought the Mughal army to her last breath", source: "History: 1564 CE" },
  { id: "lachit-borphukan", topic: "Lachit Borphukan and the battle of Saraighat on the Brahmaputra", source: "History: Ahom kingdom, 1671 CE" },
  { id: "dwarka-underwater", topic: "The underwater ruins off Dwarka and the legend of Krishna's city sinking into the sea", source: "Mahabharata, Mausala Parva; marine archaeology off Gujarat" },
  { id: "kumbh-amrit", topic: "Why the Kumbh Mela is held at four places: the drops of amrit", source: "Puranic tradition" },
  { id: "ashwatthama", topic: "Ashwatthama's curse to wander the earth, and why he is called a Chiranjeevi", source: "Mahabharata, Sauptika Parva" },
];

interface UsedFile {
  used: { id: string; at: string; videoId?: string }[];
}

/** Remembers which topics a channel already published, so a topic comes back only after every other one was told. */
export class TopicHistory {
  constructor(private file: string) {}

  private read(): UsedFile {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(j?.used) ? j : { used: [] };
    } catch {
      return { used: [] };
    }
  }

  used(): string[] {
    return this.read().used.map((u) => u.id);
  }

  record(id: string, videoId?: string): void {
    const j = this.read();
    j.used.push({ id, at: new Date().toISOString(), videoId });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(j, null, 1));
  }
}

/** The next topic: never one told before while untold ones remain, then the one told longest ago. `skip` excludes topics that just failed. */
export function pickTopic(used: string[], skip: string[] = [], topics: MythTopic[] = MYTH_TOPICS, rand = Math.random): MythTopic {
  const pool = topics.filter((t) => !skip.includes(t.id));
  const fresh = pool.filter((t) => !used.includes(t.id));
  if (fresh.length) return fresh[Math.floor(rand() * fresh.length)];
  // all told: the one whose last telling is oldest
  const lastAt = (id: string) => used.lastIndexOf(id);
  return [...pool].sort((a, b) => lastAt(a.id) - lastAt(b.id))[0] ?? topics[0];
}
