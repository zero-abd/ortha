/**
 * Client-side text-document attachments.
 *
 * A user can attach a TEXT-based document (.txt, .md, .csv, .json, source code,
 * .log, …). We read it in the browser and prepend its contents to the model
 * prompt so the agent can answer questions about it. Binary formats (PDF, docx,
 * images) are out of scope — {@link isTextFile} rejects them and the UI shows a
 * "text files only for now" notice.
 *
 * Pure, dependency-free helpers so they can be unit-tested in isolation.
 */

/** A read text attachment: the file name and its (already-read) contents. */
export interface Attachment {
  name: string;
  content: string;
}

/** Known text-based file extensions (lower-case, no leading dot). */
const TEXT_EXTENSIONS = new Set<string>([
  // plain + docs
  "txt",
  "text",
  "md",
  "markdown",
  "rst",
  "log",
  // data / config
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "svg",
  // code
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "sql",
  "graphql",
  "gql",
  "vue",
  "svelte",
]);

/** Lower-case file extension without the dot, or "" when there's none. */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

/**
 * True when the file looks like a text document we can read client-side.
 * Accepts any `text/*` mime, a few known text-ish application mimes (JSON,
 * XML, …), or a known text extension. Binary formats (PDF/docx/images) fail.
 */
export function isTextFile(name: string, type: string): boolean {
  const mime = (type || "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/x-ndjson" ||
    mime === "image/svg+xml"
  ) {
    return true;
  }
  return TEXT_EXTENSIONS.has(extOf(name));
}

/**
 * Render one attachment as the fenced block prepended to the model prompt.
 * Caps the body at `maxChars` and appends a "(truncated)" note when it had to
 * cut content, so the model knows it's seeing a prefix.
 */
export function formatAttachment(name: string, content: string, maxChars = 20000): string {
  const capped = content.length > maxChars;
  const body = capped ? content.slice(0, maxChars) : content;
  const note = capped ? "\n… (truncated)" : "";
  return "Attached file: " + name + "\n```\n" + body + note + "\n```\n";
}

/**
 * Compose the text actually sent to the model: each attachment's fenced block
 * first, then the user's question. Returns the user text unchanged when there
 * are no attachments.
 */
export function buildPromptWithAttachments(userText: string, files: Attachment[]): string {
  if (files.length === 0) return userText;
  const blocks = files.map((f) => formatAttachment(f.name, f.content)).join("\n");
  return blocks + "\n" + userText;
}
