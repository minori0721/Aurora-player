import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistRows } from '../src/playlist/rows.js';
import { createHost, FakeElement } from './helpers/host.mjs';

function fixture(t, count) {
    const { host } = createHost();
    const previous = globalThis.document;
    globalThis.document = host.document;
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    const container = new FakeElement(), rows = createPlaylistRows(container);
    const items = Array.from({ length: count }, () => new FakeElement());
    rows.append(items, items.map(() => true));
    const effective = () => container.children.flatMap(child => child.className === 'pl-row-group'
        ? child.hidden ? [] : child.children.filter(row => !row.hidden) : child.hidden ? [] : [child]);
    return { container, rows, items, effective };
}

test('small lists remain flat; crossing the threshold groups original nodes without replacing them', t => {
    const f = fixture(t, 500);
    assert.equal(f.container.children.length, 500);
    const next = new FakeElement(); f.rows.append([next], [true]);
    assert.equal(f.container.children.length, 8);
    assert.equal(f.rows.length, 501);
    assert.equal(f.rows.at(0), f.items[0]);
    assert.equal(f.rows.at(500), next);
    assert.equal(f.effective().length, 501);
});

test('mixed -> hidden -> full filters keep exact counts, heights and original row identity', t => {
    const f = fixture(t, 1181);
    f.rows.filter(index => index === 63 || index === 64 || index === 1180);
    assert.deepEqual(f.rows.visibleIndexes(), [63, 64, 1180]);
    assert.deepEqual(f.effective(), [f.items[63], f.items[64], f.items[1180]]);
    assert.equal(f.container.children[0].style['--playlist-visible-rows'], '1');
    f.rows.filter(() => false);
    assert.equal(f.rows.visibleCount, 0); assert.deepEqual(f.effective(), []);
    f.rows.filter(() => true);
    assert.equal(f.rows.visibleCount, 1181); assert.deepEqual(f.effective(), f.items);
    assert.equal(f.container.children.at(-1).style['--playlist-visible-rows'], String(1181 % 64));
});

test('offscreen metadata and append can reveal a previously hidden group during filtering', t => {
    const f = fixture(t, 512);
    f.rows.filter(() => false);
    f.rows.setVisible(65, true);
    assert.deepEqual(f.effective(), [f.items[65]]);
    assert.deepEqual(f.rows.visibleIndexes(), [65]);
    const additions = Array.from({ length: 70 }, () => new FakeElement());
    f.rows.append(additions, additions.map((_, index) => index === 0 || index === 69));
    assert.deepEqual(f.rows.visibleIndexes(), [65, 512, 581]);
    assert.deepEqual(f.effective(), [f.items[65], additions[0], additions[69]]);
    f.rows.filter(() => true);
    assert.equal(f.effective().length, 582);
    f.rows.clear();
    assert.equal(f.rows.length, 0); assert.equal(f.rows.visibleCount, 0); assert.deepEqual(f.rows.visibleIndexes(), []);
});
