import { createHash } from "node:crypto";
import { ObjectId, type Collection, type Db } from "mongodb";
import type { CardProgress } from "../domain/practice.js";
import type { Kit, QuestionCategory } from "../domain/schema.js";
import type { ProgressEvent, ResearchBundle } from "../pipeline/generateKit.js";

export type KitStatus = "queued" | "running" | "ready" | "failed";

export interface Story {
  id: string;
  title: string;
  situation: string;
  action: string;
  result: string;
  requirement_ids: string[];
}

export interface RegenerationState {
  section: "brief" | `category:${QuestionCategory}`;
  startedAt: string;
  /** Question ids that were replaceable when it started (category regenerations). */
  replaceable?: string[];
}

export interface KitDocument {
  _id: ObjectId;
  userId: ObjectId;
  status: KitStatus;
  input: { jd: string; companyUrl: string; days: number };
  /** Present while the kit is live (not failed): enforces one generation per posting. */
  activeKey?: string;
  progress: ProgressEvent[];
  kit: Kit | null;
  research: ResearchBundle | null;
  error: { code: string; message: string } | null;
  /** Optimistic concurrency: bumped on every write to `kit`. */
  version: number;
  /** Highest question number ever issued, so deleted ids are never reused. */
  questionIdFloor: number;
  regenerating: RegenerationState[];
  regenerationErrors: { section: string; message: string; at: string }[];
  practice: Record<string, CardProgress>;
  stories: Story[];
  previousBrief: Kit["company_brief"] | null;
  interviewAt: string;
  createdAt: string;
  updatedAt: string;
}

export class ConflictError extends Error {}

export function postingKey(userId: string, jd: string, companyUrl: string, days: number): string {
  const normalized = [userId, jd.replace(/\s+/g, " ").trim().toLowerCase(), companyUrl.trim().toLowerCase().replace(/\/+$/, ""), days].join("\u0000");
  return createHash("sha256").update(normalized).digest("hex");
}

export class KitRepository {
  private readonly kits: Collection<KitDocument>;

  constructor(db: Db) {
    this.kits = db.collection<KitDocument>("kits");
  }

  /** Create a queued kit, or return the existing live kit for the same posting. */
  async createOrFind(userId: string, input: KitDocument["input"]): Promise<{ doc: KitDocument; duplicate: boolean }> {
    const activeKey = postingKey(userId, input.jd, input.companyUrl, input.days);
    const uid = new ObjectId(userId);
    const existing = await this.kits.findOne({ userId: uid, activeKey });
    if (existing) return { doc: existing, duplicate: true };

    const now = new Date();
    const doc: KitDocument = {
      _id: new ObjectId(),
      userId: uid,
      status: "queued",
      input,
      activeKey,
      progress: [],
      kit: null,
      research: null,
      error: null,
      version: 0,
      questionIdFloor: 0,
      regenerating: [],
      regenerationErrors: [],
      practice: {},
      stories: [],
      previousBrief: null,
      interviewAt: new Date(now.getTime() + input.days * 86_400_000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      await this.kits.insertOne(doc);
      return { doc, duplicate: false };
    } catch (err) {
      // Lost a race with an identical submit: return the winner.
      if ((err as { code?: number }).code === 11000) {
        const winner = await this.kits.findOne({ userId: uid, activeKey });
        if (winner) return { doc: winner, duplicate: true };
      }
      throw err;
    }
  }

  findForUser(id: string, userId: string): Promise<KitDocument | null> {
    if (!ObjectId.isValid(id)) return Promise.resolve(null);
    return this.kits.findOne({ _id: new ObjectId(id), userId: new ObjectId(userId) });
  }

  findById(id: ObjectId): Promise<KitDocument | null> {
    return this.kits.findOne({ _id: id });
  }

  listForUser(userId: string) {
    return this.kits
      .find({ userId: new ObjectId(userId) }, { projection: { research: 0, "kit.questions": 0, "kit.flashcards": 0, practice: 0 } })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false;
    const res = await this.kits.deleteOne({ _id: new ObjectId(id), userId: new ObjectId(userId) });
    return res.deletedCount === 1;
  }

  async set(id: ObjectId, fields: Partial<KitDocument>): Promise<void> {
    await this.kits.updateOne({ _id: id }, { $set: { ...fields, updatedAt: new Date().toISOString() } });
  }

  async pushProgress(id: ObjectId, event: ProgressEvent): Promise<void> {
    await this.kits.updateOne({ _id: id }, { $push: { progress: { $each: [event], $slice: -200 } }, $set: { updatedAt: event.at } });
  }

  /**
   * Read-modify-write with optimistic concurrency. `mutate` receives the latest
   * document and returns the fields to change; if another writer got in first
   * the whole thing is retried on the newer document.
   */
  async update(id: ObjectId, mutate: (doc: KitDocument) => Partial<KitDocument> | null, attempts = 5): Promise<KitDocument> {
    for (let i = 0; i < attempts; i++) {
      const doc = await this.kits.findOne({ _id: id });
      if (!doc) throw new Error("Kit not found");
      const changes = mutate(doc);
      if (!changes) return doc;
      const next = { ...changes, version: doc.version + 1, updatedAt: new Date().toISOString() };
      const res = await this.kits.findOneAndUpdate({ _id: id, version: doc.version }, { $set: next }, { returnDocument: "after" });
      if (res) return res;
    }
    throw new ConflictError("The kit is being changed elsewhere; please retry.");
  }

  /** A failed kit releases its posting key so the same posting can be submitted again. */
  async markFailed(id: ObjectId, error: { code: string; message: string }): Promise<void> {
    await this.kits.updateOne({ _id: id }, { $set: { status: "failed", error, updatedAt: new Date().toISOString() }, $unset: { activeKey: "" } });
  }

  /** Retrying a failed kit re-claims its posting key (fails if an identical live kit now exists). */
  async requeue(doc: KitDocument): Promise<boolean> {
    const activeKey = postingKey(doc.userId.toHexString(), doc.input.jd, doc.input.companyUrl, doc.input.days);
    try {
      const res = await this.kits.updateOne(
        { _id: doc._id, status: "failed" },
        { $set: { status: "queued", activeKey, error: null, progress: [], updatedAt: new Date().toISOString() } },
      );
      return res.modifiedCount === 1;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  /** On startup: generations that were running when the process died cannot resume. */
  async failInterrupted(): Promise<number> {
    const res = await this.kits.updateMany(
      { status: { $in: ["queued", "running"] } },
      {
        $set: { status: "failed", error: { code: "INTERRUPTED", message: "The server restarted during generation. Retry to run it again." }, updatedAt: new Date().toISOString() },
        $unset: { activeKey: "" },
      },
    );
    await this.kits.updateMany({ "regenerating.0": { $exists: true } }, { $set: { regenerating: [] } });
    return res.modifiedCount;
  }
}
