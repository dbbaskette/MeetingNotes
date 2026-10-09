import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildSummaryPrompt, type SummaryDetail } from './prompts.js';
import { REQUIRED_SUMMARY_SECTIONS, SUMMARY_TEMPLATES, isSummaryTemplateId, summaryTemplate, templateSections } from '../../shared/summary-templates.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('summary templates', () => {
  // Recorded from the prompt before templates existed. If these change, every
  // existing user's notes change shape; do that deliberately, not by accident.
  it.each([
    ['concise', null, 'e5afa9113b45b153'],
    ['concise', 'Platform planning', '40e3e037a5491c3e'],
    ['standard', null, '464d79e863e23531'],
    ['standard', 'Platform planning', '322e580b78a8d011'],
    ['detailed', null, 'ce89fad783ce0368'],
    ['detailed', 'Platform planning', '4282281c558b0f73'],
  ] as const)('General leaves the %s prompt (topic %s) byte-for-byte unchanged', (detail, topic, expected) => {
    expect(hash(buildSummaryPrompt(detail as SummaryDetail, topic))).toBe(expected);
    expect(hash(buildSummaryPrompt(detail as SummaryDetail, topic, summaryTemplate('general')))).toBe(expected);
  });

  it.each(SUMMARY_TEMPLATES.map((t) => [t.id, t] as const))('%s keeps the sections other features depend on, in order', (_id, template) => {
    const sections = templateSections(template);
    for (const required of REQUIRED_SUMMARY_SECTIONS) expect(sections).toContain(required);
    expect(sections[0]).toBe('Overview');
    expect(sections[sections.length - 1]).toBe('Off-topic Conversation');
    expect(sections.indexOf('Decisions')).toBeLessThan(sections.indexOf('Action Items'));
    expect(new Set(sections).size).toBe(sections.length);

    const prompt = buildSummaryPrompt('standard', null, template);
    const listed = prompt.split('\n').filter((line) => /^## /.test(line)).map((line) => line.slice(3));
    expect(listed).toEqual(sections);
    // Rules that the rest of the pipeline relies on survive every template.
    expect(prompt).toContain('Start the first line with "## Overview"');
    expect(prompt).toContain('Action Items: sweep the ENTIRE transcript');
    expect(prompt).toContain('Do NOT invent attendees');
  });

  it('adds a meeting-type brief and names only sections the template has', () => {
    const prompt = buildSummaryPrompt('detailed', null, summaryTemplate('standup'));
    expect(prompt).toContain('Meeting type — Standup:');
    expect(prompt).toContain('## Blockers');
    expect(prompt).not.toContain('Key Discussion Points');
  });

  it('has unique ids and falls back to General for unknown ones', () => {
    const ids = SUMMARY_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(summaryTemplate('retired-template').id).toBe('general');
    expect(summaryTemplate(null).id).toBe('general');
    expect(isSummaryTemplateId('standup')).toBe(true);
    expect(isSummaryTemplateId('nope')).toBe(false);
    expect(isSummaryTemplateId(7)).toBe(false);
  });
});
