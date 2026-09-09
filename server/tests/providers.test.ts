import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Processor, runCommand, type Stage } from '../src/processor.js';
import type { JobRow } from '../src/db.js';
import { testConfig, intent } from './helpers.js';

test('real HTTP provider adapter sends shared prompts, bounded generation parameters and validates summary/action output', async () => {
  const calls: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    assert.equal(req.headers.authorization, 'Bearer synthetic-provider-key');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                calls.length === 1
                  ? '<think>Hidden reasoning</think>\n## Overview\nSynthetic meeting notes.'
                  : '[{"text":"Verify result","owner":null,"due_date":null}]',
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-provider-test-'));
  try {
    const c = testConfig();
    c.PROCESSOR = 'providers';
    c.LLM_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    c.LLM_KEY = 'synthetic-provider-key';
    const source = Buffer.from(
      JSON.stringify({
        transcript: '[Alice] I will verify the result.',
        summaryDetail: 'concise',
        title: 'Synthetic provider test',
        disableThinking: true,
      }),
    );
    const filename = path.join(dir, 'source.json');
    await writeFile(filename, source);
    const stage: Stage = async (_name, schema, compute) => schema.parse(await compute());
    const result = await new Processor(c).process(
      { kind: 'text_generation', intent: intent(c, source, 'text_generation') } as JobRow,
      filename,
      dir,
      new AbortController().signal,
      stage,
    );
    assert.equal(result.text?.summary, '## Overview\nSynthetic meeting notes.');
    assert.equal(result.text?.actionItems[0].text, 'Verify result');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].max_tokens, 8192);
    assert.deepEqual(calls[0].chat_template_kwargs, { enable_thinking: false });
    assert.match((calls[0].messages as { content: string }[])[0].content, /CONCISE, FAITHFUL/);
    assert.equal((calls[1].messages as { content: string }[])[1].content, result.text?.summary);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
});
test('subprocess cancellation kills bounded inference without leaking command stderr', async () => {
  const controller = new AbortController();
  const running = runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)'],
    controller.signal,
    30000,
  );
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, /CANCELLED|MEDIA_OR_MODEL_FAILED/);
});
