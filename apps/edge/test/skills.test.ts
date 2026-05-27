import { describe, expect, it } from "vitest";
import { handleApi, validateSkillInput, type Skill } from "../src/api.js";
import type { Env } from "../src/env.js";
import type { Session, UserId, WorkspaceId } from "@ortha/contracts";

/** In-memory KV with a peek into the backing map so tests can assert what was stored. */
function mockKv(): KVNamespace & { _map: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    _map: m,
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
  } as unknown as KVNamespace & { _map: Map<string, string> };
}

const SESSION: Session = { userId: "u1" as UserId, workspaceId: "w1" as WorkspaceId, token: "tok", expiresAt: Date.now() + 100_000 };

function req(method: string, path: string, body?: unknown): { request: Request; url: URL } {
  const url = new URL(`https://edge.test${path}`);
  const request = new Request(url.toString(), {
    method,
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, url };
}

async function call(env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const { request, url } = req(method, path, body);
  const res = await handleApi(request, env, url, SESSION);
  if (!res) return { status: 0, json: null };
  return { status: res.status, json: await res.json() };
}

describe("validateSkillInput", () => {
  it("accepts a well-formed skill and trims fields", () => {
    expect(validateSkillInput({ name: "  Enrich  ", template: "  Find {x}  " })).toEqual({ name: "Enrich", template: "Find {x}" });
  });
  it("rejects an empty name", () => {
    expect(validateSkillInput({ name: "  ", template: "ok" })).toEqual({ error: "name is required" });
  });
  it("rejects an empty template", () => {
    expect(validateSkillInput({ name: "ok", template: "" })).toEqual({ error: "template is required" });
  });
  it("rejects a template over 2000 chars", () => {
    const v = validateSkillInput({ name: "ok", template: "x".repeat(2001) });
    expect("error" in v && v.error).toMatch(/too long/);
  });
});

describe("skills KV handler", () => {
  it("returns an empty list for a fresh workspace", async () => {
    const env = { KV: mockKv() } as unknown as Env;
    const r = await call(env, "GET", "/api/workspace/skills");
    expect(r.status).toBe(200);
    expect(r.json.skills).toEqual([]);
  });

  it("adds a skill via POST and persists it under skills:<workspaceId>", async () => {
    const kv = mockKv();
    const env = { KV: kv } as unknown as Env;
    const r = await call(env, "POST", "/api/workspace/skills", { name: "Lead enrich", template: "Enrich {email}." });
    expect(r.status).toBe(200);
    expect(r.json.skills).toHaveLength(1);
    const skill = r.json.skills[0] as Skill;
    expect(skill.name).toBe("Lead enrich");
    expect(skill.template).toBe("Enrich {email}.");
    expect(skill.id).toBeTruthy();
    expect(typeof skill.createdAt).toBe("number");
    // Stored under the workspace-scoped key.
    const stored = JSON.parse(kv._map.get("skills:w1")!);
    expect(stored).toHaveLength(1);
  });

  it("rejects an invalid POST with 400", async () => {
    const env = { KV: mockKv() } as unknown as Env;
    const r = await call(env, "POST", "/api/workspace/skills", { name: "", template: "x" });
    expect(r.status).toBe(400);
  });

  it("replaces the whole list via PUT, minting ids when missing", async () => {
    const env = { KV: mockKv() } as unknown as Env;
    const r = await call(env, "PUT", "/api/workspace/skills", {
      skills: [
        { name: "A", template: "do {a}" },
        { id: "keep-me", name: "B", template: "do {b}", createdAt: 5 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.skills).toHaveLength(2);
    expect(r.json.skills[0].id).toBeTruthy();
    expect(r.json.skills[1].id).toBe("keep-me");
    expect(r.json.skills[1].createdAt).toBe(5);
  });

  it("rejects a PUT with a bad skill in the list (400) and stores nothing", async () => {
    const kv = mockKv();
    const env = { KV: kv } as unknown as Env;
    const r = await call(env, "PUT", "/api/workspace/skills", { skills: [{ name: "ok", template: "" }] });
    expect(r.status).toBe(400);
    expect(kv._map.get("skills:w1")).toBeUndefined();
  });

  it("rejects a PUT without a skills array (400)", async () => {
    const env = { KV: mockKv() } as unknown as Env;
    const r = await call(env, "PUT", "/api/workspace/skills", { skills: "nope" });
    expect(r.status).toBe(400);
  });

  it("deletes a skill by id and leaves the rest", async () => {
    const env = { KV: mockKv() } as unknown as Env;
    await call(env, "POST", "/api/workspace/skills", { name: "A", template: "ta" });
    const afterAdd = await call(env, "POST", "/api/workspace/skills", { name: "B", template: "tb" });
    const idToDelete = (afterAdd.json.skills[0] as Skill).id;
    const r = await call(env, "DELETE", `/api/workspace/skills/${idToDelete}`);
    expect(r.status).toBe(200);
    expect(r.json.skills).toHaveLength(1);
    expect(r.json.skills.find((s: Skill) => s.id === idToDelete)).toBeUndefined();
  });

  it("405s an unsupported method", async () => {
    const env = { KV: mockKv() } as unknown as Env;
    const r = await call(env, "PATCH", "/api/workspace/skills");
    expect(r.status).toBe(405);
  });

  it("tolerates a corrupt stored blob by treating it as empty", async () => {
    const kv = mockKv();
    kv._map.set("skills:w1", "{not json");
    const env = { KV: kv } as unknown as Env;
    const r = await call(env, "GET", "/api/workspace/skills");
    expect(r.json.skills).toEqual([]);
  });
});
