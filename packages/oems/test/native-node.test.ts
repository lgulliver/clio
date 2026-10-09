import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('validates and calculates a complete fixture through native Node TypeScript', () => {
  const module = new URL('../src/index.ts', import.meta.url);
  const input = new URL('../vendor/conformance/v0.1/cases/complete.json', import.meta.url);
  const expected = new URL(
    '../vendor/conformance/v0.1/expected-results/complete.json',
    import.meta.url,
  );
  const script = `
    import { validateSnapshot, calculate } from ${JSON.stringify(module.href)};
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(new URL(${JSON.stringify(input.href)}), 'utf8'));
    const checked = validateSnapshot(input);
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    console.log(JSON.stringify(calculate(checked.data)));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const actual: unknown = JSON.parse(output);
  const result: unknown = JSON.parse(readFileSync(expected, 'utf8'));
  expect(actual).toEqual([result]);
});
