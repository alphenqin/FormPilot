import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Id } from './profile';
import { ExecutionPacketSchema, ExecutionCheckpointSchema } from './fill';
const obj = <T extends import('@sinclair/typebox').TProperties>(
  properties: T,
) => Type.Object(properties, { additionalProperties: false });
const base = {
  protocol_version: Type.Literal('1'),
  request_id: Id,
  task_id: Id,
};
export const ExecutionUiMessageSchema = obj({
  ...base,
  method: Type.Union([
    Type.Literal('execution.start'),
    Type.Literal('execution.status'),
    Type.Literal('execution.cancel'),
    Type.Literal('execution.interrupt'),
  ]),
  workspace_id: Id,
  execution_id: Id,
});
export type ExecutionUiMessage = Static<typeof ExecutionUiMessageSchema>;
export const isExecutionUiMessage = (
  value: unknown,
): value is ExecutionUiMessage => Value.Check(ExecutionUiMessageSchema, value);
export const ExecutionContentMessageSchema = Type.Union([
  obj({
    ...base,
    method: Type.Literal('execution.run'),
    workspace_id: Id,
    packet: ExecutionPacketSchema,
    started_at: Type.Integer(),
  }),
  obj({
    ...base,
    method: Type.Union([
      Type.Literal('execution.read'),
      Type.Literal('execution.stop'),
    ]),
    execution_id: Id,
  }),
]);
export const isExecutionContentMessage = (
  value: unknown,
): value is Static<typeof ExecutionContentMessageSchema> =>
  Value.Check(ExecutionContentMessageSchema, value);
export const ExecutionJournalMessageSchema = obj({
  ...base,
  method: Type.Literal('execution.checkpoint'),
  workspace_id: Id,
  checkpoint: ExecutionCheckpointSchema,
});
export type ExecutionJournalMessage = Static<
  typeof ExecutionJournalMessageSchema
>;
