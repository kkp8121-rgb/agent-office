// Privacy filter: turns a tool call into a short label. Never exposes full commands,
// search patterns, paths beyond the basename, or file contents.

const MAX_LEN = 80;

export function clip(s, n) {
  const chars = Array.from(String(s));
  return chars.length <= n ? chars.join('') : chars.slice(0, n - 1).join('') + '…';
}

function baseName(p) {
  return String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function firstWord(command) {
  const m = String(command ?? '').trim().match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const token = m ? (m[1] ?? m[2] ?? m[3]) : '';
  return baseName(token).replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function fileLabel(verb) {
  return (input) => {
    const name = baseName(input?.file_path ?? input?.notebook_path);
    return name ? `${name} ${verb}` : verb;
  };
}

const edit = fileLabel('고치는 중');

const DESCRIBERS = {
  Bash: (i) => {
    const d = String(i?.description ?? '').trim();
    if (d) return d;
    const w = firstWord(i?.command);
    return w ? `${w} 실행` : '명령 실행';
  },
  Read: fileLabel('읽는 중'),
  Edit: edit,
  MultiEdit: edit,
  NotebookEdit: edit,
  Write: fileLabel('쓰는 중'),
  Grep: () => '검색 중',
  Glob: () => '검색 중',
  Agent: (i) => (i?.description ? `위임 · ${i.description}` : '위임'),
  Task: () => '할 일 정리',
  TodoWrite: () => '할 일 정리',
  Skill: (i) => (i?.skill ? `스킬 · ${i.skill}` : '스킬 사용'),
  Workflow: () => '워크플로 시작',
  WebSearch: () => '웹 조사 중',
  WebFetch: () => '웹 조사 중',
};

export function describeTool(name, input) {
  let text;
  if (Object.hasOwn(DESCRIBERS, name)) text = DESCRIBERS[name](input);
  else if (name.startsWith('mcp__')) text = `${name.split('__')[1] || 'mcp'} 도구 사용`;
  else text = `${name} 사용 중`;
  return clip(text, MAX_LEN);
}
