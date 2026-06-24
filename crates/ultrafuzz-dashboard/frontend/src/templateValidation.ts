export type TemplateValidation = {
  valid: boolean;
  message: string;
  unknownVariables: string[];
  invalidArtifactReferences: string[];
};

export function validatePromptTemplateVariables(
  markdown: string,
  supportedTemplateVariables: readonly string[] | undefined = [],
  artifactReferenceContext?: {
    knownNodeIds?: readonly string[];
    ancestorNodeIds?: readonly string[];
    currentNodeId?: string;
  }
): TemplateValidation {
  if (!supportedTemplateVariables.length) {
    return { valid: true, message: '', unknownVariables: [], invalidArtifactReferences: [] };
  }

  const supportedTemplateVariableSet = new Set<string>(supportedTemplateVariables);
  const knownNodeIds = new Set(artifactReferenceContext?.knownNodeIds ?? []);
  const ancestorNodeIds = new Set(artifactReferenceContext?.ancestorNodeIds ?? []);
  const hasGraphContext = knownNodeIds.size > 0 || Boolean(artifactReferenceContext?.currentNodeId);
  const issues: string[] = [];
  const unknownVariables = new Set<string>();
  const invalidArtifactReferences = new Set<string>();
  let offset = 0;

  while (offset < markdown.length) {
    const start = markdown.indexOf('{{', offset);
    if (start === -1) {
      break;
    }

    const afterStart = start + 2;
    const end = markdown.indexOf('}}', afterStart);
    if (end === -1) {
      issues.push('Template variable is missing a closing delimiter.');
      break;
    }

    const variable = markdown.slice(afterStart, end).trim();
    if (!variable) {
      issues.push('Template variable name cannot be empty.');
    } else if (isArtifactPathReference(variable)) {
      const target = artifactPathReferenceTarget(variable);
      if (target && !isValidNodeId(target)) {
        invalidArtifactReferences.add(variable);
      } else if (target && knownNodeIds.size && !knownNodeIds.has(target)) {
        unknownVariables.add(variable);
      } else if (
        target &&
        hasGraphContext &&
        (target === artifactReferenceContext?.currentNodeId || !ancestorNodeIds.has(target))
      ) {
        invalidArtifactReferences.add(variable);
      }
    } else if (isArtifactHandoffReference(variable)) {
      const target = artifactHandoffReferenceTarget(variable);
      if (!target || !isValidNodeId(target)) {
        invalidArtifactReferences.add(variable);
      } else if (knownNodeIds.size && !knownNodeIds.has(target)) {
        unknownVariables.add(variable);
      } else if (
        hasGraphContext &&
        (target === artifactReferenceContext?.currentNodeId || !ancestorNodeIds.has(target))
      ) {
        invalidArtifactReferences.add(variable);
      }
    } else if (isAncestorArtifactsReference(variable)) {
      const targets = ancestorArtifactsReferenceTargets(variable);
      const hasInvalidTargets =
        targets === null || hasDuplicates(targets) || targets.some((target) => !isValidNodeId(target));
      if (hasInvalidTargets) {
        invalidArtifactReferences.add(variable);
      } else {
        for (const target of targets) {
          const formattedTarget = `ancestor_artifacts:${target}`;
          if (knownNodeIds.size && !knownNodeIds.has(target)) {
            unknownVariables.add(formattedTarget);
          } else if (
            hasGraphContext &&
            (target === artifactReferenceContext?.currentNodeId || !ancestorNodeIds.has(target))
          ) {
            invalidArtifactReferences.add(formattedTarget);
          }
        }
      }
    } else if (!supportedTemplateVariableSet.has(variable)) {
      unknownVariables.add(variable);
    }

    offset = end + 2;
  }

  if (unknownVariables.size) {
    const formattedUnknown = [...unknownVariables].sort().map(formatTemplateVariable).join(', ');
    issues.push(`Unknown template variable ${formattedUnknown}.`);
  }
  if (invalidArtifactReferences.size) {
    const formattedInvalid = [...invalidArtifactReferences].sort().map(formatTemplateVariable).join(', ');
    issues.push(`Artifact reference ${formattedInvalid} must target an ancestor node.`);
  }

  return {
    valid: issues.length === 0,
    message: issues.length
      ? `${issues.join(' ')} Supported variables: ${supportedTemplateVariables.map(formatTemplateVariable).join(', ')}.`
      : '',
    unknownVariables: [...unknownVariables].sort(),
    invalidArtifactReferences: [...invalidArtifactReferences].sort()
  };
}

function formatTemplateVariable(variable: string): string {
  return `{{${variable}}}`;
}

function isArtifactPathReference(variable: string): boolean {
  return variable === 'artifact_path' || variable.startsWith('artifact_path:');
}

function isArtifactHandoffReference(variable: string): boolean {
  return variable.startsWith('artifact_handoff:');
}

function isAncestorArtifactsReference(variable: string): boolean {
  return variable === 'ancestor_artifacts' || variable.startsWith('ancestor_artifacts:');
}

function artifactPathReferenceTarget(variable: string): string | null {
  return variable.startsWith('artifact_path:') ? variable.slice('artifact_path:'.length) : null;
}

function artifactHandoffReferenceTarget(variable: string): string | null {
  return variable.startsWith('artifact_handoff:') ? variable.slice('artifact_handoff:'.length) : null;
}

function ancestorArtifactsReferenceTargets(variable: string): string[] | null {
  if (variable === 'ancestor_artifacts') {
    return [];
  }
  if (!variable.startsWith('ancestor_artifacts:')) {
    return null;
  }
  const targets = variable
    .slice('ancestor_artifacts:'.length)
    .split(',')
    .map((target) => target.trim());
  return targets.length > 0 && targets.every((target) => target.length > 0) ? targets : null;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isValidNodeId(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}
