import { describe, expect, it } from 'vitest';
import { validatePromptTemplateVariables } from '../../src/templateValidation';

const allowedVariables = ['repo_path', 'artifact_path', 'output_findings_path'];

describe('validatePromptTemplateVariables', () => {
  it('accepts supported variables with whitespace', () => {
    const validation = validatePromptTemplateVariables('Write to {{ artifact_path }}/discovery.json', allowedVariables);

    expect(validation.valid).toBe(true);
    expect(validation.message).toBe('');
  });

  it('reports unknown variables', () => {
    const validation = validatePromptTemplateVariables('Write to {{artifacts_path}}/discovery.json', allowedVariables);

    expect(validation.valid).toBe(false);
    expect(validation.unknownVariables).toEqual(['artifacts_path']);
    expect(validation.message).toContain('{{artifacts_path}}');
    expect(validation.message).toContain('{{artifact_path}}');
  });

  it('reports malformed variables', () => {
    expect(validatePromptTemplateVariables('Use {{ }}', allowedVariables).message).toContain('cannot be empty');
    expect(validatePromptTemplateVariables('Use {{artifact_path', allowedVariables).message).toContain(
      'closing delimiter'
    );
  });

  it('defers validation until the supported list is available', () => {
    expect(validatePromptTemplateVariables('Use {{anything}}').valid).toBe(true);
  });

  it('accepts artifact path references to ancestor nodes', () => {
    const validation = validatePromptTemplateVariables(
      'Read {{artifact_path:base-test-setup}}/setup/base-test-setup.md',
      allowedVariables,
      {
        knownNodeIds: ['project-discovery', 'base-test-setup', 'consumer'],
        ancestorNodeIds: ['project-discovery', 'base-test-setup'],
        currentNodeId: 'consumer'
      }
    );

    expect(validation.valid).toBe(true);
    expect(validation.invalidArtifactReferences).toEqual([]);
  });

  it('accepts artifact handoff references to ancestor nodes', () => {
    const validation = validatePromptTemplateVariables('Read {{artifact_handoff:producer-tests}}.', allowedVariables, {
      knownNodeIds: ['property-specification-fanin', 'producer-tests', 'consumer'],
      ancestorNodeIds: ['property-specification-fanin', 'producer-tests'],
      currentNodeId: 'consumer'
    });

    expect(validation.valid).toBe(true);
    expect(validation.unknownVariables).toEqual([]);
    expect(validation.invalidArtifactReferences).toEqual([]);
  });

  it('accepts ancestor artifact helper references', () => {
    const direct = validatePromptTemplateVariables('Read:\n{{ancestor_artifacts}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(direct.valid).toBe(true);

    const selected = validatePromptTemplateVariables(
      'Read:\n{{ancestor_artifacts:producer, setup_node}}',
      allowedVariables,
      {
        knownNodeIds: ['setup_node', 'producer', 'consumer'],
        ancestorNodeIds: ['setup_node', 'producer'],
        currentNodeId: 'consumer'
      }
    );
    expect(selected.valid).toBe(true);
  });

  it('reports unknown and non-ancestor artifact path references', () => {
    const unknown = validatePromptTemplateVariables('Read {{artifact_path:missing}}/out.md', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.unknownVariables).toEqual(['artifact_path:missing']);

    const downstream = validatePromptTemplateVariables('Read {{artifact_path:downstream}}/out.md', allowedVariables, {
      knownNodeIds: ['producer', 'consumer', 'downstream'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(downstream.valid).toBe(false);
    expect(downstream.invalidArtifactReferences).toEqual(['artifact_path:downstream']);

    const noAncestors = validatePromptTemplateVariables('Read {{artifact_path:producer}}/out.md', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: [],
      currentNodeId: 'consumer'
    });
    expect(noAncestors.valid).toBe(false);
    expect(noAncestors.invalidArtifactReferences).toEqual(['artifact_path:producer']);
  });

  it('reports invalid ancestor artifact helper references', () => {
    const malformed = validatePromptTemplateVariables('Read {{ancestor_artifacts:}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(malformed.valid).toBe(false);
    expect(malformed.invalidArtifactReferences).toEqual(['ancestor_artifacts:']);

    const unknown = validatePromptTemplateVariables('Read {{ancestor_artifacts:missing}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.unknownVariables).toEqual(['ancestor_artifacts:missing']);

    const downstream = validatePromptTemplateVariables('Read {{ancestor_artifacts:downstream}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer', 'downstream'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(downstream.valid).toBe(false);
    expect(downstream.invalidArtifactReferences).toEqual(['ancestor_artifacts:downstream']);
  });

  it('reports invalid artifact handoff references', () => {
    const malformed = validatePromptTemplateVariables('Read {{artifact_handoff:}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(malformed.valid).toBe(false);
    expect(malformed.invalidArtifactReferences).toEqual(['artifact_handoff:']);

    const unknown = validatePromptTemplateVariables('Read {{artifact_handoff:missing}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.unknownVariables).toEqual(['artifact_handoff:missing']);

    const downstream = validatePromptTemplateVariables('Read {{artifact_handoff:downstream}}', allowedVariables, {
      knownNodeIds: ['producer', 'consumer', 'downstream'],
      ancestorNodeIds: ['producer'],
      currentNodeId: 'consumer'
    });
    expect(downstream.valid).toBe(false);
    expect(downstream.invalidArtifactReferences).toEqual(['artifact_handoff:downstream']);
  });
});
