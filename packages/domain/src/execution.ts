import {
  canonicalJson,
  sameExecutionScope,
  type FillPlanView,
  type ExecutionView,
  type VerifyRequest,
  type VerifyResult,
} from '@formpilot/contracts';
import { PlanningFault } from './planning';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function verifyExecution(
  plan: FillPlanView,
  execution: ExecutionView,
  request: VerifyRequest,
): VerifyResult {
  const p = execution.packet,
    r = request.execution_report;
  if (
    plan.invalid_reason ||
    !plan.user_approval ||
    !['WRITING', 'REVIEW'].includes(plan.status) ||
    p.action === 'undo' ||
    p.plan_id !== plan.plan_id ||
    p.plan_revision !== plan.plan_revision ||
    p.plan_digest !== plan.plan_digest ||
    !sameExecutionScope(p.snapshot_ref, plan.snapshot_ref) ||
    !same(plan.user_approval, request.user_approval) ||
    request.task_id !== plan.task_id ||
    request.plan_id !== plan.plan_id ||
    request.plan_revision !== plan.plan_revision ||
    request.form_snapshot_id !== plan.form_snapshot_id ||
    request.execution_report.execution_id !== p.execution_id ||
    !['completed', 'interrupted'].includes(execution.phase) ||
    !same(r, execution.report)
  )
    throw new PlanningFault('STALE_PLAN');
  const ids = p.items.map((i) => i.field.field_id),
    rows = r.field_results;
  if (
    rows.length !== ids.length ||
    new Set(rows.map((f) => f.field_id)).size !== rows.length ||
    rows.some(
      (f, index) =>
        f.field_id !== ids[index] ||
        !same(f.before, p.items[index]!.before) ||
        !same(f.target, p.items[index]!.target) ||
        (f.status === 'verified' &&
          (!same(f.actual, f.target) ||
            f.error_code !== null ||
            !execution.written_field_ids.includes(f.field_id))),
    )
  )
    throw new PlanningFault('RULE_VIOLATION');
  const verified_fields = rows
      .filter((r) => r.status === 'verified')
      .map((r) => r.field_id),
    failed_fields = rows
      .filter((r) => r.status === 'failed')
      .map((r) => r.field_id);
  return {
    verified_fields,
    failed_fields,
    remaining_manual_fields: plan.field_decisions
      .filter(
        (d) => !verified_fields.includes(d.field_id) && d.decision !== 'skip',
      )
      .map((d) => d.field_id),
    status: 'REVIEW',
    application_submitted: false,
  };
}
