// Turns one transcript JSONL line into privacy-safe events. Transcript lines are untrusted:
// this never throws and never copies prompts, answers, thinking or tool results.
import { describeTool, clip, MAX_LEN } from './sanitize.mjs';
import config from '../config.json' with { type: 'json' };

const NAME_MAX = config.parse.nameMaxChars; // title, run id, workflow name
const PATH_MAX = config.parse.pathMaxChars; // scriptPath is only read from, never shown: a longer one is dropped, not clipped

const isObj = (v) => typeof v === 'object' && v !== null;
const str = (v, n) => (typeof v === 'string' ? clip(v, n) : '');

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
  if (name === 'Agent') {
    if (typeof input.subagent_type === 'string') ev.agentType = clip(input.subagent_type, MAX_LEN);
    if (typeof input.description === 'string') ev.description = clip(input.description, MAX_LEN);
  }
  return ev;
}

function parseObject(o) {
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || 0 : 0;
  const content = isObj(o.message) && Array.isArray(o.message.content) ? o.message.content : [];
  const evs = [];

  if (o.type === 'ai-title') {
    const title = str(o.aiTitle, NAME_MAX);
    return title ? [{ kind: 'title', ts: 0, title }] : [];
  }

  if (o.type === 'assistant') {
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_use') evs.push(toolEvent(b, ts));
      else if (b.type === 'thinking' || b.type === 'text') evs.push({ kind: 'think', ts });
    }
    if (o.message?.stop_reason === 'end_turn') evs.push({ kind: 'end', ts });
    return evs;
  }

  if (o.type === 'user') {
    for (const b of content) {
      if (isObj(b) && b.type === 'tool_result') {
        evs.push({ kind: 'toolDone', ts, toolUseId: String(b.tool_use_id ?? '') });
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
    return isObj(o) ? parseObject(o) : [];
  } catch {
    return [];
  }
}
