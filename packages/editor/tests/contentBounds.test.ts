import { createSampleDocument } from '@pitolet/schema';
import { describe, expect, it } from 'vitest';
import { editingContentBounds } from '../src/canvas/contentBounds.js';

describe('editingContentBounds', () => {
  it('fits normal page frames without distant component masters', () => {
    const doc = createSampleDocument();
    const page = doc.rootOrder
      .map((id) => doc.nodes[id])
      .find((node) => node?.type === 'frame' && !node.isComponentMaster);
    expect(page?.type).toBe('frame');
    if (!page || page.type !== 'frame') return;

    expect(editingContentBounds(doc)).toEqual({
      x: page.canvas.x,
      y: page.canvas.y,
      width: page.canvas.width,
      height: page.canvas.height === 'auto' ? 600 : page.canvas.height,
    });
  });

  it('fits an explicitly selected component master', () => {
    const doc = createSampleDocument();
    const page = doc.rootOrder.map((id) => doc.nodes[id]).find((node) => node?.type === 'frame');
    expect(page?.type).toBe('frame');
    if (!page || page.type !== 'frame') return;
    const master = {
      ...page,
      id: 'component-master',
      name: 'Component master',
      children: [],
      canvas: { x: 2000, y: 2400, width: 480, height: 'auto' as const },
      isComponentMaster: 'component-definition',
    };
    doc.nodes[master.id] = master;
    doc.rootOrder.push(master.id);

    expect(editingContentBounds(doc, [master.id])).toEqual({
      x: master.canvas.x,
      y: master.canvas.y,
      width: master.canvas.width,
      height: master.canvas.height === 'auto' ? 600 : master.canvas.height,
    });
  });

  it('uses a rendered height for long auto-height frames when available', () => {
    const doc = createSampleDocument();
    const page = doc.rootOrder
      .map((id) => doc.nodes[id])
      .find((node) => node?.type === 'frame' && !node.isComponentMaster);
    expect(page?.type).toBe('frame');
    if (!page || page.type !== 'frame') return;
    page.canvas.height = 'auto';

    expect(editingContentBounds(doc, [], () => 2480)).toEqual({
      x: page.canvas.x,
      y: page.canvas.y,
      width: page.canvas.width,
      height: 2480,
    });
  });
});
