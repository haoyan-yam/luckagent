export type CodexGoalStatus = 'complete' | 'continue' | 'blocked';

export function truncateLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

export function truncateBlock(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 20) + '\n\n...(truncated)';
}

export function buildCodexGoalPrompt(prompt: string, goal: string, iteration: number, maxIterations: number): string {
  return [
    '<luckagent-codex-goal>',
    `Active goal: ${goal}`,
    `Iteration: ${iteration}/${maxIterations}`,
    'Work autonomously toward the goal. At the end of your final response, include exactly one status line:',
    'GOAL_STATUS: complete | continue | blocked',
    'Use complete only when the goal is genuinely satisfied, continue when the next autonomous turn should proceed, and blocked when user input or external state is required.',
    '</luckagent-codex-goal>',
    '',
    prompt,
  ].join('\n');
}

export function parseCodexGoalStatus(text: string | undefined): CodexGoalStatus | undefined {
  const match = (text ?? '').match(/GOAL_STATUS:\s*(complete|continue|blocked)/i);
  return match?.[1]?.toLowerCase() as CodexGoalStatus | undefined;
}
