import { describe, expect, it } from 'vitest';
import {
  hasInternalDashboardToken,
  loopBadgeLabel,
  nodeCardEyebrow,
  nodePanelSubtitle,
  phaseGroupDetailLabel,
  propertySummaryFactLabel,
  strategyCategoryLabel,
  visibleNodeCardText
} from '../../src/display';

describe('node card display helpers', () => {
  it('uses human-readable labels for infrastructure nodes', () => {
    expect(nodeCardEyebrow({ label: 'Project discovery', kind: 'project-discovery' })).toBe('Project setup');
    expect(nodeCardEyebrow({ label: 'Discover base test', kind: 'discover-base-test' })).toBe('Base test discovery');
    expect(nodeCardEyebrow({ label: 'Property specification fan-in', kind: 'property-specification-fanin' })).toBe(
      'Property specification'
    );
  });

  it('omits card eyebrows that duplicate the display name', () => {
    expect(nodeCardEyebrow({ label: 'Setup Foundry', kind: 'setup-foundry' })).toBeNull();
    expect(nodeCardEyebrow({ label: 'setup foundry', kind: 'setup-foundry' })).toBeNull();
    expect(visibleNodeCardText({ label: 'Setup Foundry', kind: 'setup-foundry' })).toBe('Setup Foundry');
  });

  it('keeps card eyebrows that add distinct role metadata', () => {
    expect(
      nodeCardEyebrow({
        label: 'Stateful Invariant Setup',
        kind: 'strategy',
        strategy: {
          display_name: 'Stateful Invariant Setup',
          category: 'stateful-invariant'
        }
      })
    ).toBe('Strategy');
    expect(nodeCardEyebrow({ label: '0kN0t', kind: 'property-specification lens 0kn0t-lens' })).toBe('Property lens');
    expect(nodeCardEyebrow({ label: 'Property Specification (0kn0t)', kind: 'property-specification-0kn0t' })).toBe(
      'Property lens'
    );
    expect(
      nodeCardEyebrow({
        label: 'Property Specification (Josselin Feist)',
        kind: 'property-specification-josselin-feist'
      })
    ).toBe('Property lens');
    expect(nodeCardEyebrow({ label: 'Severity classification', kind: 'severity-classification' })).toBe(
      'Finding review'
    );
  });

  it('keeps strategy cards free of internal ids and slugs', () => {
    const cardText = visibleNodeCardText({
      label: 'Stateful Invariant Setup',
      kind: 'strategy',
      strategy: {
        display_name: 'Stateful Invariant Setup',
        category: 'stateful-invariant'
      }
    });

    expect(cardText).toBe('Strategy Stateful Invariant Setup Stateful Invariant');
    expect(hasInternalDashboardToken(cardText)).toBe(false);
  });

  it('recognizes the Josselin prompt file slug as internal dashboard text', () => {
    expect(hasInternalDashboardToken('properties/josselin-feist-lens.md')).toBe(true);
  });

  it('omits side-panel subtitles that duplicate the display name', () => {
    expect(nodePanelSubtitle({ label: 'Setup Foundry', kind: 'setup-foundry' })).toBeNull();
    expect(nodePanelSubtitle({ label: 'setup foundry', kind: 'setup-foundry' })).toBeNull();
  });

  it('keeps side-panel subtitles that add distinct metadata', () => {
    expect(nodePanelSubtitle({ label: 'Project discovery', kind: 'project-discovery' })).toBe('Project setup');
    expect(
      nodePanelSubtitle({
        label: 'Stateful Invariant Setup',
        kind: 'strategy',
        strategy: {
          display_name: 'Stateful Invariant Setup',
          category: 'stateful-invariant'
        }
      })
    ).toBe('Strategy');
  });

  it('normalizes category labels without exposing slugs', () => {
    expect(strategyCategoryLabel('encode-decode')).toBe('Encode Decode');
    expect(strategyCategoryLabel('property_based')).toBe('Property Based');
  });

  it('formats property summary facts for graph cards', () => {
    expect(propertySummaryFactLabel({ count: 10, kind: 'candidates' })).toBe('10 candidates');
    expect(propertySummaryFactLabel({ count: 1, kind: 'candidates' })).toBe('1 candidate');
    expect(propertySummaryFactLabel({ count: 13, kind: 'properties' })).toBe('13 properties');
    expect(propertySummaryFactLabel({ count: 1, kind: 'properties' })).toBe('1 property');
    expect(propertySummaryFactLabel(null)).toBeNull();
  });

  it('shows loop badges from effective graph and strategy counts', () => {
    expect(loopBadgeLabel({ loopBadgeCount: 5, loopCount: 1, strategy: { loops: 3 } })).toBe('5x loop');
    expect(loopBadgeLabel({ loopCount: 3 })).toBe('3x loop');
    expect(loopBadgeLabel({ strategy: { loops: 4 } })).toBe('4x loop');
    expect(loopBadgeLabel({ loopBadgeCount: 1, loopCount: 1 })).toBeNull();
    expect(loopBadgeLabel({})).toBeNull();
  });

  it('adds finalized property counts to Properties phase metadata', () => {
    expect(phaseGroupDetailLabel(4, 13)).toBe('4 tasks · 13 properties');
    expect(phaseGroupDetailLabel(1, 0)).toBe('1 task · 0 properties');
    expect(phaseGroupDetailLabel(2)).toBe('2 tasks');
  });
});
