import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import zlib from "node:zlib";

/** Node >= 22.15 / 23.8 ships zstd; older versions can't read compressed transcripts. */
export const zstdSupported = typeof (zlib as any).createZstdDecompress === "function";

/**
 * Stream a JSONL file (optionally zstd-compressed, `.zst`), yielding parsed objects.
 * Malformed lines are skipped: transcripts are often being appended to while we read them.
 */
export async function* readJsonl(file: string, maxLines = Infinity): AsyncGenerator<any> {
  const raw = createReadStream(file);
  const input = file.endsWith(".zst") ? raw.pipe((zlib as any).createZstdDecompress() as NodeJS.ReadWriteStream) : raw;
  // Errors on the raw stream (ENOENT...) don't propagate through pipe(): forward them.
  if (input !== raw) raw.on("error", (e) => (input as any).destroy(e));
  input.setEncoding("utf8");
  const rl = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (n++ >= maxLines) break;
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* partial or corrupt line */
      }
    }
  } finally {
    rl.close();
    raw.destroy();
    if (input !== raw) (input as any).destroy();
  }
}
