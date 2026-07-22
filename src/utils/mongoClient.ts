import { MongoClient, Db } from "mongodb";
import { pipelineLogger } from "./logger";

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "shorts_automation";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(DB_NAME);
  pipelineLogger.info(`Connected to MongoDB (${DB_NAME})`, "MongoDB");
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
