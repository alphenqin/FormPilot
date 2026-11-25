import { it, expect } from 'vitest';
import { getModelProvider, ModelUnavailableError } from './index';
it('未配置模型必须明确失败', () => {
  expect(getModelProvider).toThrow(ModelUnavailableError);
});
