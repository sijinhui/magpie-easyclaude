const gptModels = ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol'];
const claudeModels = ['claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5'];

export const modelDefaults = Object.fromEntries([...gptModels, ...claudeModels].map(id => {
  const gpt = id.startsWith('gpt-');
  const haiku45 = id === 'claude-haiku-4-5-20251001';
  let levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (id === 'gpt-5.4' || id === 'gpt-5.5') levels = ['none', 'low', 'medium', 'high', 'xhigh'];
  else if (gpt && id !== 'gpt-6-astra' && id !== 'gpt-6.1-sol') levels.unshift('none');
  if (id.endsWith('-4-6')) levels = ['low', 'medium', 'high', 'max'];
  if (haiku45) levels = [];
  return [id, {
    name: id,
    limit: gpt ? { context: 1050000, input: 922000, output: 128000 }
      : { context: haiku45 ? 200000 : 1000000, output: haiku45 ? 64000 : 128000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    reasoning: true, tool_call: true, attachment: true,
    variants: Object.fromEntries(levels.map(level => [level, {}])),
  }];
}));
