// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Ported to TypeScript from NVIDIA NeMo Switchyard crates/libsy/src/algorithms/util/tool_signals.rs at c8848511, modified.

import type { Conversation, NormalizedToolCall } from './normalize.ts';

export const DEFAULT_RECENT_WINDOW = 3;
export const SOFT = 0.3;
export const HARD = 0.7;
export const CRITICAL = 1.0;

const EDIT = new Set(['edit', 'multiedit', 'notebookedit', 'str_replace', 'str_replace_based_edit_tool', 'apply_patch', 'text_editor', 'patch']);
const EDITOR = new Set(['str_replace_based_edit_tool', 'text_editor']);
const WRITE = new Set(['write', 'create_file', 'new_file', 'write_file']);
const READ = new Set(['read', 'view', 'read_file', 'search_files', 'glob', 'grep', 'find', 'ls']);
const PLAN = new Set(['todowrite', 'todo_write', 'todo', 'update_plan', 'todo_list']);
const SHELL = new Set(['bash', 'shell_command', 'shell', 'local_shell_call', 'terminal', 'exec_command', 'exec', 'powershell']);
const BASH_READ_COMMANDS = new Set(['cat', 'rg', 'nl', 'jq', 'pwd', 'tree', 'sed', 'grep', 'ls', 'find', 'head', 'tail', 'wc', 'diff', 'which', 'ps', 'df', 'du', 'stat', 'file', 'less', 'more', 'readlink', 'realpath', 'basename', 'dirname', 'printenv']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'show-ref', 'rev-parse', 'ls-files', 'ls-remote', 'ls-tree', 'grep', 'blame', 'merge-base', 'check-ignore', 'tag']);

export interface ToolObservation {
  name: string;
  command?: string;
  resultText?: string;
  isError?: boolean;
  source?: string;
  /** Actual native assistant/model turn identity, absent when the surface cannot prove it. */
  turn?: string;
}

export interface ToolSignals {
  severity: number;
  repeatedFailure: boolean;
  noErrorStreak: number;
  editCount: number;
  writeCount: number;
  readCount: number;
  todowriteCount: number;
  recentEditCount: number;
  recentWriteCount: number;
  recentReadCount: number;
  recentTodowriteCount: number;
  newCount: number;
  recentNewCount: number;
  pureBashStreak: number;
  testsPassed: boolean;
  toolResultCount: number;
  assistantTurnCount: number;
  turnDepth: number;
  compacted: boolean;
}

type Semantic = 'write' | 'edit' | 'read' | 'plan' | 'new' | 'unknown';
const emptySignals = (turnDepth: number): ToolSignals => ({
  severity: 0, repeatedFailure: false, noErrorStreak: 0, editCount: 0, writeCount: 0,
  readCount: 0, todowriteCount: 0, recentEditCount: 0, recentWriteCount: 0,
  recentReadCount: 0, recentTodowriteCount: 0, newCount: 0, recentNewCount: 0,
  pureBashStreak: 0, testsPassed: false, toolResultCount: 0, assistantTurnCount: 0,
  turnDepth, compacted: false,
});

function argumentCommand(args: unknown): string | undefined {
  if (typeof args === 'string') {
    const raw = args;
    try { args = JSON.parse(raw) as unknown; } catch { return raw; }
  }
  if (!args || typeof args !== 'object') return undefined;
  const obj = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'input']) if (typeof obj[key] === 'string') return obj[key] as string;
  if (typeof obj.command === 'object' && obj.command && typeof (obj.command as Record<string, unknown>).text === 'string') return (obj.command as Record<string, string>).text;
  return undefined;
}

function splitShell(command: string): string[] {
  const parts: string[] = []; let start = 0; let quote = ''; let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote === c) quote = '';
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (!quote && ['\n', ';', '|', '&'].includes(c)) { const s = command.slice(start, i).trim(); if (s) parts.push(s); start = i + 1; }
  }
  const rest = command.slice(start).trim(); if (rest) parts.push(rest); return parts;
}

function shellWords(segment: string): string[] {
  const words = segment.split(/[\t\n\v\f\r ]+/u).filter(Boolean);
  let i = 0;
  if (words[i] === 'env') { i++; while (words[i]?.startsWith('-')) i++; }
  while (words[i]?.includes('=') && !words[i]?.startsWith('=')) i++;
  return words.slice(i);
}
function baseProgram(word: string): string { return word.split('/').pop() ?? word; }
function shellClassification(command: string): Semantic {
  const lower = command.toLowerCase();
  if (['cat >', 'cat >>', 'echo >', 'echo >>', 'tee ', 'printf >', 'printf >>', '> /', '>> /', "<< 'eof'", '<<eof', "<<'eof'", '<< eof'].some((p) => lower.includes(p))) return 'write';
  if (lower.includes('python') && ['write_text(', 'writelines(', '.write('].some((p) => lower.includes(p))) return 'write';
  if (splitShell(lower).some((s) => baseProgram(shellWords(s)[0] ?? '') === 'node') && ['writefilesync(', 'writefile(', 'appendfilesync(', 'appendfile('].some((p) => lower.includes(p))) return 'write';
  const segments = splitShell(lower);
  for (const segment of segments) {
    const words = shellWords(segment); const p = baseProgram(words[0] ?? '');
    if (['cp', 'mkdir', 'touch', 'install'].includes(p)) return 'write';
    const redirectsOutput = words.some((word) => word === '>' || word === '>>' || /^\d*>{1,2}(?!&)\S*$/u.test(word));
    if (redirectsOutput && (['echo', 'printf', 'git'].includes(p) || BASH_READ_COMMANDS.has(p))) return 'write';
  }
  if (['sed -i', 'sed --in-place', 'awk -i inplace', "awk 'inplace=1'", 'patch ', 'patch -p', 'perl -i', 'perl -p -i', 'perl -pi'].some((p) => lower.includes(p))) return 'edit';
  for (const segment of segments) {
    const words = shellWords(segment); const p = baseProgram(words[0] ?? ''); const has = (x: string) => words.includes(x);
    if (p === 'mv' || p === 'rm') return 'edit';
    if (p === 'perl' && words.slice(1).some((w) => w.startsWith('-') && w.slice(1).includes('i'))) return 'edit';
    if (p === 'git' && ['apply', 'am', 'restore'].includes(words[1] ?? '')) return 'edit';
    if (p === 'gofmt' && has('-w')) return 'edit';
    if (p === 'cargo' && words[1] === 'fmt' && !has('--check')) return 'edit';
    if (p === 'ruff' && ((words[1] === 'format' && !has('--check')) || (words[1] === 'check' && has('--fix')))) return 'edit';
    if (p === 'prettier' && has('--write')) return 'edit';
    if (p === 'black' && !has('--check')) return 'edit';
    if (words.some((word) => baseProgram(word) === 'prettier') && has('--write')) return 'edit';
    if (words.some((word) => baseProgram(word) === 'ruff') && ((has('format') && !has('--check')) || (has('check') && has('--fix')))) return 'edit';
  }
  if (segments.some((s) => /\b(?:cat \/|cat \.\/|cat \.\.\/|grep |ls |ls -|find |head |tail |wc |diff |which |ps |df |du |stat |file |less |more )/u.test(s))) return 'read';
  for (const segment of segments) {
    const words = shellWords(segment); const p = baseProgram(words[0] ?? '');
    if (BASH_READ_COMMANDS.has(p) || segment === 'env' || (p === 'command' && words[1] === '-v') || p === 'type') return 'read';
    if (p === 'git') {
      const sub = words[1];
      if (GIT_READ.has(sub ?? '') || (sub === 'branch' && (!words[2] || words[2]!.startsWith('-'))) || (sub === 'remote' && (!words[2] || words[2]!.startsWith('-') || words[2] === 'get-url')) || (sub === 'config' && ['--get', '--get-all', '--list', '-l'].includes(words[2] ?? ''))) return 'read';
    }
  }
  return 'unknown';
}

function semantic(name: string, command?: string, source?: string): Semantic {
  if (source?.toLowerCase() === 'filechange') return 'edit';
  const lower = name.toLowerCase();
  if (source === 'codex' && lower === 'filechange') return 'edit';
  if (WRITE.has(lower)) return 'write';
  if (EDITOR.has(lower) && command === 'view') return 'read';
  if (EDIT.has(lower)) return 'edit';
  if (READ.has(lower)) return 'read';
  if (PLAN.has(lower)) return 'plan';
  if (SHELL.has(lower) && command !== undefined) return shellClassification(command);
  return 'unknown';
}

interface Result { text: string; isError: boolean; }
function lower(text: string): string { return text.toLowerCase(); }
const patterns: Array<[string, number, string[]]> = [
  ['oom', CRITICAL, ['out of memory', 'memoryerror', 'cannot allocate memory']],
  ['connection_refused', HARD, ['connection refused', 'connectionrefusederror', 'econnrefused']],
  ['traceback', HARD, ['traceback (most recent call last)']],
  ['import_error', HARD, ['modulenotfounderror:', 'importerror:', 'no module named ']],
  ['cmd_not_found', HARD, ['command not found', 'not found\n', '/usr/bin/env: ']],
  ['assertion', HARD, ['assertionerror']], ['value_error', HARD, ['valueerror:']], ['syntax_error', HARD, ['syntaxerror:']],
  ['timeout', HARD, ['timed out', 'timeouterror', 'timeout expired', 'deadline exceeded']],
  ['no_such_file', HARD, ['filenotfounderror:', 'no such file or directory', 'file does not exist']],
  ['exit_nonzero', SOFT, ['returned non-zero']],
];
function failureSeverity(text: string, isError: boolean): { severity: number; names: string[] } {
  const l = lower(text); let severity = 0; const names: string[] = [];
  for (const [name, value, needles] of patterns) if (needles.some((needle) => l.includes(needle))) { severity = Math.max(severity, value); names.push(name); }
  const exitPhrases = ['exit code', 'exit status', 'exited with code', 'exited with status'];
  for (const phrase of exitPhrases) {
    let cursor = 0;
    while (cursor < l.length) {
      const at = l.indexOf(phrase, cursor);
      if (at < 0) break;
      const digits = l.slice(at + phrase.length).replace(/^[\s:='"`]*/u, '').match(/^\d+/u)?.[0];
      if (digits && Number(digits) !== 0) { severity = Math.max(severity, SOFT); break; }
      cursor = at + phrase.length;
    }
  }
  if (l.split('\n').some((line) => {
    const trimmed = line.trimStart();
    if (['compilation failed', 'error: compilation failed', 'error: could not compile'].includes(trimmed) || trimmed.startsWith('error: could not compile ')) return true;
    const match = trimmed.match(/^error\[e(\d+)\]:/u);
    return match !== null && match[1]!.length > 0;
  })) { severity = Math.max(severity, HARD); names.push('compiler'); }
  if (/(?:typeerror|referenceerror|rangeerror|runtimeerror|keyerror|attributeerror):/u.test(l) && /\n\s{2,}at\s/u.test(l)) { severity = Math.max(severity, HARD); names.push('runtime_exception'); }
  if (/panic: runtime error:/u.test(l) && /\ngoroutine |\[signal sig/u.test(l)) { severity = Math.max(severity, HARD); names.push('runtime_panic'); }
  if (/^(?:error: patch failed:|patch failed:|invalid context)|: patch does not apply/mu.test(l.split('\n').map(line => line.trimStart()).join('\n'))) { severity = Math.max(severity, HARD); names.push('patch_failure'); }
  return { severity: isError ? Math.max(severity, HARD) : severity, names };
}
export function fingerprint(text: string, isError: boolean): string | undefined {
  const detected = failureSeverity(text, isError); if (detected.severity < HARD && !isError) return undefined;
  const lines = lower(text).split('\n');
  const diagnostic = lines.find((line) => /error|exception|panic|failed|timed out|timeout|connection refused|cannot allocate memory|out of memory|not found/u.test(line.trim())) ?? lines.find((line) => line.trim()) ?? '';
  const normalized = [...diagnostic.split(/\s+/u).map((word) => word.startsWith('/') || word.includes('/src/') || word.includes('/tmp/') ? '<path>' : word.replace(/\d+/gu, '#')).join(' ')].slice(0, 240).join('');
  return `${detected.names.join(',')}|${normalized}`;
}
function nonzeroFailureCount(text: string): boolean {
  for (const m of text.matchAll(/\b(\d+)\s+(failed|failure|failures|errors|error)\b/gu)) if (Number(m[1]) !== 0) return true;
  return false;
}
function testPass(text: string): boolean {
  const l = lower(text);
  const pass = [' passed', 'passed in', 'tests passed', 'all tests passed', 'test ok', 'test result: ok', 'passed.\n', 'tests pass', '\nok ', '✓ '].some((p) => l.includes(p));
  return pass && !['✗ ', 'fatal:', 'assertionerror', 'error:'].some((p) => l.includes(p)) && !nonzeroFailureCount(l);
}

function buildSignals(calls: Array<{name:string;command?:string;source?:string}>, results: Result[], turnDepth:number, assistantTurns:number, compacted:boolean, recentWindow:number): ToolSignals {
  const signal = emptySignals(turnDepth); signal.assistantTurnCount = assistantTurns; signal.toolResultCount = results.length; signal.compacted = compacted;
  const window = Math.max(1, recentWindow); const recentResults = results.slice(-window);
  signal.severity = recentResults.reduce((max, result) => Math.max(max, failureSeverity(result.text, result.isError).severity), 0);
  const fingerprints = recentResults.map((r) => fingerprint(r.text,r.isError)).filter((v):v is string=>v!==undefined);
  signal.repeatedFailure = new Set(fingerprints).size < fingerprints.length;
  for (const result of [...results].reverse()) { if (result.isError || failureSeverity(result.text,false).severity > 0) break; signal.noErrorStreak++; }
  signal.testsPassed = recentResults.some((result,index) => {
    const latestFailure = recentResults.map((r,i)=>failureSeverity(r.text,r.isError).severity>0||r.isError?i:-1).filter(i=>i>=0).at(-1) ?? -1;
    return index > latestFailure && testPass(result.text);
  });
  const recentCalls = calls.slice(-window); const count = (list:typeof calls) => list.map((call)=>semantic(call.name,call.command,call.source));
  const all = count(calls); const recent = count(recentCalls);
  signal.writeCount = all.filter((s)=>s==='write').length; signal.editCount=all.filter((s)=>s==='edit').length; signal.readCount=all.filter((s)=>s==='read').length; signal.todowriteCount=all.filter((s)=>s==='plan').length;
  signal.recentWriteCount=recent.filter((s)=>s==='write').length; signal.recentEditCount=recent.filter((s)=>s==='edit').length; signal.recentReadCount=recent.filter((s)=>s==='read').length; signal.recentTodowriteCount=recent.filter((s)=>s==='plan').length; signal.newCount=all.filter((s)=>s==='new').length; signal.recentNewCount=recent.filter((s)=>s==='new').length;
  for(const s of [...all].reverse()){if(s!=='unknown')break;signal.pureBashStreak++;}
  return signal;
}

export function extractToolSignals(conversation: Conversation, recentWindow = DEFAULT_RECENT_WINDOW): ToolSignals {
  const calls: Array<{name:string;command?:string}> = []; const results: Result[]=[]; const ids=new Map<string,boolean>(); let assistants=0; let compacted=false;
  for(const message of conversation.messages){if(message.role==='assistant')assistants++;
    if(message.content.toLowerCase().includes('session is being continued'))compacted=true;
    for(const call of message.toolCalls){const command=argumentCommand(call.arguments);calls.push({name:call.name,...(command!==undefined?{command}:{})}); ids.set(call.id,semantic(call.name,command)==='read');}
    for(const result of message.toolResults){const retrieval=ids.get(result.toolCallId)===true&&!result.isError;results.push({text:retrieval?'':result.content,isError:result.isError===true});}
  }
  return buildSignals(calls,results,conversation.messages.length,assistants,compacted,recentWindow);
}

export function extractToolSignalsFromObservations(observations: readonly ToolObservation[], turnDepth = observations.length, recentWindow = DEFAULT_RECENT_WINDOW): ToolSignals {
  const calls=observations.map((o)=>({name:o.name, ...(o.command!==undefined?{command:o.command}:{}), ...(o.source!==undefined?{source:o.source}:{})}));
  const results=observations.filter((o)=>o.resultText!==undefined||o.isError===true).map((o)=>({text:!o.isError && semantic(o.name,o.command,o.source)==='read' ? '' : o.resultText??'',isError:o.isError===true}));
  return buildSignals(calls,results,turnDepth,turnDepth,false,recentWindow);
}
