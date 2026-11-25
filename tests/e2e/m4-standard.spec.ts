import { test, expect } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildFillPlan,
  newPlanningContext,
  resolveContext,
} from '@formpilot/domain';
import { type FieldResolution, type FieldValue } from '@formpilot/contracts';
import {
  standardSample,
  standardRequest,
  standardTemplates,
  STANDARD_VERSION,
} from '../fixtures/m4-standard';
import {
  initializeExecution,
  packetFor,
  runPacket,
  finished,
} from './execution-browser';
for (let index = 0; index < 10; index++)
  for (const template of standardTemplates) {
    test(`M4 标准任务 ${index + 1}/10 × ${template}`, async ({
      page,
    }, testInfo) => {
      const sample = standardSample(index),
        v = sample.values;
      await initializeExecution(page, '', 'standard-' + template + '.html');
      const snapshot = await page.evaluate(() => window.__m4scanner.scan()),
        request = standardRequest(sample.profile, snapshot),
        ctx = newPlanningContext(request, { mappings: [] });
      let plan = await buildFillPlan(ctx, {
        plan_id: crypto.randomUUID(),
        plan_revision: 1,
        expires_at: Date.now() + 600000,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 0,
      });
      const resolutions: FieldResolution[] = [];
      for (const d of plan.field_decisions)
        if (d.reason_code === 'CURRENT_VALUE_CONFLICT')
          resolutions.push({ type: 'replace', field_id: d.field_id });
      if (template === 'internships')
        for (const key of ['a', 'b'] as const) {
          const f = snapshot.fields.find(
            (f) => f.html_id === 'company_' + key,
          )!;
          const entity = sample.profile.entities.find((e) =>
            sample.profile.facts.some(
              (f) =>
                f.entity_id === e.entity_id &&
                f.path === 'internship.company' &&
                f.value === v[`company_${key}`],
            ),
          )!;
          resolutions.push({
            type: 'bind_entity',
            group_id: f.group_id,
            category: 'internship',
            entity_id: entity.entity_id,
          });
        }
      if (resolutions.length) {
        const next = resolveContext(ctx, plan, {
          schema_version: 1,
          client_request_id: crypto.randomUUID(),
          task_id: plan.task_id,
          plan_id: plan.plan_id,
          expected_plan_revision: 1,
          answers: [],
          resolutions,
        });
        plan = await buildFillPlan(next, {
          plan_id: crypto.randomUUID(),
          plan_revision: 2,
          expires_at: plan.expires_at,
          usage: plan.usage,
          duration_ms: 0,
        });
      }
      const expected: Record<string, FieldValue> =
        template === 'basic'
          ? {
              name: v.name,
              email: v.email,
              phone: v.phone,
              current_city: v.current_city,
              intention_city: v.intention_city === '杭州' ? 'HZ' : 'BJ',
            }
          : template === 'education'
            ? {
                name: v.name,
                email: v.email,
                school: v.school,
                major: v.major,
                degree: v.degree === '本科' ? 'BA' : 'MA',
                edu_start: v.edu_start,
                edu_end: v.edu_end,
              }
            : {
                name: v.name,
                intention_city: v.intention_city,
                company_a: v.company_a,
                position_a: v.position_a,
                start_a: v.start_a,
                end_a: v.end_a,
                company_b: v.company_b,
                position_b: v.position_b,
                start_b: v.start_b,
                end_b: v.end_b,
              };
      const asks =
        template === 'basic'
          ? ['availability_days']
          : template === 'education'
            ? ['edu_end_day']
            : [];
      const fills = plan.field_decisions.filter((d) => d.decision === 'fill');
      expect(fills).toHaveLength(Object.keys(expected).length);
      for (const f of fills) {
        const original = snapshot.fields.find(
          (field) => field.field_id === f.field_id,
        )!;
        expect(f.target_value).toEqual(expected[original.html_id]);
        expect(f.fact_refs.length).toBeGreaterThan(0);
        expect(f.evidence_ids.length).toBeGreaterThan(0);
      }
      for (const id of asks) {
        const field = snapshot.fields.find((f) => f.html_id === id)!;
        expect(
          plan.field_decisions.find((d) => d.field_id === field.field_id),
        ).toMatchObject({ decision: 'ask', target_value: null });
      }
      expect(plan.field_decisions.some((d) => d.decision === 'review')).toBe(
        false,
      );
      const targets = Object.fromEntries(
        fills.map((d) => [
          snapshot.fields.find((f) => f.field_id === d.field_id)!.html_id,
          d.target_value,
        ]),
      );
      const packet = await packetFor(page, targets);
      packet.plan_id = plan.plan_id;
      packet.plan_revision = plan.plan_revision;
      packet.plan_digest = plan.plan_digest;
      packet.profile_revision = plan.profile_revision;
      await page.evaluate((p) => {
        window.__m4packets[p.execution_id] = p;
      }, packet);
      await runPacket(page, packet);
      const result = await finished(page, packet.execution_id),
        measurements = await page.evaluate(() => window.__m4timings);
      const actual = await page.evaluate(
        (ids) =>
          Object.fromEntries(
            ids.map((id) => {
              const input = document.getElementById(id) as
                | HTMLInputElement
                | HTMLSelectElement;
              return [id, input.value];
            }),
          ),
        Object.keys(expected),
      );
      const errors: string[] = [];
      for (const [id, target] of Object.entries(expected))
        if (JSON.stringify(actual[id]) !== JSON.stringify(target))
          errors.push(id + ':wrong_value');
      for (const row of result.report.field_results)
        if (row.status !== 'verified')
          errors.push(row.field_id + ':' + row.error_code);
      const submits = await page.evaluate(() => window.submits);
      if (submits !== 0) errors.push('AUTO_SUBMIT');
      if (await page.locator('#terms').isChecked())
        errors.push('LEGAL_CONSENT_WRITTEN');
      for (const id of asks)
        if ((await page.locator('#' + id).inputValue()) !== '')
          errors.push(id + ':UNAPPROVED_WRITE');
      const field_ms = result.report.field_results.map((row) => {
        const before = measurements.find(
            (m) => m.field_id === row.field_id && m.phase === 'before',
          )!,
          after = measurements.find(
            (m) => m.field_id === row.field_id && m.phase === 'after',
          )!;
        return {
          field_id: row.field_id,
          duration_ms: after.at_ms - before.at_ms,
        };
      });
      const record = {
        dataset: STANDARD_VERSION,
        expected_values: expected,
        actual_values: actual,
        adapter_version: snapshot.adapter_version,
        sample_id: sample.id,
        template,
        approved_execution_fields: fills.length,
        expected_fillable_fields: Object.keys(expected).length + asks.length,
        correct_first_write_fields: fills.filter((d) => {
          const id = snapshot.fields.find(
            (f) => f.field_id === d.field_id,
          )!.html_id;
          return (
            JSON.stringify(actual[id]) === JSON.stringify(expected[id]) &&
            result.report.field_results.some(
              (r) => r.field_id === d.field_id && r.status === 'verified',
            )
          );
        }).length,
        manual_fields: asks.length + 2,
        user_review_actions: resolutions.length,
        errors,
        submits,
        task_duration_ms: result.report.ended_at - result.report.started_at,
        field_timings: field_ms,
        decisions: plan.field_decisions.map((d) => ({
          field: snapshot.fields.find((f) => f.field_id === d.field_id)!
            .html_id,
          path: d.semantic_path,
          decision: d.decision,
          entity_id: d.entity_id,
        })),
        browser: page.context().browser()?.version() ?? 'unknown',
      };
      await mkdir(testInfo.project.outputDir, { recursive: true });
      const path = join(
        testInfo.project.outputDir,
        `m4-standard-${sample.id}-${template}.json`,
      );
      await writeFile(path, JSON.stringify(record, null, 2));
      await testInfo.attach('standard-task-metrics', {
        path,
        contentType: 'application/json',
      });
      expect(errors).toEqual([]);
      expect(submits).toBe(0);
    });
  }
