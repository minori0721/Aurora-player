import test from 'node:test';
import assert from 'node:assert/strict';
import { getMembershipStatus, parseMembership } from '../src/netease/membership.js';

const now = 1_800_000_000_000;
const plan = (expiresAt = now + 1000) => ({ vipCode: 100, expireTime: expiresAt });
const ordinary = { redplus: null, associator: null, musicPackage: null };
const cases = [
    ['expired VIP keeps its growth level', { ...ordinary, redVipLevel: 3, associator: plan(now - 1) }, 0],
    ['V7 VIP is not SVIP', { ...ordinary, redVipLevel: 7, associator: plan() }, 1],
    ['SVIP does not require a high growth level', { ...ordinary, redVipLevel: 0, redplus: plan() }, 2],
    ['expired SVIP falls back to a remaining VIP plan', { ...ordinary, redplus: plan(now), associator: plan() }, 1],
    ['expired VIP falls back to an active music package', { ...ordinary, associator: plan(now), musicPackage: plan() }, 3],
    ['a package code cannot reactivate an expired music package', { ...ordinary, musicPackage: plan(now - 1) }, 0],
    ['disabling renewal does not expire the current plan', { ...ordinary, associator: { ...plan(), isSign: false, isSignDeduct: false } }, 1],
    ['renewal flags cannot reactivate an expired plan', { ...ordinary, associator: { ...plan(now), isSign: true, isSignDeduct: true } }, 0],
    ['a digital album or audiobook plan is not a music membership', { ...ordinary, albumVip: plan(), voiceBookVip: plan() }, 0],
    ['numeric timestamp strings remain valid', { ...ordinary, associator: plan(String(now + 1000)) }, 1],
    ['zero expiration is inactive', { ...ordinary, associator: plan(0) }, 0],
    ['a lone growth level cannot establish membership', { redVipLevel: 9 }, null],
    ['an empty response is unknown', {}, null],
    ['a missing expiration is unknown', { ...ordinary, associator: { vipCode: 100 } }, null],
    ['an invalid expiration is unknown', { ...ordinary, associator: plan('invalid') }, null],
    ['a negative expiration is not guessed to be lifetime membership', { ...ordinary, associator: plan(-1) }, null],
    ['an array is not a membership response', [], null]
];
for (const [name, data, type] of cases) {
    test(name, () => assert.equal(getMembershipStatus(parseMembership(data), now).type, type));
}

test('the next deadline belongs to the currently displayed plan, not a lower tier', () => {
    const membership = parseMembership({ ...ordinary, redplus: plan(now + 2000), associator: plan(now + 1000), musicPackage: plan(now + 3000) });
    assert.deepEqual(getMembershipStatus(membership, now), { type: 2, expiresAt: now + 2000 });
    assert.deepEqual(getMembershipStatus(membership, now + 2000), { type: 3, expiresAt: now + 3000 });
    assert.deepEqual(getMembershipStatus(membership, now + 3000), { type: 0, expiresAt: null });
});

test('server time is optional and kept separately from the package deadlines', () => {
    assert.equal(parseMembership({ ...ordinary, now }).serverNow, now);
    assert.equal(parseMembership(ordinary).serverNow, null);
});
