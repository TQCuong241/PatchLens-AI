import type { Rectangle, SourceCandidate, SourceLocation } from '@patchlens-ai/agent-protocol';

export type SourceResolver = {
  resolve(id: string): SourceLocation | undefined;
};

export type ElementSelectionInput = {
  elementId: string;
  patchlensId?: string;
  rectangle: Rectangle;
  depth: number;
  visible: boolean;
};

type ScoredSourceCandidate = SourceCandidate & {
  score: number;
};

export function rectangleArea(rectangle: Rectangle): number {
  return Math.max(0, rectangle.width) * Math.max(0, rectangle.height);
}

export function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );

  return width * height;
}

export function resolveClickSource(
  patchlensIds: readonly string[],
  resolver: SourceResolver,
): SourceCandidate | undefined {
  for (const id of patchlensIds) {
    const location = resolver.resolve(id);
    if (location) {
      return { location, confidence: 1 };
    }
  }

  return undefined;
}

export function rankDragSources(
  selection: Rectangle,
  elements: readonly ElementSelectionInput[],
  resolver: SourceResolver,
): SourceCandidate[] {
  const selectionArea = rectangleArea(selection);
  if (selectionArea === 0) {
    return [];
  }

  const candidates = new Map<string, ScoredSourceCandidate>();

  for (const element of elements) {
    const candidate = scoreElement(selection, selectionArea, element, resolver);
    if (!candidate) {
      continue;
    }

    const current = candidates.get(candidate.location.id);
    if (!current || current.score < candidate.score) {
      candidates.set(candidate.location.id, candidate);
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score)
    .map(({ location, score }) => ({ location, confidence: score }));
}

function scoreElement(
  selection: Rectangle,
  selectionArea: number,
  element: ElementSelectionInput,
  resolver: SourceResolver,
): ScoredSourceCandidate | undefined {
  if (!element.visible || !element.patchlensId) {
    return undefined;
  }

  const overlap = intersectionArea(selection, element.rectangle);
  const elementArea = rectangleArea(element.rectangle);
  if (overlap === 0 || elementArea === 0) {
    return undefined;
  }

  const location = resolver.resolve(element.patchlensId);
  if (!location) {
    return undefined;
  }

  const elementCoverage = overlap / elementArea;
  const selectionCoverage = overlap / selectionArea;
  const specificity = Math.min(Math.max(element.depth, 0) / 20, 1);
  const score = Math.min(1, elementCoverage * 0.55 + selectionCoverage * 0.35 + specificity * 0.1);

  return { location, confidence: score, score };
}
