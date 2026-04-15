import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as fsSync from "node:fs";

export interface ReadFileResult {
  path: string;
  content: string;
  total_lines: number;
  lines_read: number;
  offset: number;
}

export interface WriteFileResult {
  path: string;
  bytes_written: number;
  message: string;
}

export interface EditFileResult {
  path: string;
  replacements_made: 1;
}

export interface ListDirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  /** Relative path from the requested directory root. */
  relative_path: string;
}

export interface ListDirectoryResult {
  path: string;
  entries: ListDirectoryEntry[];
  total_entries: number;
  /** Actual depth scanned (capped at max_depth). */
  depth: number;
}

/**
 * Reads a file and returns its content with line-level metadata.
 * Throws descriptive errors for all failure modes.
 */
export async function readFileContents(
  filePath: string,
  offset?: number,
  limit?: number
): Promise<ReadFileResult> {
  const resolved = nodePath.resolve(filePath);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `read_file: file not found at path '${filePath}'. Check the path and try again.`
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `read_file: permission denied reading '${filePath}'. The file exists but cannot be read.`
      );
    }
    throw new Error(`read_file: could not access '${filePath}': ${(err as Error).message}`);
  }

  if (stat.isDirectory()) {
    throw new Error(
      `read_file: '${filePath}' is a directory, not a file. Provide a full file path including filename.`
    );
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `read_file: permission denied reading '${filePath}'. The file exists but cannot be read.`
      );
    }
    throw new Error(`read_file: could not read '${filePath}': ${(err as Error).message}`);
  }

  const allLines = raw.split("\n");
  const totalLines = allLines.length;

  const effectiveOffset = offset !== undefined ? offset : 1;

  if (offset !== undefined) {
    if (offset < 1 || offset > totalLines) {
      throw new Error(
        `read_file: offset ${offset} is beyond the file's ${totalLines} lines. Use offset between 1 and ${totalLines}.`
      );
    }
  }

  const startIndex = effectiveOffset - 1;
  const slice = limit !== undefined ? allLines.slice(startIndex, startIndex + limit) : allLines.slice(startIndex);

  return {
    path: filePath,
    content: slice.join("\n"),
    total_lines: totalLines,
    lines_read: slice.length,
    offset: effectiveOffset,
  };
}

/**
 * Creates a new file with the given content.
 * Throws if the file already exists (uses exclusive open flag) or if the
 * parent directory does not exist.
 */
export async function writeFileContents(
  filePath: string,
  content: string
): Promise<WriteFileResult> {
  const resolved = nodePath.resolve(filePath);
  const parentDir = nodePath.dirname(resolved);

  let parentStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    parentStat = await fs.stat(parentDir);
  } catch {
    throw new Error(
      `write_file: parent directory '${nodePath.dirname(filePath)}' does not exist. Create it first (e.g. via bash mkdir).`
    );
  }

  if (!parentStat.isDirectory()) {
    throw new Error(
      `write_file: parent path '${nodePath.dirname(filePath)}' is not a directory.`
    );
  }

  let fileHandle: fs.FileHandle;
  try {
    // 'wx' flag: fail if file already exists (exclusive create)
    fileHandle = await fs.open(resolved, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(
        `write_file: file already exists at '${filePath}'. Use edit_file to modify an existing file.`
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `write_file: permission denied creating '${filePath}'. The directory is not writable.`
      );
    }
    throw new Error(`write_file: could not create '${filePath}': ${(err as Error).message}`);
  }

  try {
    await fileHandle.writeFile(content, "utf8");
  } finally {
    await fileHandle.close();
  }

  const bytesWritten = Buffer.byteLength(content, "utf8");

  return {
    path: filePath,
    bytes_written: bytesWritten,
    message: "File created successfully",
  };
}

/**
 * Replaces exactly one occurrence of old_string with new_string in an
 * existing file. Aborts with no changes if old_string appears zero or
 * more than once.
 */
export async function editFileContents(
  filePath: string,
  oldString: string,
  newString: string
): Promise<EditFileResult> {
  const resolved = nodePath.resolve(filePath);

  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `edit_file: file not found at '${filePath}'. Use read_file to verify the path before editing.`
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `edit_file: permission denied reading '${filePath}'. The file exists but is not readable.`
      );
    }
    throw new Error(`edit_file: could not read '${filePath}': ${(err as Error).message}`);
  }

  const occurrences = raw.split(oldString).length - 1;

  if (occurrences === 0) {
    throw new Error(
      `edit_file: old_string not found in '${filePath}'. Use read_file to get the exact current content and copy the substring precisely.`
    );
  }

  if (occurrences > 1) {
    throw new Error(
      `edit_file: old_string matches ${occurrences} occurrences in '${filePath}'. Add more surrounding context to make the match unique (must match exactly 1 time).`
    );
  }

  const updated = raw.replace(oldString, newString);

  try {
    await fs.writeFile(resolved, updated, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `edit_file: permission denied writing to '${filePath}'. The file exists but is not writable.`
      );
    }
    throw new Error(`edit_file: could not write '${filePath}': ${(err as Error).message}`);
  }

  return {
    path: filePath,
    replacements_made: 1,
  };
}

const MAX_DEPTH_LIMIT = 3;
const MAX_ENTRIES = 200;

/**
 * Lists the contents of a directory up to a given depth (capped at
 * MAX_DEPTH_LIMIT). Returns a flat array of entries with their relative paths
 * so the agent can understand workspace structure without using bash.
 */
export async function listDirectoryContents(
  dirPath: string,
  depth = 1
): Promise<ListDirectoryResult> {
  const resolved = nodePath.resolve(dirPath);
  const effectiveDepth = Math.min(Math.max(depth, 1), MAX_DEPTH_LIMIT);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `list_directory: path not found '${dirPath}'. Check the path and try again.`
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `list_directory: permission denied accessing '${dirPath}'.`
      );
    }
    throw new Error(`list_directory: could not access '${dirPath}': ${(err as Error).message}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `list_directory: '${dirPath}' is a file, not a directory. Use read_file to read its contents.`
    );
  }

  const entries: ListDirectoryEntry[] = [];

  function walk(absDir: string, currentDepth: number): void {
    if (currentDepth > effectiveDepth || entries.length >= MAX_ENTRIES) return;
    let names: string[];
    try {
      names = fsSync.readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= MAX_ENTRIES) break;
      const absEntry = nodePath.join(absDir, name);
      const rel = nodePath.relative(resolved, absEntry);
      let entryType: ListDirectoryEntry["type"] = "other";
      try {
        const s = fsSync.lstatSync(absEntry);
        if (s.isSymbolicLink()) entryType = "symlink";
        else if (s.isDirectory()) entryType = "directory";
        else if (s.isFile()) entryType = "file";
      } catch {
        entryType = "other";
      }
      entries.push({ name, type: entryType, relative_path: rel });
      if (entryType === "directory" && currentDepth < effectiveDepth) {
        walk(absEntry, currentDepth + 1);
      }
    }
  }

  walk(resolved, 1);

  return {
    path: dirPath,
    entries,
    total_entries: entries.length,
    depth: effectiveDepth,
  };
}
