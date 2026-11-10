/** The producer console owns transport and authority. This module owns only its scoped public read view. */
export function guidancePanelAssets(): { js: string; css: string } {
  const js = String.raw`
export default (host) => {
  const doc = host.mount.ownerDocument;
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const root = node('div', undefined, 'ahub-guidance');
  root.hidden = true;
  const title = node('h2', 'Guidance');
  const introduction = node('p', 'Inspect task-bound declarations and editable-section diffs. Source evidence is a declaration; actual handoff, testing and model consumption are unknown.');
  const instructions = node('p', 'Create or withdraw with the authorized ahub guidance CLI or MCP tools. This panel only reads declarations.');
  const scopeForm = node('form', undefined, 'ahub-guidance-scope');
  const field = (label, control) => {
    const wrapper = node('label');
    wrapper.append(node('span', label), control);
    scopeForm.append(wrapper);
    return control;
  };
  const project = field('Project', node('select'));
  project.append(node('option', 'Select a running project'));
  project.options[0].value = '';
  const task = field('Task ID', node('input'));
  const epoch = field('Task creation epoch', node('input'));
  for (const input of [task, epoch]) {
    input.type = 'text'; input.inputMode = 'numeric'; input.required = true;
    input.autocomplete = 'off'; input.pattern = '[0-9]+';
  }
  const listButton = node('button', 'List declarations'); listButton.type = 'submit';
  const projectsButton = node('button', 'Refresh projects'); projectsButton.type = 'button';
  scopeForm.append(listButton, projectsButton);
  const notice = node('p', 'Select a project, task ID and task creation epoch.');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const recordList = node('div', undefined, 'ahub-guidance-records');
  const next = node('button', 'Next page'); next.type = 'button'; next.hidden = true;
  const output = node('pre', undefined, 'ahub-guidance-output');
  output.tabIndex = 0; output.setAttribute('aria-label', 'Guidance public details');
  root.append(title, introduction, instructions, scopeForm, notice, recordList, next, output);
  host.mount.append(root);
  let generation = 0, disposed = false, visible = false, projects = [], cursor, busy = false;
  const state = (message) => { notice.textContent = message; };
  const update = () => {
    listButton.disabled = busy;
    projectsButton.disabled = busy;
    next.disabled = busy;
    for (const button of recordList.querySelectorAll('button')) button.disabled = busy;
    root.setAttribute('aria-busy', busy ? 'true' : 'false');
  };
  const invalidate = () => {
    generation++; busy = false; cursor = undefined;
    recordList.replaceChildren(); output.textContent = ''; next.hidden = true;
    update();
  };
  const scope = () => {
    const selected = projects.find(row => row.id === project.value);
    if (!selected || typeof selected.instanceId !== 'string' || !selected.instanceId
      || !/^[0-9]+$/.test(task.value) || !/^[0-9]+$/.test(epoch.value)) return;
    const taskId = Number(task.value), taskCreated = Number(epoch.value);
    if (!Number.isSafeInteger(taskId) || taskId < 1 || !Number.isSafeInteger(taskCreated) || taskCreated < 0) return;
    return { projectId: selected.id, instanceId: selected.instanceId, taskId, taskCreated };
  };
  const active = (token) => !disposed && visible && token === generation;
  const failure = () => state('Guidance unavailable. Refresh the selected task scope or check access and guidance_views support.');
  const track = (work) => { void work.catch(() => {}); };
  async function refreshProjects(wanted) {
    invalidate();
    const token = generation;
    busy = true; update(); state('Reading running projects...');
    try {
      const result = await host.snapshot({ panel: 'board', after: 0 });
      if (!active(token)) return;
      if (!result || result.ok === false || !Array.isArray(result.projects)) { failure(); return; }
      const previous = typeof wanted === 'string' ? wanted : project.value;
      projects = result.projects.filter(row => row && typeof row.id === 'string' && row.state === 'running'
        && typeof row.instanceId === 'string' && row.instanceId);
      const empty = node('option', 'Select a running project'); empty.value = '';
      project.replaceChildren(empty);
      for (const row of projects) { const option = node('option', row.id); option.value = row.id; project.append(option); }
      project.value = projects.some(row => row.id === previous) ? previous : '';
      state(projects.length ? 'Select an explicit task ID and creation epoch, then list declarations.' : 'No running projects are available.');
    } catch { if (active(token)) failure(); }
    finally { if (active(token)) { busy = false; update(); } }
  }
  async function read(op, id, after) {
    const selected = scope();
    if (!selected) { state('Select a running project and enter a valid task ID and creation epoch.'); return; }
    const token = ++generation;
    busy = true; next.hidden = true; update();
    state(op === 'show' ? 'Reading declaration diff...' : 'Reading declarations...');
    recordList.replaceChildren(); output.textContent = ''; cursor = undefined;
    try {
      const result = await host.snapshot({ panel: 'guidance', op, ...selected,
        ...(id === undefined ? {} : { id }), ...(after === undefined ? {} : { cursor: after }) });
      if (!active(token)) return;
      if (!result || result.ok !== true || !result.guidance || result.guidance.state !== 'available') { failure(); return; }
      const value = result.guidance;
      if (value.current?.taskId !== selected.taskId || value.current?.taskCreated !== selected.taskCreated) { failure(); return; }
      if (op === 'show' && value.record?.id !== id || op === 'list' && !Array.isArray(value.records)) { failure(); return; }
      if (!Array.isArray(result.lines) || result.lines.some(line => typeof line !== 'string')) { failure(); return; }
      output.textContent = result.lines.join('\n');
      if (op === 'list') {
        for (const record of value.records) {
          const row = node('div', undefined, 'ahub-guidance-record');
          const identity = node('code', record.id);
          const status = node('span', record.status + '; applicable: ' + (record.applicable ? 'yes' : 'no'));
          const show = node('button', 'Show diff'); show.type = 'button';
          show.addEventListener('click', () => track(read('show', record.id)));
          row.append(identity, status, show); recordList.append(row);
        }
        if (value.truncated && typeof value.cursor === 'string' && value.cursor) {
          cursor = value.cursor; next.hidden = false;
        }
      }
      state(op === 'show' ? 'Public editable-section diff. Protected section bodies remain private.'
        : value.truncated ? 'Page read. Use Next page to read more, or list again to refresh.' : 'Page complete.');
    } catch { if (active(token)) failure(); }
    finally { if (active(token)) { busy = false; update(); } }
  }
  scopeForm.addEventListener('submit', event => { event.preventDefault(); track(read('list')); });
  projectsButton.addEventListener('click', () => track(refreshProjects()));
  next.addEventListener('click', () => { if (cursor) track(read('list', undefined, cursor)); });
  for (const input of [project, task, epoch]) input.addEventListener('input', () => {
    invalidate(); state('Task scope changed. List declarations to read the selected scope.');
  });
  return {
    show(_panel, params) {
      if (disposed) return;
      visible = true; root.hidden = false;
      if (typeof params?.taskId === 'string') task.value = params.taskId;
      if (typeof params?.taskCreated === 'string') epoch.value = params.taskCreated;
      track(refreshProjects(typeof params?.project === 'string' ? params.project : undefined));
    },
    hide() { visible = false; invalidate(); root.hidden = true; },
    destroy() { disposed = true; visible = false; invalidate(); root.remove(); },
  };
};
`;
  const css = `.ahub-guidance{color:inherit;font:inherit;padding:20px;max-width:1100px;-webkit-font-smoothing:antialiased}
.ahub-guidance h2{margin:0 0 8px;text-wrap:balance}.ahub-guidance p{max-width:85ch;line-height:1.5;text-wrap:pretty}
.ahub-guidance-scope{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:20px 0}
.ahub-guidance label{display:grid;gap:6px;min-width:160px}.ahub-guidance label span{font-size:.875em}
.ahub-guidance input,.ahub-guidance select,.ahub-guidance button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;min-height:40px;padding:8px 12px}
.ahub-guidance input{width:18ch;max-width:100%;box-sizing:border-box;font-variant-numeric:tabular-nums}
.ahub-guidance button{cursor:pointer}.ahub-guidance button:disabled{opacity:.5;cursor:default}
.ahub-guidance :is(button,input,select,pre):focus-visible{outline:2px solid currentColor;outline-offset:3px}
.ahub-guidance-records{display:grid;gap:8px;margin:12px 0}.ahub-guidance-record{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px;border:1px solid currentColor;border-radius:10px}
.ahub-guidance-record code{overflow-wrap:anywhere;flex:1 1 30ch}.ahub-guidance-record span{font-size:.875em}
.ahub-guidance-output{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.875em;line-height:1.55;font-variant-numeric:tabular-nums;padding:16px;border:1px solid currentColor;border-radius:10px;max-height:65vh;overflow:auto}
.ahub-guidance-output:empty{display:none}.ahub-guidance [hidden]{display:none!important}
@media(max-width:600px){.ahub-guidance{padding:12px}.ahub-guidance-scope>label{width:100%}.ahub-guidance input{width:100%}}`;
  return { js, css };
}
