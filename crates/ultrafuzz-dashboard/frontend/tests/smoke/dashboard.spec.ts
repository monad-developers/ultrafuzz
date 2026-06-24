import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const internalCardTokens = [
  'project-discovery',
  'prepare-foundry-harness',
  'discover-base-test',
  'property-specification-fanin',
  '0kn0t-lens',
  'certora-thinking-lens',
  'aviggiano-lens',
  'josselin-feist-lens',
  'recon-lens',
  'encode-decode',
  'expand-coverage',
  'stateful-invariant-setup',
  'stateful-invariant-handlers',
  'stateful-invariant-coverage',
  'stateful-invariant-implement-properties',
  'stateful-invariant-recon-campaign',
  'agent-attempt',
  'consolidate',
  'kind:'
];

test('dashboard serves embedded React Flow assets and stable graph controls', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page.getByText('The React dashboard assets have not been built')).toHaveCount(0);
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.toolbar .mode-indicator')).toBeVisible();
  await expect(page.getByLabel('Run health')).toBeVisible();
  await expect(page.getByLabel('Run health')).toContainText(/Artifacts/i);
  await expect(page.getByLabel('Run health')).toContainText(/Lineage/i);
  await expect(page.locator('.toolbar .run-summary')).toHaveCount(0);
  await expect(page.locator('.toolbar').getByRole('button', { name: /^run$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^restart$/i })).toBeVisible();
  await expect(page.locator('.toolbar .advanced-actions__summary')).toBeVisible();
  await expect.poll(async () => visibleToolbarControlLabels(page)).toEqual(['Run', 'Restart', 'Advanced']);
  await expect(page.locator('.toolbar').getByRole('button', { name: /^status$/i })).toBeHidden();
  await page.locator('.toolbar .advanced-actions__summary').click();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^status$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^runs$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^report$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^doctor$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^config$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^materialize$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^clean$/i })).toBeVisible();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^add prompt$/i })).toBeVisible();
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  await expect(page.locator('.react-flow__controls')).toBeVisible();
  await expect(page.locator('.side-panel')).toHaveCount(0);
  await expect(page.locator('.event-panel')).toHaveCount(0);
  await expect(page.locator('.activity-console')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand side panel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Activity Console' })).toBeVisible();

  const dashboardBox = await page.locator('.dashboard').boundingBox();
  const initialCanvasBox = await page.locator('.canvas').boundingBox();
  if (!dashboardBox || !initialCanvasBox) {
    throw new Error('Dashboard and graph canvas must have measurable initial positions.');
  }
  expect(Math.round(initialCanvasBox.width)).toBe(Math.round(dashboardBox.width));
  expect(Math.round(initialCanvasBox.height)).toBe(Math.round(dashboardBox.height));

  await page.getByRole('button', { name: 'Expand Activity Console' }).click();
  await expect(page.locator('.activity-console')).toBeVisible();
  const consoleCanvasBox = await page.locator('.canvas').boundingBox();
  if (!consoleCanvasBox) {
    throw new Error('Graph canvas must remain measurable with Activity Console open.');
  }
  expect(consoleCanvasBox.height).toBeLessThan(initialCanvasBox.height);
  await page.getByRole('button', { name: 'Collapse Activity Console' }).click();
  await expect(page.locator('.activity-console')).toHaveCount(0);

  await page.getByRole('button', { name: 'Expand side panel' }).click();
  await expect(page.locator('.side-panel')).toBeVisible();
  const sideCanvasBox = await page.locator('.canvas').boundingBox();
  if (!sideCanvasBox) {
    throw new Error('Graph canvas must remain measurable with side panel open.');
  }
  expect(sideCanvasBox.width).toBeLessThan(initialCanvasBox.width);
  await page.getByRole('button', { name: 'Collapse side panel' }).click();
  await expect(page.locator('.side-panel')).toHaveCount(0);

  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator('.react-flow__edge').count()).toBeGreaterThan(0);
  const startMeta = page.locator('.react-flow__node[data-id="__start__"]').first();
  const finishMeta = page.locator('.react-flow__node[data-id="__finish__"]').first();
  await expect(startMeta).toBeVisible();
  await expect(startMeta).toContainText('START');
  await expect(finishMeta).toBeVisible();
  await expect(finishMeta).toContainText('FINISH');

  const setup = page.locator('.flow-node', { hasText: 'Stateful Invariant Setup' }).first();
  const handlers = page.locator('.flow-node', { hasText: 'Stateful Invariant Handlers' }).first();
  const coverage = page.locator('.flow-node', { hasText: 'Stateful Invariant Coverage' }).first();
  const implementProperties = page.locator('.flow-node', { hasText: 'Implement properties' }).first();
  const reconCampaign = page.locator('.flow-node', { hasText: 'Invariant testing campaign' }).first();
  const setupFoundry = page.locator('.flow-node', { hasText: 'Setup Foundry' }).first();
  const projectDiscovery = page.locator('.flow-node', { hasText: 'Project discovery' }).first();
  const propertyLens = page.locator('.flow-node', { hasText: 'Property Specification (0kn0t)' }).first();
  const propertyFanIn = page.locator('.flow-node', { hasText: 'Properties deduplication' }).first();
  const dedupeReview = page.locator('.flow-node', { hasText: 'Dedupe findings' }).first();
  const propertiesGroup = page.locator('.phase-group--properties').first();
  await expect(setup).toBeVisible();
  await expect(handlers).toBeVisible();
  await expect(coverage).toBeVisible();
  await expect(implementProperties).toBeVisible();
  await expect(reconCampaign).toBeVisible();
  await expect(setupFoundry).toBeVisible();
  await expect(projectDiscovery).toBeVisible();
  await expect(propertyLens).toBeVisible();
  await expect(propertyFanIn).toBeVisible();
  await expect(dedupeReview).toBeVisible();
  await expect(propertiesGroup.locator('.phase-group__header')).toContainText('9 tasks · 0 properties');
  await expectGraphCardHierarchy(setupFoundry, 'Setup Foundry', 'setup-foundry');
  await expectGraphCardHierarchy(projectDiscovery, 'Project discovery', 'project-discovery');
  await expectGraphCardHierarchy(propertyLens, 'Property Specification (0kn0t)', 'property-specification-0kn0t');
  await expect(propertyLens.locator('.node-facts')).toContainText('0 candidates');
  await expect(propertyFanIn.locator('.node-facts')).toContainText('0 properties');
  await expectGraphCardHierarchy(dedupeReview, 'Dedupe findings', 'dedupe-findings');
  await expect(page.locator('.flow-node__rail')).toHaveCount(0);

  const [setupBox, handlersBox, coverageBox, implementPropertiesBox, reconCampaignBox, setupBodyBox] =
    await Promise.all([
      setup.boundingBox(),
      handlers.boundingBox(),
      coverage.boundingBox(),
      implementProperties.boundingBox(),
      reconCampaign.boundingBox(),
      setup.locator('.flow-node__body').boundingBox()
    ]);
  if (!setupBox || !handlersBox || !coverageBox || !implementPropertiesBox || !reconCampaignBox || !setupBodyBox) {
    throw new Error('Invariant strategy cards must have measurable positions.');
  }
  expect(setupBox.x).toBeLessThan(handlersBox.x);
  expect(handlersBox.x).toBeLessThan(coverageBox.x);
  expect(coverageBox.x).toBeLessThan(implementPropertiesBox.x);
  expect(implementPropertiesBox.x).toBeLessThan(reconCampaignBox.x);
  expect(Math.round(setupBodyBox.x - setupBox.x)).toBeLessThanOrEqual(2);

  const cardText = (
    await page.locator('.flow-node .node-title, .flow-node .node-strategy, .flow-node .node-facts').allTextContents()
  )
    .join(' ')
    .toLowerCase();
  for (const token of internalCardTokens) {
    expect(cardText).not.toContain(token);
  }
});

test('property specification lanes keep company-first order', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  const propertyLabels = [
    'Property Specification (Certora)',
    'Property Specification (Crytic)',
    'Property Specification (Runtime Verification)',
    'Property Specification (a16z)',
    'Property Specification (Recon)',
    'Property Specification (Antonio Viggiano)',
    'Property Specification (0kn0t)',
    'Property Specification (Josselin Feist)'
  ];
  const positions = [];

  for (const label of propertyLabels) {
    const node = page.locator('.flow-node').filter({ hasText: label }).first();
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    if (!box) {
      throw new Error(`Property node ${label} must have a visible bounding box.`);
    }
    positions.push({ label, y: box.y });
  }

  expect([...positions].sort((left, right) => left.y - right.y).map((position) => position.label)).toEqual(
    propertyLabels
  );
});

test('advanced appearance theme dropdown supports system, light, and dark modes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/dashboard');

  const root = page.locator('html');
  await expect(root).toHaveClass(/dark/);
  await expect.poll(async () => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  await page.locator('.toolbar .advanced-actions__summary').click();
  const themeSelect = page.getByLabel('Theme');
  await expect(themeSelect).toBeVisible();
  await expect(themeSelect).toHaveValue('system');

  await expect.poll(rootThemeTokens(page)).toEqual({
    bg: '#000000',
    canvas: '#0f0f12',
    surface: '#16161a'
  });

  await page.getByRole('button', { name: 'Expand side panel' }).click();
  await page.getByRole('button', { name: 'Expand Activity Console' }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.canvas')).toBeVisible();
  await expect(page.locator('.side-panel')).toBeVisible();
  await expect(page.locator('.activity-console')).toBeVisible();

  await themeSelect.selectOption('light');
  await expect(root).not.toHaveClass(/dark/);
  await expect.poll(async () => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('mds-theme'))).toBe('light');

  await themeSelect.selectOption('dark');
  await expect(root).toHaveClass(/dark/);
  await expect.poll(async () => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('mds-theme'))).toBe('dark');

  await page.reload();
  await expect(root).toHaveClass(/dark/);
  await expect.poll(async () => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
  await page.locator('.toolbar .advanced-actions__summary').click();
  await expect(themeSelect).toHaveValue('dark');

  await themeSelect.selectOption('system');
  await expect(root).toHaveClass(/dark/);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('mds-theme'))).toBe('system');
});

test('collapsed panel controls remain usable on narrow viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto('/dashboard');

  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);
  await expect(page.locator('.side-panel')).toHaveCount(0);
  await expect(page.locator('.event-panel')).toHaveCount(0);
  await expect.poll(async () => visibleToolbarControlLabels(page)).toEqual(['Run', 'Restart', 'Advanced']);
  await expect(page.getByRole('button', { name: 'Expand side panel' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand Activity Console' })).toBeHidden();
  await page.locator('.toolbar .advanced-actions__summary').click();
  await expect(page.getByRole('button', { name: 'Expand side panel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Activity Console' })).toBeVisible();

  await page.getByRole('button', { name: 'Expand side panel' }).click();
  await page.getByRole('button', { name: 'Expand Activity Console' }).click();
  await expect(page.locator('.side-panel')).toBeVisible();
  await expect(page.locator('.activity-console')).toBeVisible();

  const sideBox = await page.locator('.side-panel').boundingBox();
  const eventBox = await page.locator('.event-panel').boundingBox();
  if (!sideBox || !eventBox) {
    throw new Error('Narrow viewport panels must have measurable positions.');
  }
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(sideBox.y + sideBox.height).toBeLessThanOrEqual(eventBox.y + 1);
  expect(eventBox.y + eventBox.height).toBeLessThanOrEqual(viewportHeight);
});

test('prompt editor keeps usable height in narrow side-panel layout', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  await page.locator('.flow-node', { hasText: 'Project discovery' }).first().click();
  const promptEditor = page.getByLabel('Editable Markdown');
  await expect(promptEditor).toBeVisible();

  const layout = await promptEditorLayout(page);
  expect(layout.editorHeight).toBeGreaterThanOrEqual(360);
  expect(layout.editorOverlapsMeta).toBe(false);
});

test('phase grouping smoke assertions run when grouping controls exist', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);
  await page.locator('.toolbar .advanced-actions__summary').click();

  const groupedButton = page.getByRole('button', { name: /^grouped$/i });
  const flatButton = page.getByRole('button', { name: /^flat$/i });
  if ((await groupedButton.count()) === 0 || (await flatButton.count()) === 0) {
    test.skip(true, 'Phase grouping controls are not present; only phase-specific smoke assertions are skipped.');
  }

  const phaseGroups = page.locator('[data-phase-group], .phase-group, .react-flow__node-phaseGroup');
  await expect(groupedButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => phaseGroups.count()).toBeGreaterThan(0);

  await flatButton.click();
  await expect(flatButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => phaseGroups.count()).toBe(0);

  await groupedButton.click();
  await expect(groupedButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => phaseGroups.count()).toBeGreaterThan(0);
});

test('grouped fan-in and fanout edges keep branch rank order', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator('.react-flow__edge').count()).toBeGreaterThan(0);

  const propertyFanout = [
    'property-specification-fanin->boundary-tests-0',
    'property-specification-fanin->encode-decode-0',
    'property-specification-fanin->differential-library-tests-0',
    'property-specification-fanin->round-trip-0',
    'property-specification-fanin->workflow-property-based-tests-0',
    'property-specification-fanin->time-warp-sequences-0',
    'property-specification-fanin->expand-coverage-0',
    'property-specification-fanin->admin-config-boundaries-0',
    'property-specification-fanin->external-dependency-boundaries-0',
    'property-specification-fanin->amm-boundary-liquidity-0',
    'property-specification-fanin->payable-fallback-accounting-0',
    'property-specification-fanin->externalized-state-accounting-0',
    'property-specification-fanin->packed-action-parity-0',
    'property-specification-fanin->batch-atomicity-unsupported-actions-0',
    'property-specification-fanin->router-exact-accounting-0',
    'property-specification-fanin->rounding-direction-audit-0',
    'property-specification-fanin->market-exhaustion-boundaries-0',
    'property-specification-fanin->order-replacement-collateral-0',
    'property-specification-fanin->state-machine-boundaries-0',
    'property-specification-fanin->lifecycle-view-boundaries-0',
    'property-specification-fanin->stateful-invariant-setup',
    'property-specification-fanin->differential-oracle-planner'
  ];
  const dedupeFanin = [
    'boundary-tests-0->dedupe-findings',
    'differential-library-tests-0->dedupe-findings',
    'round-trip-0->dedupe-findings',
    'workflow-property-based-tests-0->dedupe-findings',
    'time-warp-sequences-0->dedupe-findings',
    'expand-coverage-0->dedupe-findings',
    'amm-boundary-liquidity-0->dedupe-findings',
    'encode-decode-0->dedupe-findings',
    'payable-fallback-accounting-0->dedupe-findings',
    'externalized-state-accounting-0->dedupe-findings',
    'packed-action-parity-0->dedupe-findings',
    'dynamic-strategy-generator->dedupe-findings',
    'batch-atomicity-unsupported-actions-0->dedupe-findings',
    'router-exact-accounting-0->dedupe-findings',
    'market-exhaustion-boundaries-0->dedupe-findings',
    'order-replacement-collateral-0->dedupe-findings',
    'state-machine-boundaries-0->dedupe-findings',
    'lifecycle-view-boundaries-0->dedupe-findings',
    'stateful-invariant-coverage-0->dedupe-findings',
    'stateful-invariant-implement-properties->dedupe-findings',
    'stateful-invariant-recon-campaign->dedupe-findings',
    'differential-repair-and-report-review->dedupe-findings'
  ];
  const rankedPropertyFanout = await sortEdgesByNodePosition(page, propertyFanout, 'target');
  const rankedDedupeFanin = await sortEdgesByNodePosition(page, dedupeFanin, 'source');
  const fanoutSourceYs = await Promise.all(rankedPropertyFanout.map((edgeId) => edgePathY(page, edgeId, 'source')));
  const faninTargetYs = await Promise.all(rankedDedupeFanin.map((edgeId) => edgePathY(page, edgeId, 'target')));

  expect(fanoutSourceYs).toEqual([...fanoutSourceYs].sort((left, right) => left - right));
  expect(faninTargetYs).toEqual([...faninTargetYs].sort((left, right) => left - right));
  expect(faninTargetYs.at(-1)).toBeGreaterThan(Math.max(...faninTargetYs.slice(0, -1)));
});

test('dependency edges render beneath task cards', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator('.react-flow__edge').count()).toBeGreaterThan(0);

  await expect.poll(async () => edgeCardOverlaySamples(page)).toEqual([]);
});

test('selected node identity appears only in editable Markdown', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  await page.locator('.flow-node', { hasText: 'Project discovery' }).first().click();
  await expect(page.getByRole('tablist', { name: 'Node detail sections' })).toHaveCount(0);
  await expect(page.getByLabel('Editable Markdown')).toBeVisible();
  await expect(page.locator('.side-panel .panel-header')).not.toContainText('project-discovery');
  await expect(page.locator('.side-panel')).not.toContainText('Logical node');
  await expect(page.locator('.side-panel')).not.toContainText('Prompt path');
  const promptEditorSection = page.locator('.prompt-editor-section');
  const promptSaveStatus = promptEditorSection.locator('.prompt-save-status');
  const promptTemplateWarning = promptEditorSection.locator('.prompt-template-warning');
  const promptEditor = page.getByLabel('Editable Markdown');

  await expect(promptEditorSection).toBeVisible();
  await expect(promptEditorSection.locator('.split-view')).toHaveCount(0);
  await expect(promptEditorSection.locator('.markdown-preview')).toHaveCount(0);
  await expect(promptEditorSection.locator('.diff-view')).toHaveCount(0);
  await expect(promptSaveStatus).toHaveText('Saved');
  await expect(promptTemplateWarning).toHaveCount(0);

  const sidePanelBox = await page.locator('.side-panel').boundingBox();
  if (!sidePanelBox) {
    throw new Error('Side panel must have a measurable size.');
  }
  expect(sidePanelBox.width).toBeGreaterThanOrEqual(360);
  expect(sidePanelBox.width).toBeLessThanOrEqual(430);

  const validLayout = await promptEditorLayout(page);
  expect(validLayout.warningCount).toBe(0);
  expect(validLayout.editorHeight).toBeGreaterThan(360);
  expect(validLayout.editorHeight).toBeGreaterThanOrEqual(validLayout.expectedEditorHeight - 2);
  expect(validLayout.editorHeight).toBeLessThanOrEqual(validLayout.expectedEditorHeight + 2);
  expect(validLayout.sectionBottomGap).toBeLessThanOrEqual(2);
  expect(validLayout.editorMetaGap).toBeGreaterThanOrEqual(0);
  expect(validLayout.editorMetaGap).toBeLessThanOrEqual(validLayout.sectionGap + 2);
  expect(validLayout.topologyBottom).toBeLessThan(validLayout.surfaceTop);
  if (validLayout.evidenceTop !== null) {
    expect(validLayout.surfaceBottom).toBeLessThanOrEqual(validLayout.evidenceTop);
  }

  const nonEditorText = await page
    .locator(
      '.side-panel .panel-header, .side-panel .topology-controls, .side-panel .markdown-preview, .side-panel .diff-view, .side-panel .prompt-editor-meta'
    )
    .allTextContents();
  expect(nonEditorText.join(' ')).not.toContain('project-discovery');
  await expect(promptEditor).toHaveValue(/id: project-discovery/);

  const originalPrompt = await promptEditor.inputValue();
  await promptEditor.fill(`${originalPrompt}\n\nSmoke validation edit.`);
  await expect(promptSaveStatus).toHaveText('Pending');

  await promptEditor.fill(`${originalPrompt}\n\n{{codex_unknown_smoke_variable}}`);
  await expect(promptSaveStatus).toHaveText('Invalid');
  await expect(promptTemplateWarning).toHaveCount(1);
  await expect(promptTemplateWarning).toBeVisible();
  await expect(promptTemplateWarning).toContainText('Unknown template variable {{codex_unknown_smoke_variable}}.');

  const invalidLayout = await promptEditorLayout(page);
  expect(invalidLayout.warningCount).toBe(1);
  expect(invalidLayout.warningHeight).toBeGreaterThan(0);
  expect(invalidLayout.editorHeight).toBeLessThan(validLayout.editorHeight);
  expect(invalidLayout.sectionBottomGap).toBeLessThanOrEqual(2);
  expect(invalidLayout.editorOverlapsMeta).toBe(false);

  const unknownVariables = Array.from({ length: 12 }, (_, index) => `{{codex_unknown_smoke_variable_${index}}}`).join(
    '\n'
  );
  await promptEditor.fill(`${originalPrompt}\n\n${unknownVariables}`);
  await expect(promptTemplateWarning).toBeVisible();
  const cappedWarningLayout = await promptEditorLayout(page);
  expect(cappedWarningLayout.warningHeight).toBeLessThanOrEqual(68);
  expect(cappedWarningLayout.editorHeight).toBeGreaterThan(300);
  expect(cappedWarningLayout.editorHeight).toBeGreaterThanOrEqual(cappedWarningLayout.expectedEditorHeight - 2);
  expect(cappedWarningLayout.editorHeight).toBeLessThanOrEqual(cappedWarningLayout.expectedEditorHeight + 2);
  expect(cappedWarningLayout.editorOverlapsMeta).toBe(false);
});

test('selected node header hides duplicate subtitles and keeps distinct metadata', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  const header = page.locator('aside.side-panel > div.panel-content > header.panel-header');

  await page.locator('.flow-node', { hasText: 'Project discovery' }).first().click();
  await expect(header.locator('h2')).toHaveText('Project discovery');
  await expect(header.locator('p')).toHaveText('Project setup');

  await page.locator('.flow-node', { hasText: 'Setup Foundry' }).first().click();
  await expect(header.locator('h2')).toHaveText('Setup Foundry');
  await expect(header.locator('p')).toHaveCount(0);
});

test('editable topology nodes expose plus handles and connect through highlighted targets', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  await expect(page.getByRole('button', { name: /^Connect$/ })).toHaveCount(0);
  await expect.poll(async () => page.locator('.flow-connect-handle-source').count()).toBeGreaterThan(0);
  await expect(page.locator('.flow-connect-handle-source').first()).toHaveAttribute(
    'aria-label',
    /^Create dependency from /
  );

  await page.getByLabel(/fit view/i).click();
  await page.waitForTimeout(500);

  const pair = await firstTransitiveEditablePair(page);
  const sourceNode = page.locator(`.react-flow__node[data-id="${pair.sourceId}"]`);
  const invalidTargetNode = page.locator(`.react-flow__node[data-id="${pair.invalidTargetId}"]`);
  const sourceHandle = sourceNode.locator('.flow-connect-handle-source');

  await expect(sourceHandle).toBeVisible();

  const dependencyCountBefore = await topologyDependencyCount(page);
  const sourceBox = await sourceHandle.boundingBox();
  if (!sourceBox) {
    throw new Error('Connection source handle must have a measurable position.');
  }

  await sourceNode.locator('.flow-node, .meta-node').click();
  await page.getByRole('button', { name: /^Connect$/ }).click();
  await expect(sourceNode.locator('.flow-node, .meta-node')).toHaveClass(/is-connection-source/);
  await expect(invalidTargetNode.locator('.flow-node, .meta-node')).toHaveClass(/is-connection-invalid-target/);
  const targetNode = page
    .locator('.react-flow__node', {
      has: page.locator('.flow-node.is-connection-target, .meta-node.is-connection-target')
    })
    .first();
  await expect(targetNode.locator('.flow-node, .meta-node')).toHaveClass(/is-connection-target/);
  const targetId = await targetNode.getAttribute('data-id');
  if (!targetId) {
    throw new Error('Valid connection target must expose a React Flow node id.');
  }
  const targetLogicalId = await logicalNodeIdForRenderedNode(page, targetId);
  const targetHandle = targetNode.locator('.flow-connect-handle-target');
  const targetBox = await targetHandle.boundingBox();
  if (!targetBox) {
    throw new Error('Connection target handle must have a measurable position.');
  }
  await targetNode.locator('.flow-node, .meta-node').click();

  await expect.poll(async () => dependencyExists(page, pair.sourceLogicalId, targetLogicalId)).toBe(true);
  await expect.poll(async () => topologyDependencyCount(page)).toBeGreaterThan(dependencyCountBefore);
  await expect(page.locator('.system-alerts')).toContainText('Saved dependency edge');
});

test('selected dependency edge exposes editable endpoints and saves retargets', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator('.react-flow__edge').count()).toBeGreaterThan(0);

  await page.getByLabel(/fit view/i).click();
  await page.waitForTimeout(500);

  const edit = await firstEditableEdgeRetarget(page);
  await page.getByTestId(`rf__edge-${edit.edgeId}`).locator('.react-flow__edge-interaction').dispatchEvent('click');

  await expect(page.locator('.side-panel .panel-header h2')).toHaveText('Dependency edge');
  const startNode = page.getByLabel('Start node');
  const endNode = page.getByLabel('End node');
  await expect(startNode).toBeVisible();
  await expect(endNode).toBeVisible();
  await expect(startNode).toHaveValue(edit.oldSourceLogicalId);
  await expect(endNode).toHaveValue(edit.oldTargetLogicalId);

  const saveButton = page.getByRole('button', { name: /^save edge$/i });
  await expect(saveButton).toBeDisabled();

  await endNode.selectOption(edit.newTargetLogicalId);
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  await expect.poll(async () => dependencyExists(page, edit.oldSourceLogicalId, edit.newTargetLogicalId)).toBe(true);
  await expect.poll(async () => dependencyExists(page, edit.oldSourceLogicalId, edit.oldTargetLogicalId)).toBe(false);
  await expect(page.locator('.system-alerts')).toContainText('Saved dependency edge');
  await expect(page.locator('.side-panel .panel-header p')).toContainText(edit.newTargetLabel);

  await startNode.selectOption(edit.newTargetLogicalId);
  await expect(page.locator('.side-panel')).toContainText('Dependency edges cannot start and end at the same node.');
  await expect(saveButton).toBeDisabled();

  await page.getByRole('button', { name: /^delete edge$/i }).click();
  await expect.poll(async () => dependencyExists(page, edit.oldSourceLogicalId, edit.newTargetLogicalId)).toBe(false);
});

test('new prompt form creates nodes from topology dropdown selections', async ({ page }) => {
  await page.goto('/dashboard');
  await expect.poll(async () => page.locator('.flow-node').count()).toBeGreaterThan(0);

  await page.locator('.toolbar .advanced-actions__summary').click();
  await page.getByRole('button', { name: /^add prompt$/i }).click();
  const promptEditor = page.getByLabel('New prompt Markdown');
  await expect(promptEditor).toBeVisible();

  const groupField = page.getByLabel('Group');
  const dependencyField = page.getByLabel('Depends on');
  await expect.poll(async () => groupField.evaluate((element) => element.tagName.toLowerCase())).toBe('select');
  await expect.poll(async () => dependencyField.evaluate((element) => element.tagName.toLowerCase())).toBe('select');
  await expect
    .poll(async () => dependencyField.evaluate((element) => (element as HTMLSelectElement).multiple))
    .toBe(true);
  await expect(groupField.locator('option', { hasText: 'Ungrouped' })).toHaveCount(1);

  await groupField.selectOption({ label: 'Review' });
  await dependencyField.selectOption({ label: 'Project discovery' });
  await expect
    .poll(async () =>
      dependencyField.evaluate((element) =>
        Array.from((element as HTMLSelectElement).selectedOptions, (option) => option.value)
      )
    )
    .toEqual(['project-discovery']);

  await promptEditor.fill('---\nid: smoke-review-node\ndisplay_name: Smoke Review Node\n---\n\n# Smoke Review Node\n');
  await page
    .locator('aside.side-panel')
    .getByRole('button', { name: /^add prompt$/i })
    .click();
  await expect(page.getByText('Added prompt')).toBeVisible();
  await expect(page.getByLabel('Editable Markdown')).toHaveValue(/id: smoke-review-node/);

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch('/api/topology');
        const detail = (await response.json()) as SmokeTopology;
        const node = detail.topology.nodes.find((item) => item.id === 'smoke-review-node');
        return node ? { depends_on: node.depends_on ?? [], group: node.group ?? null } : null;
      })
    )
    .toEqual({ depends_on: ['project-discovery'], group: 'review' });
});

async function edgePathY(page: Page, edgeId: string, endpoint: 'source' | 'target') {
  const path = await page.getByTestId(`rf__edge-${edgeId}`).locator('path.react-flow__edge-path').getAttribute('d');
  const values = path?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!values || values.length < 2) {
    throw new Error(`Edge ${edgeId} did not expose a parseable path.`);
  }
  return endpoint === 'source' ? values[1] : values.at(-1)!;
}

async function sortEdgesByNodePosition(page: Page, edgeIds: string[], nodeEndpoint: 'source' | 'target') {
  const rankedEdges = await Promise.all(
    edgeIds.map(async (edgeId) => {
      const [source, target] = edgeId.split('->');
      if (!source || !target) {
        throw new Error(`Edge ${edgeId} must use the source->target test id form.`);
      }
      const nodeId = nodeEndpoint === 'source' ? source : target;
      const resolved = await edgeEndpointNodeBox(page, nodeId);
      return { ...resolved, edgeId };
    })
  );

  return rankedEdges
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.edgeId.localeCompare(right.edgeId)
    )
    .map((edge) => edge.edgeId);
}

async function edgeEndpointNodeBox(page: Page, nodeId: string) {
  const logicalNodeId = nodeId.replace(/-\d+$/, '');
  const candidates = logicalNodeId === nodeId ? [nodeId] : [nodeId, logicalNodeId];
  for (const candidate of candidates) {
    const locator = page.locator(`.react-flow__node[data-id="${candidate}"]`).first();
    if ((await locator.count()) === 0) {
      continue;
    }
    const box = await locator.boundingBox();
    if (box) {
      return { box, nodeId: candidate };
    }
  }
  throw new Error(`Node ${nodeId} did not expose a measurable position. Tried: ${candidates.join(', ')}.`);
}

async function edgeCardOverlaySamples(page: Page) {
  return page.evaluate(() => {
    const cardInset = 8;
    const cards = [...document.querySelectorAll<HTMLElement>('.flow-node, .meta-node')]
      .map((element) => ({
        label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? 'node',
        rect: element.getBoundingClientRect()
      }))
      .filter((card) => card.rect.width > cardInset * 2 && card.rect.height > cardInset * 2);
    const overlays: Array<{ edgeId: string; node: string; topElement: string; x: number; y: number }> = [];

    for (const edge of document.querySelectorAll<SVGGElement>('.react-flow__edge')) {
      const path = edge.querySelector<SVGPathElement>('path.react-flow__edge-path');
      const transform = path?.getScreenCTM();
      if (!path || !transform) {
        continue;
      }

      const edgeId = edge.getAttribute('data-testid')?.replace(/^rf__edge-/, '') ?? 'edge';
      const totalLength = path.getTotalLength();
      const sampleCount = Math.max(8, Math.ceil(totalLength / 12));
      for (let index = 1; index < sampleCount; index += 1) {
        const pathPoint = path.getPointAtLength((totalLength * index) / sampleCount);
        const point = new DOMPoint(pathPoint.x, pathPoint.y).matrixTransform(transform);
        for (const card of cards) {
          const insideCardInterior =
            point.x > card.rect.left + cardInset &&
            point.x < card.rect.right - cardInset &&
            point.y > card.rect.top + cardInset &&
            point.y < card.rect.bottom - cardInset;
          if (!insideCardInterior) {
            continue;
          }
          const topElement = document.elementFromPoint(point.x, point.y);
          if (topElement?.closest('.react-flow__edge')) {
            overlays.push({
              edgeId,
              node: card.label,
              topElement: topElement.className.toString(),
              x: Math.round(point.x),
              y: Math.round(point.y)
            });
            if (overlays.length >= 12) {
              return overlays;
            }
          }
        }
      }
    }

    return overlays;
  });
}

async function visibleToolbarControlLabels(page: Page): Promise<string[]> {
  return page
    .locator('.toolbar')
    .locator('button, summary')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
        .map((element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim())
        .filter(Boolean)
    );
}

function rootThemeTokens(page: Page) {
  return async () =>
    page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement);
      return {
        bg: style.getPropertyValue('--bg-default').trim().toLowerCase(),
        canvas: style.getPropertyValue('--bg-subtle').trim().toLowerCase(),
        surface: style.getPropertyValue('--bg-elevated').trim().toLowerCase()
      };
    });
}

async function expectGraphCardHierarchy(card: Locator, label: string, topologyId: string): Promise<void> {
  await expect(card.locator('.node-header .node-title')).toHaveText(label);
  await expect(card.locator('.node-header .status-badge')).toBeVisible();
  await expect(card.locator('.node-topology-id')).toHaveText(topologyId);
  await expect(card.locator('.node-topology-id')).toHaveAttribute('title', `Topology ID: ${topologyId}`);
  await expect(card.locator('.node-role')).toHaveCount(0);
  expect(
    await card.evaluate((element) => {
      const title = element.querySelector('.node-title');
      const topologyHandle = element.querySelector('.node-topology-id');
      if (!title || !topologyHandle) {
        return false;
      }
      return (title.compareDocumentPosition(topologyHandle) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })
  ).toBe(true);
}

async function promptEditorLayout(page: Page) {
  return page.evaluate(() => {
    const section = document.querySelector<HTMLElement>('.prompt-editor-section');
    const editor = document.querySelector<HTMLElement>('.markdown-editor--prompt');
    const meta = document.querySelector<HTMLElement>('.prompt-editor-meta');
    const surface = document.querySelector<HTMLElement>('.prompt-surface');
    const topology = document.querySelector<HTMLElement>('.topology-controls');
    const evidence = document.querySelector<HTMLElement>('.node-evidence');
    if (!section || !editor || !meta || !surface || !topology) {
      throw new Error('Prompt editor layout elements must be present.');
    }

    const sectionBox = section.getBoundingClientRect();
    const editorBox = editor.getBoundingClientRect();
    const metaBox = meta.getBoundingClientRect();
    const surfaceBox = surface.getBoundingClientRect();
    const topologyBox = topology.getBoundingClientRect();
    const evidenceBox = evidence?.getBoundingClientRect();
    const warning = section.querySelector<HTMLElement>('.prompt-template-warning');
    const warningBox = warning?.getBoundingClientRect();
    const sectionStyle = window.getComputedStyle(section);
    const sectionGap = Number.parseFloat(sectionStyle.rowGap || sectionStyle.gap || '0') || 0;
    const sectionVisibleChildGaps = sectionGap;

    return {
      editorHeight: editorBox.height,
      editorMetaGap: metaBox.top - editorBox.bottom,
      editorOverlapsMeta: editorBox.bottom > metaBox.top + 0.5,
      evidenceTop: evidenceBox ? evidenceBox.top : null,
      expectedEditorHeight: sectionBox.height - metaBox.height - sectionVisibleChildGaps,
      sectionBottomGap: sectionBox.bottom - metaBox.bottom,
      sectionGap,
      surfaceBottom: surfaceBox.bottom,
      surfaceTop: surfaceBox.top,
      topologyBottom: topologyBox.bottom,
      warningCount: warning ? 1 : 0,
      warningHeight: warningBox?.height ?? 0
    };
  });
}

type SmokeFlowNode = {
  id: string;
  data: {
    dependencies: string[];
    label: string;
    logicalNodeId: string;
    promptEditable: boolean;
  };
};

type SmokeFlow = {
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
  nodes: SmokeFlowNode[];
};

type SmokeTopology = {
  topology: {
    nodes: Array<{
      depends_on?: string[];
      group?: string;
      id: string;
    }>;
  };
};

async function firstTransitiveEditablePair(page: Page) {
  const nodes = await hitTestableEditableNodes(page);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const nodesByLogicalId = new Map(nodes.map((node) => [node.data.logicalNodeId ?? node.id, node]));
  const dependsOn = (source: SmokeFlowNode, targetIds: Set<string>) => {
    const visited = new Set<string>();
    const pending = [...source.data.dependencies];
    while (pending.length) {
      const dependency = pending.pop()!;
      if (targetIds.has(dependency)) {
        return true;
      }
      if (visited.has(dependency)) {
        continue;
      }
      visited.add(dependency);
      const dependencyNode = nodesById.get(dependency) ?? nodesByLogicalId.get(dependency);
      if (dependencyNode) {
        pending.push(...dependencyNode.data.dependencies);
      }
    }
    return false;
  };

  for (const source of nodes) {
    const invalidTarget = nodes.find((target) => {
      if (source.id === target.id) {
        return false;
      }
      return dependsOn(source, new Set([target.id, target.data.logicalNodeId ?? target.id]));
    });
    if (!invalidTarget) {
      continue;
    }
    return {
      invalidTargetId: invalidTarget.id,
      sourceId: source.id,
      sourceLogicalId: source.data.logicalNodeId ?? source.id
    };
  }
  throw new Error('No editable transitive topology connection pair found.');
}

async function hitTestableEditableNodes(page: Page): Promise<SmokeFlowNode[]> {
  return page.evaluate(async () => {
    const response = await fetch('/api/flow');
    const flow = (await response.json()) as SmokeFlow;
    const domIds = new Set(
      [...document.querySelectorAll('.react-flow__node')].map((node) => node.getAttribute('data-id'))
    );
    const handleIsHitTarget = (selector: string) => {
      const handle = document.querySelector(selector);
      const box = handle?.getBoundingClientRect();
      if (!handle || !box || box.width === 0 || box.height === 0) {
        return false;
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === handle || handle.contains(hit);
    };
    return flow.nodes.filter(
      (node) =>
        node.data.promptEditable &&
        domIds.has(node.id) &&
        handleIsHitTarget(`.react-flow__node[data-id="${node.id}"] .flow-connect-handle-source`) &&
        handleIsHitTarget(`.react-flow__node[data-id="${node.id}"] .flow-connect-handle-target`)
    );
  });
}

async function dependencyExists(page: Page, sourceLogicalId: string, targetLogicalId: string): Promise<boolean> {
  return page.evaluate(
    async ({ sourceLogicalId, targetLogicalId }) => {
      const response = await fetch('/api/topology');
      const detail = (await response.json()) as SmokeTopology;
      const target = detail.topology.nodes.find((node) => node.id === targetLogicalId);
      return Boolean(target?.depends_on?.includes(sourceLogicalId));
    },
    { sourceLogicalId, targetLogicalId }
  );
}

async function topologyDependencyCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch('/api/topology');
    const detail = (await response.json()) as SmokeTopology;
    return detail.topology.nodes.reduce((total, node) => total + (node.depends_on?.length ?? 0), 0);
  });
}

async function logicalNodeIdForRenderedNode(page: Page, nodeId: string): Promise<string> {
  return page.evaluate(async (nodeId) => {
    const response = await fetch('/api/flow');
    const flow = (await response.json()) as SmokeFlow;
    return flow.nodes.find((node) => node.id === nodeId)?.data.logicalNodeId ?? nodeId;
  }, nodeId);
}

async function firstEditableEdgeRetarget(page: Page) {
  return page.evaluate(async () => {
    const [flowResponse, topologyResponse] = await Promise.all([fetch('/api/flow'), fetch('/api/topology')]);
    const flow = (await flowResponse.json()) as SmokeFlow;
    const topology = (await topologyResponse.json()) as SmokeTopology;
    const domIds = new Set(
      [...document.querySelectorAll('.react-flow__node')].map((node) => node.getAttribute('data-id'))
    );
    const visibleEdgeIds = new Set(
      [...document.querySelectorAll('.react-flow__edge')]
        .map((edge) => edge.getAttribute('data-testid'))
        .filter((testId): testId is string => Boolean(testId))
        .map((testId) => testId.replace(/^rf__edge-/, ''))
    );
    const editableNodes = flow.nodes.filter((node) => node.data.promptEditable && domIds.has(node.id));
    const nodesById = new Map(editableNodes.map((node) => [node.id, node]));
    const nodesByLogicalId = new Map(editableNodes.map((node) => [node.data.logicalNodeId ?? node.id, node]));
    const topologyNodesById = new Map(topology.topology.nodes.map((node) => [node.id, node]));
    const promptReferenceCache = new Map<string, Promise<{ targets: Set<string>; usesAncestorArtifacts: boolean }>>();
    const dependencyExistsInTopology = (sourceLogicalId: string, targetLogicalId: string) =>
      Boolean(
        topology.topology.nodes.find((node) => node.id === targetLogicalId)?.depends_on?.includes(sourceLogicalId)
      );
    const promptArtifactReferences = (logicalNodeId: string) => {
      const cached = promptReferenceCache.get(logicalNodeId);
      if (cached) {
        return cached;
      }
      const pending = (async () => {
        const response = await fetch(`/api/prompts/nodes/${encodeURIComponent(logicalNodeId)}`);
        if (!response.ok) {
          return { targets: new Set<string>(), usesAncestorArtifacts: false };
        }
        const detail = (await response.json()) as { content: string };
        const targets = new Set<string>();
        const targetedReferencePattern = /{{\s*(?:artifact_path|artifact_handoff|ancestor_artifacts):([^}]+)}}/g;
        for (const match of detail.content.matchAll(targetedReferencePattern)) {
          match[1]
            .split(',')
            .map((target) => target.trim())
            .filter(Boolean)
            .forEach((target) => targets.add(target));
        }
        return {
          targets,
          usesAncestorArtifacts: /{{\s*ancestor_artifacts\s*}}/.test(detail.content)
        };
      })();
      promptReferenceCache.set(logicalNodeId, pending);
      return pending;
    };
    const dependsOn = (source: SmokeFlowNode, targetLogicalId: string) => {
      const visited = new Set<string>();
      const pending = [...source.data.dependencies];
      while (pending.length) {
        const dependency = pending.pop()!;
        if (dependency === targetLogicalId) {
          return true;
        }
        if (visited.has(dependency)) {
          continue;
        }
        visited.add(dependency);
        const dependencyNode = nodesById.get(dependency) ?? nodesByLogicalId.get(dependency);
        if (dependencyNode) {
          pending.push(...dependencyNode.data.dependencies);
        }
      }
      return false;
    };
    const dependenciesAfterEdit = (
      nodeLogicalId: string,
      oldSourceLogicalId: string,
      oldTargetLogicalId: string,
      candidateLogicalId: string,
      includeCandidateEdge: boolean
    ) => {
      const node = topologyNodesById.get(nodeLogicalId);
      const dependencies = [...(node?.depends_on ?? [])].filter(
        (dependency) => !(nodeLogicalId === oldTargetLogicalId && dependency === oldSourceLogicalId)
      );
      if (includeCandidateEdge && nodeLogicalId === candidateLogicalId && !dependencies.includes(oldSourceLogicalId)) {
        dependencies.push(oldSourceLogicalId);
      }
      return dependencies;
    };
    const dependencyOrAncestorAfterEdit = (
      nodeLogicalId: string,
      targetLogicalId: string,
      oldSourceLogicalId: string,
      oldTargetLogicalId: string,
      candidateLogicalId: string,
      includeCandidateEdge: boolean
    ) => {
      const visited = new Set<string>();
      const pending = dependenciesAfterEdit(
        nodeLogicalId,
        oldSourceLogicalId,
        oldTargetLogicalId,
        candidateLogicalId,
        includeCandidateEdge
      );
      while (pending.length) {
        const dependency = pending.pop()!;
        if (dependency === targetLogicalId) {
          return true;
        }
        if (visited.has(dependency)) {
          continue;
        }
        visited.add(dependency);
        pending.push(
          ...dependenciesAfterEdit(
            dependency,
            oldSourceLogicalId,
            oldTargetLogicalId,
            candidateLogicalId,
            includeCandidateEdge
          )
        );
      }
      return false;
    };
    const promptReferencesStayValid = async (
      oldSourceLogicalId: string,
      oldTargetLogicalId: string,
      candidateLogicalId: string,
      includeCandidateEdge: boolean
    ) => {
      for (const node of topology.topology.nodes) {
        const references = await promptArtifactReferences(node.id);
        const directDependencies = dependenciesAfterEdit(
          node.id,
          oldSourceLogicalId,
          oldTargetLogicalId,
          candidateLogicalId,
          includeCandidateEdge
        );
        if (references.usesAncestorArtifacts && directDependencies.length === 0) {
          return false;
        }
        for (const target of references.targets) {
          if (
            !dependencyOrAncestorAfterEdit(
              node.id,
              target,
              oldSourceLogicalId,
              oldTargetLogicalId,
              candidateLogicalId,
              includeCandidateEdge
            )
          ) {
            return false;
          }
        }
      }
      return true;
    };

    for (const edge of flow.edges) {
      if (!visibleEdgeIds.has(edge.id)) {
        continue;
      }
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (!source || !target) {
        continue;
      }
      const oldSourceLogicalId = source.data.logicalNodeId ?? source.id;
      const oldTargetLogicalId = target.data.logicalNodeId ?? target.id;
      for (const candidate of editableNodes) {
        const candidateLogicalId = candidate.data.logicalNodeId ?? candidate.id;
        if (
          candidate.id !== source.id &&
          candidate.id !== target.id &&
          !dependencyExistsInTopology(oldSourceLogicalId, candidateLogicalId) &&
          !dependsOn(source, candidateLogicalId) &&
          (await promptReferencesStayValid(oldSourceLogicalId, oldTargetLogicalId, candidateLogicalId, true)) &&
          (await promptReferencesStayValid(oldSourceLogicalId, oldTargetLogicalId, candidateLogicalId, false))
        ) {
          return {
            edgeId: edge.id,
            newTargetLabel: candidate.data.label,
            newTargetLogicalId: candidateLogicalId,
            oldSourceLogicalId,
            oldTargetLogicalId
          };
        }
      }
    }
    throw new Error('No editable dependency edge with a valid alternate target was found.');
  });
}
