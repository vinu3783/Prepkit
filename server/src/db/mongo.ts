import { MongoClient, type Db } from "mongodb";

export interface Database {
  db: Db;
  close(): Promise<void>;
}

/**
 * Connect to MONGODB_URI. Without one (local development only) an in-memory
 * MongoDB is started so the app runs with zero setup; data is lost on restart.
 */
export async function connectDatabase(uri = process.env.MONGODB_URI): Promise<Database> {
  let stopMemoryServer: (() => Promise<unknown>) | undefined;
  if (!uri) {
    if (process.env.NODE_ENV === "production") throw new Error("MONGODB_URI is required in production");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const memory = await MongoMemoryServer.create();
    uri = memory.getUri();
    stopMemoryServer = () => memory.stop();
    console.warn("MONGODB_URI not set: using an in-memory MongoDB (data is not persisted)");
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "prepkit");
  await ensureIndexes(db);
  return {
    db,
    async close() {
      await client.close();
      await stopMemoryServer?.();
    },
  };
}

async function ensureIndexes(db: Db): Promise<void> {
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("kits").createIndex({ userId: 1, createdAt: -1 });
  // One live kit per (user, posting): a double submit cannot start two generations.
  await db.collection("kits").createIndex(
    { userId: 1, activeKey: 1 },
    { unique: true, partialFilterExpression: { activeKey: { $exists: true } } },
  );
}
