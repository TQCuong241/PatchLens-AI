import { describe, expect, it } from 'vitest';

import { intersectionArea, rankDragSources, resolveClickSource } from '../src/index.js';

const locations = new Map([
  [
    'pl_button',
    {
      id: 'pl_button',
      framework: 'react' as const,
      componentName: 'PrimaryButton',
      file: 'src/PrimaryButton.tsx',
      line: 10,
      column: 2,
    },
  ],
  [
    'pl_card',
    {
      id: 'pl_card',
      framework: 'react' as const,
      componentName: 'PricingCard',
      file: 'src/PricingCard.tsx',
      line: 20,
      column: 2,
    },
  ],
]);

const resolver = {
  resolve(id: string) {
    return locations.get(id);
  },
};

describe('selection geometry', () => {
  it('calculates rectangle intersection', () => {
    expect(
      intersectionArea(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 50, y: 50, width: 100, height: 100 },
      ),
    ).toBe(2500);
  });
});

describe('click selection', () => {
  it('uses the nearest resolvable PatchLens ID', () => {
    expect(resolveClickSource(['missing', 'pl_button'], resolver)?.location.id).toBe('pl_button');
  });
});

describe('drag selection', () => {
  it('ranks the most covered element first', () => {
    const candidates = rankDragSources(
      { x: 0, y: 0, width: 200, height: 200 },
      [
        {
          elementId: 'button',
          patchlensId: 'pl_button',
          rectangle: { x: 0, y: 0, width: 100, height: 100 },
          depth: 8,
          visible: true,
        },
        {
          elementId: 'card',
          patchlensId: 'pl_card',
          rectangle: { x: 150, y: 150, width: 200, height: 200 },
          depth: 4,
          visible: true,
        },
      ],
      resolver,
    );

    expect(candidates.map((candidate) => candidate.location.id)).toEqual(['pl_button', 'pl_card']);
  });

  it('ignores invisible and unresolved elements', () => {
    expect(
      rankDragSources(
        { x: 0, y: 0, width: 100, height: 100 },
        [
          {
            elementId: 'hidden',
            patchlensId: 'pl_button',
            rectangle: { x: 0, y: 0, width: 50, height: 50 },
            depth: 2,
            visible: false,
          },
          {
            elementId: 'unknown',
            patchlensId: 'missing',
            rectangle: { x: 0, y: 0, width: 50, height: 50 },
            depth: 2,
            visible: true,
          },
        ],
        resolver,
      ),
    ).toEqual([]);
  });
});
