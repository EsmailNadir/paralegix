import { buildForest, layoutForest, topoOrder, type TreeInput } from '@/lib/matterStages/stageTree';

const nodes: TreeInput[] = [
  { id: 'a', parentId: null, sortOrder: 0 },
  { id: 'b', parentId: 'a', sortOrder: 0 },
  { id: 'won', parentId: 'b', sortOrder: 0 },
  { id: 'lost', parentId: 'b', sortOrder: 1 },
];

test('buildForest returns roots with nested children in sortOrder', () => {
  const roots = buildForest(nodes);
  expect(roots).toHaveLength(1);
  expect(roots[0].id).toBe('a');
  expect(roots[0].children[0].id).toBe('b');
  expect(roots[0].children[0].children.map((c) => c.id)).toEqual(['won', 'lost']);
});

test('buildForest treats an unknown parentId as a root and guards cycles', () => {
  const cyclic: TreeInput[] = [
    { id: 'x', parentId: 'y', sortOrder: 0 },
    { id: 'y', parentId: 'x', sortOrder: 0 },
    { id: 'z', parentId: 'missing', sortOrder: 0 },
  ];
  const roots = buildForest(cyclic);
  const flat: string[] = [];
  const walk = (n: { id: string; children: { id: string; children: unknown[] }[] }) => {
    flat.push(n.id);
    n.children.forEach(walk as never);
  };
  roots.forEach(walk as never);
  expect(flat.sort()).toEqual(['x', 'y', 'z']);
});

test('layoutForest places leaves in order and centers parents over children', () => {
  const roots = buildForest(nodes);
  const laid = layoutForest(roots);
  const pos = Object.fromEntries(laid.map((n) => [n.id, n]));
  expect(pos.won.col).toBe(0);
  expect(pos.lost.col).toBe(1);
  expect(pos.b.col).toBeCloseTo(0.5);
  expect(pos.a.depth).toBe(0);
  expect(pos.b.depth).toBe(1);
  expect(pos.won.depth).toBe(2);
});

test('topoOrder lists every parent before its children', () => {
  const order = topoOrder(nodes);
  const idx = (id: string) => order.findIndex((n) => n.id === id);
  expect(idx('a')).toBeLessThan(idx('b'));
  expect(idx('b')).toBeLessThan(idx('won'));
  expect(idx('b')).toBeLessThan(idx('lost'));
});
