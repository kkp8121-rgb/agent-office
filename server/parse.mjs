// Turns one transcript JSONL line into privacy-safe events. Transcript lines are untrusted:
// this never throws and never copies prompts, answers, thinking or tool results.
import { randomBytes } from 'node:crypto';
import { describeTool, clip, cleanLine, cleanTodos, TODO_TEXT_MAX, MAX_LEN } from './sanitize.mjs';
import { fileKey } from './filekey.mjs';
import config from '../config.json' with { type: 'json' };

const NAME_MAX = config.parse.nameMaxChars; // title, run id, workflow name
const PATH_MAX = config.parse.pathMaxChars; // scriptPath is only read from, never shown: a longer one is dropped, not clipped

const TITLE_RANK_CUSTOM = 2; // ai-title and the folder fallback rank 1 (the default)
const SEND_TO_MAX = 16; // SendMessage recipient, same length as a bubble line
const EPOCH_MS_MIN = 1e12; // a reset time below this is in seconds

const { conflict: CONFLICT, model: MODEL } = config;
const EDIT_TOOLS = new Set(CONFLICT.editTools);
const IGNORED_MODELS = new Set(MODEL.ignore.map((m) => m.toLowerCase()));

// Salt of the same-file keys: made here when the module is loaded, never stored. A restart changes every key, so a key
// kept anywhere cannot be matched back to a path. Tests set their own through setFileKeySalt.
let fileKeySalt = randomBytes(CONFLICT.saltBytes);
export function setFileKeySalt(buf) {
  fileKeySalt = buf;
}

const isObj = (v) => typeof v === 'object' && v !== null;
const str = (v, n) => (typeof v === 'string' ? clip(v, n) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0); // anything else counts as 0
const timeOf = (o) => (typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || 0 : 0);

/** Model family from the model id: the first `model.claude` entry whose text the lower-cased id contains, else 'other'. */
function foldModel(raw) {
  const id = typeof raw === 'string' ? raw.toLowerCase() : '';
  for (const [needle, family] of MODEL.claude) if (id.includes(needle)) return family;
  return 'other';
}

const modelIgnored = (message) => typeof message.model === 'string' && IGNORED_MODELS.has(message.model.toLowerCase());

/**
 * Token numbers of one assistant line: {ts, msgId, tokens, cacheRead}, or null when the line carries none (no usage, no message id,
 * or a model listed in `model.ignore`). `tokens` is new input + cache writes + output; cache reads are counted apart.
 * The same `msgId` repeats on every line a message is written on: the caller counts it once.
 */
export function claudeUsage(o) {
  const m = isObj(o) && o.type === 'assistant' && isObj(o.message) ? o.message : null;
  if (!m || !isObj(m.usage) || modelIgnored(m)) return null;
  const msgId = str(m.id, config.parse.nameMaxChars);
  if (!msgId) return null;
  const u = m.usage;
  return { ts: timeOf(o), msgId, tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens) };
}

function toolEvent(block, ts) {
  const input = isObj(block.input) ? block.input : {};
  const name = String(block.name ?? '');
  const ev = {
    kind: 'tool',
    ts,
    toolUseId: String(block.id ?? ''),
    name,
    text: describeTool(name, input),
  };
  if (CONFLICT.enabled && EDIT_TOOLS.has(name)) {
    const key = fileKey(name === 'NotebookEdit' ? input.notebook_path : input.file_path, fileKeySalt, { maxChars: CONFLICT.maxPathChars, hashChars: CONFLICT.hashChars });
    if (key) ev.fileKey = key; // server-side only: the path itself is not kept
  }
  if (name === 'SendMessage') {
    const to = cleanLine(input.to, SEND_TO_MAX);
    if (to) ev.sendTo = to; // server-side only
  }
  if (name === 'Agent') {
    if (typeof input.subagent_type === 'string') ev.agentType = clip(input.subagent_type, MAX_LEN);
    if (typeof input.description === 'string') ev.description = clip(input.description, MAX_LEN);
  }
  // Whiteboard to-dos: TodoWrite replaces the list, TaskCreate adds an item, TaskUpdate (ids count up from 1) sets a status.
  if (name === 'TodoWrite') {
    const todos = cleanTodos(input.todos, 'content');
    if (todos) ev.todos = todos;
  } else if (name === 'TaskCreate') {
    const text = cleanLine(input.subject, TODO_TEXT_MAX);
    if (text) ev.taskCreate = text;
  } else if (name === 'TaskUpdate' && typeof input.status === 'string') {
    ev.taskUpdate = { id: Number(input.taskId), status: input.status };
  }
  return ev;
}

/** A rate-limit error line -> limit event; null for any other error line (server_error and the like). */
function limitEvent(o, ts) {
  if (o.isApiErrorMessage !== true) return null;
  const quota = isObj(o.quotaLimits) ? o.quotaLimits : {};
  if (o.error !== 'rate_limit' && quota.status !== 'rejected') return null;
  const info = isObj(o.apiErrorParams) && isObj(o.apiErrorParams.rate_limit_info) ? o.apiErrorParams.rate_limit_info : {};
  const resetsAt = typeof quota.resetsAt === 'number' ? quota.resetsAt : info.resetsAt;
  const until = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 ? (resetsAt < EPOCH_MS_MIN ? resetsAt * 1000 : resetsAt) : null;
  const type = quota.rateLimitType ?? info.rateLimitType;
  return { kind: 'limit', ts, until, limitKind: type === 'five_hour' || type === 'seven_day' ? type : 'other' };
}

function parseObject(o) {
  const ts = timeOf(o);
  const content = isObj(o.message) && Array.isArray(o.message.content) ? o.message.content : [];
  const evs = [];

  if (o.type === 'ai-title') {
    const title = cleanLine(o.aiTitle, NAME_MAX);
    return title ? [{ kind: 'title', ts: 0, title }] : [];
  }
  // Titles the Claude desktop app sets itself: it outranks the generated one.
  if (o.type === 'custom-title') {
    const title = cleanLine(o.customTitle, NAME_MAX);
    return title ? [{ kind: 'title', ts: 0, title, rank: TITLE_RANK_CUSTOM }] : [];
  }

  if (o.type === 'assistant') {
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_use') evs.push(toolEvent(b, ts));
      else if (b.type === 'thinking' || b.type === 'text') evs.push({ kind: 'think', ts });
    }
    if (o.message?.stop_reason === 'end_turn') evs.push({ kind: 'end', ts });
    const limit = limitEvent(o, ts);
    if (limit) evs.push(limit);
    const usage = claudeUsage(o);
    if (usage) {
      evs.push({ kind: 'usage', ts, msgId: usage.msgId, tokens: usage.tokens, cacheRead: usage.cacheRead });
      const u = o.message.usage;
      // the size of the prompt of this call = how long the conversation is now
      evs.push({ kind: 'ctx', ts, ctxTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), window: null, model: foldModel(o.message.model) });
    }
    return evs;
  }

  // Only the trigger and the duration of a context compaction are read; the summary text is not.
  if (o.type === 'system' && o.subtype === 'compact_boundary') {
    const meta = isObj(o.compactMetadata) ? o.compactMetadata : {};
    const trigger = meta.trigger === 'auto' || meta.trigger === 'manual' ? meta.trigger : 'other';
    const durationMs = typeof meta.durationMs === 'number' && Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : null;
    return [{ kind: 'compact', ts, trigger, durationMs }];
  }

  if (o.type === 'user') {
    for (const b of content) {
      if (isObj(b) && b.type === 'tool_result') {
        const done = { kind: 'toolDone', ts, toolUseId: String(b.tool_use_id ?? '') };
        if (b.is_error === true) done.error = true; // only the flag, never the result text
        evs.push(done);
      }
    }
    const r = o.toolUseResult;
    if (isObj(r) && r.taskType === 'local_workflow') {
      evs.push({
        kind: 'workflowLaunch',
        ts,
        runId: str(r.runId, NAME_MAX),
        workflowName: str(r.workflowName, NAME_MAX),
        scriptPath: typeof r.scriptPath === 'string' && r.scriptPath.length <= PATH_MAX ? r.scriptPath : '',
      });
    }
    return evs;
  }

  return [];
}

export function parseLine(text) {
  try {
    const o = JSON.parse(text);
    if (!isObj(o)) return [];
    const evs = parseObject(o);
    // Only the entrypoint name is read (never the line's other fields): lines of the desktop app say where the session was opened.
    return o.entrypoint === 'claude-desktop' ? [{ kind: 'origin', ts: 0, origin: 'claudeApp' }, ...evs] : evs;
  } catch {
    return [];
  }
}
