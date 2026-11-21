import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Translate } from './i18n.ts'
import { translator } from './i18n.ts'
import type { CheckResult, ProjectAcceptance, Task, TaskAcceptance } from './protocol.ts'
import type { State } from './store.ts'

export const taskEnded = (task: Task) => ['completed', 'stopped', 'failed', 'review'].includes(task.status)
const allPassed = (checks: string[], results?: CheckResult[]) =>
  checks.length === 0 || (results?.length === checks.length && results.every(result => result.status === 'passed'))

export function taskPassed(task: Task): boolean {
  const check = task.acceptance
  return task.status === 'completed' && (!check || (allPassed(check.checks, check.local)
    && (check.phase !== 'integration' || !check.workDirectory || !!check.artifacts?.length)))
}

export function projectFor(state: State, parent: string): ProjectAcceptance | undefined {
  return Object.values(state.projects).findLast(project => project.parent === parent && !project.superseded)
}

function currentTasks(state: State, project: string): Task[] {
  const tasks = Object.values(state.tasks).filter(task => task.acceptance?.project === project)
  const replaced = new Set(tasks.map(task => task.acceptance?.replaces))
  return tasks.filter(task => !replaced.has(task.id))
}

export function cleanChecks(values: string[], t = translator()): string[] {
  const checks = values.map(value => value.trim())
  if (!checks.length || checks.length > 24 || new Set(checks).size !== checks.length
    || checks.some(check => !check || check.length > 480)) {
    throw new Error(t('Enter 1 to 24 unique acceptance criteria, at most 480 characters each.', '验收标准需有 1 至 24 条，每条不超过 480 字符且不得重复'))
  }
  return checks
}

export function createPlan(state: State, parent: string, input: {
  objective: string; depth: ProjectAcceptance['depth']; checks: string[]; supersede?: string; isolatedIn?: string
}): ProjectAcceptance {
  const t = translator(state.preferences.interfaceLocale)
  const objective = input.objective.trim()
  if (!objective || objective.length > 3000) throw new Error(t('The project objective must contain 1 to 3,000 characters.', '项目目标需包含 1 至 3000 字符'))
  const checks = cleanChecks(input.checks, t)
  const current = projectFor(state, parent)
  if (current && !current.acceptedBy) {
    if (current.objective === objective && current.depth === input.depth && !!current.directory === !!input.isolatedIn
      && JSON.stringify(current.checks) === JSON.stringify(checks)) return current
    if (input.supersede !== current.id) throw new Error(t('The current project is still open. Use supersede to replace its criteria when requirements change.', '当前项目仍在验收。需求变化时用 supersede 明确替换项目标准'))
    if (currentTasks(state, current.id).some(task => !taskEnded(task))) throw new Error(t('Wait for the current project tasks to settle.', '请先等待旧项目派发结算'))
    current.superseded = true
  }
  const id = randomUUID()
  const project: ProjectAcceptance = { id, parent, objective, depth: input.depth, checks,
    ...(input.isolatedIn ? { directory: join(input.isolatedIn, '.dsh-session-tree', id) } : {}) }
  state.projects[project.id] = project
  return project
}

export interface DispatchAcceptance {
  project?: string
  phase?: TaskAcceptance['phase']
  checks?: string[]
  replaces?: string
}

export function prepareAcceptance(state: State, task: Task, input: DispatchAcceptance): void {
  const t = translator(state.preferences.interfaceLocale)
  const project = projectFor(state, task.parent)
  const { phase, replaces } = input
  if (!input.project) {
    if (project && !project.acceptedBy) throw new Error(t('Dispatch for the current project requires project, phase and the applicable criteria.', '当前项目的派发必须填写 project、phase 和对应验收标准'))
    if (phase || input.checks || replaces) throw new Error(t('Register the acceptance plan and provide its project ID.', '请先登记项目验收并填写 project'))
    return
  }
  if (!project || project.id !== input.project || project.acceptedBy || !phase) {
    throw new Error(t('Provide the open project ID and the task phase.', '请填写当前未完成项目的 project 和 phase'))
  }
  if (phase === 'review' && project.depth === 'light') {
    throw new Error(t('Light projects include overall acceptance in integration. Use a thorough plan for a separate review.', '轻量项目的整体验收随整合任务执行。需要单独整体验收时，请使用完整项目计划'))
  }
  const checks = phase === 'review' ? [] : cleanChecks(input.checks ?? [], t)
  if (phase === 'review' && input.checks?.length) throw new Error(t('Review uses the project criteria. Omit checks.', '整体验收直接使用项目标准，请省略 checks'))
  const tasks = currentTasks(state, project.id)
  const previous = tasks.find(item => item.id === replaces)
  if (replaces && (!previous || previous.acceptance?.phase !== phase || !taskEnded(previous))) {
    throw new Error(t('replaces must refer to a settled task in this project with the same phase.', 'replaces 必须指向当前项目中已结算且阶段相同的任务'))
  }
  if (previous?.acceptance?.checks.some(check => !checks.includes(check))) {
    throw new Error(t('Keep the original task criteria when reworking it. Update the project plan if requirements changed.', '返工需保留原单项验收标准。用户变更要求时请先更新项目标准'))
  }
  const integration = tasks.find(item => item.acceptance?.phase === 'integration')
  if (phase === 'integration' && integration && replaces !== integration.id) {
    throw new Error(t('An integration task exists. Set replaces to its ID to redo it.', '已有整合任务。重做时请用 replaces 指向该任务'))
  }
  if (phase === 'review' && (!integration || !hasCurrentInputs(integration, tasks))) {
    throw new Error(t('Dispatch integration for the current deliverables first.', '请先为当前各单项交付派发整合任务'))
  }
  const review = tasks.find(item => item.acceptance?.phase === 'review' && item.acceptance?.integration === integration?.id)
  if (phase === 'review' && review && replaces !== review.id) {
    throw new Error(t('The output already has a review task. Set replaces to its ID to review it again.', '当前产物已有整体验收任务。重验时请用 replaces 指向该任务'))
  }
  const prerequisites = phase === 'integration'
    ? tasks.filter(item => item.acceptance?.phase === 'work').map(item => item.id)
    : phase === 'review' ? [integration!.id] : []
  task.after = [...new Set([...(task.after ?? []), ...prerequisites])]
  // For lightweight work the same executor checks its own delivery first, then the integrated project.
  const final = phase === 'review' || (phase === 'integration' && project.depth === 'light')
  const workDirectory = project.directory && join(project.directory, 'workers', task.child,
    phase === 'integration' ? 'output' : phase === 'review' ? 'review' : '')
  task.acceptance = { project: project.id, phase, checks, projectChecks: final ? project.checks : [],
    ...(replaces ? { replaces } : {}), ...(phase === 'review' ? { integration: integration!.id } : {}),
    ...(workDirectory ? { workDirectory } : {}) }
  task.objective = project.objective
}

function hasCurrentInputs(integration: Task, current: Task[]): boolean {
  return current.filter(task => task.acceptance?.phase === 'work').every(task => integration.after?.includes(task.id))
}

export function validatedResults(checks: string[], input: CheckResult[], t: Translate): CheckResult[] {
  if (!checks.length || input.length !== checks.length) throw new Error(t('Provide a result for every numbered criterion.', '请按验收编号逐条报告全部结果'))
  const results = input.map(item => ({ ...item, evidence: item.evidence.trim() })).sort((a, b) => a.check - b.check)
  if (results.some((item, index) => item.check !== index + 1 || !item.evidence || item.evidence.length > 800)) {
    throw new Error(t('Cover every criterion starting at 1. Include evidence or a reason it could not be verified.', '验收编号需按 1 起始逐项覆盖，每项需有简短证据或无法验证的原因'))
  }
  return results
}

export function recordAcceptance(report: TaskAcceptance, local?: CheckResult[], final?: CheckResult[], t = translator()): void {
  if (!local && !final) throw new Error(t('Submit acceptance results for this task.', '请提交本任务的验收结果'))
  if (local) {
    report.local = validatedResults(report.checks, local, t)
    delete report.final
  }
  if (final) {
    if (!allPassed(report.checks, report.local)) throw new Error(t('All task criteria must pass before reporting project acceptance.', '单项全部通过后才能提交整体验收'))
    report.final = validatedResults(report.projectChecks, final, t)
  }
}

export function confirmPlan(state: State, parent: string, projectId: string, proof: string): ProjectAcceptance {
  const t = translator(state.preferences.interfaceLocale)
  const project = projectFor(state, parent)
  if (!project || project.id !== projectId) throw new Error(t('The current project ID is required.', '需要当前项目 ID'))
  if (project.acceptedBy === proof) return project
  if (project.acceptedBy) throw new Error(t('The project has already passed acceptance.', '当前项目已验收'))
  const tasks = currentTasks(state, projectId)
  const task = tasks.find(item => item.id === proof)
  const integration = tasks.find(item => item.acceptance?.phase === 'integration')
  if (!integration || !hasCurrentInputs(integration, tasks) || !taskPassed(integration) || !task?.acceptance
    || !taskPassed(task) || !task.acceptance.projectChecks.length || !allPassed(task.acceptance.projectChecks, task.acceptance.final)
    || (task.id !== integration.id && task.acceptance.integration !== integration.id)
    || tasks.some(item => !taskEnded(item))) {
    throw new Error(t('The current integrated output needs passing task checks and a complete, passing project review.', '当前整合产物需要全部单项通过，以及完整的整体验收通过记录'))
  }
  project.acceptedBy = proof
  return project
}

export function acceptanceText(acceptance: TaskAcceptance, t: Translate): string {
  const labels = { passed: t('Passed', '通过'), failed: t('Failed', '未通过'), unverified: t('Unverified', '未验证') }
  const format = (heading: string, checks: string[], results?: CheckResult[]) => !checks.length ? '' : [
    heading + ' · ' + (results ? `${results.filter(result => result.status === 'passed').length}/${checks.length} ${t('passed', '通过')}` : t('Awaiting results', '待提交')),
    ...checks.map((check, index) => {
      const result = results?.[index]
      return `${index + 1}. ${check}${result ? ` — ${labels[result.status]}${t(', ', '，')}${result.evidence}` : ''}`
    }),
  ].join('\n')
  return [format(t('Task acceptance', '单项验收'), acceptance.checks, acceptance.local),
    format(t('Project acceptance', '整体验收'), acceptance.projectChecks, acceptance.final)].filter(Boolean).join('\n\n')
}
