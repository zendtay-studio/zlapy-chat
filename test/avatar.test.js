const assert = require('node:assert/strict');
const test = require('node:test');
const { createDefaultAvatarSvg } = require('../src/shared/avatar.js');

test('generates a stable SVG identicon from the account UID', () => {
    const first = createDefaultAvatarSvg('uid-1');
    assert.match(first, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(first, createDefaultAvatarSvg('uid-1'));
    assert.notEqual(first, createDefaultAvatarSvg('uid-2'));
});

test('uses a framed, flat pixel pattern mirrored across the vertical axis', () => {
    const svg = createDefaultAvatarSvg('uid-reference');
    assert.match(svg, /viewBox="0 0 100 100"/);
    assert.match(svg, /<rect width="100" height="100" fill="#171717"\/>/);
    assert.match(svg, /<rect x="1" y="1" width="98" height="98" fill="hsl\(\d+ \d+% \d+%\)"\/>/);
    assert.doesNotMatch(svg, /rx=|linearGradient|radialGradient/);

    const cells = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="9\.8" height="9\.8"\/>/g)]
        .map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
    assert.ok(cells.length > 0);
    const cellPositions = new Set(cells.map(({ x, y }) => `${x},${y}`));
    for (const { x, y } of cells) {
        const mirrorX = Number((100 - x - 9.8).toFixed(10));
        assert.ok(cellPositions.has(`${mirrorX},${y}`));
    }
});

test('chooses a UID-specific pastel hue with a darker matching pattern', () => {
    const getColors = uid => {
        const svg = createDefaultAvatarSvg(uid);
        const colors = [...svg.matchAll(/fill="hsl\((\d+) (\d+)% (\d+)%\)"/g)]
            .map(([, hue, saturation, lightness]) => ({
                hue: Number(hue), saturation: Number(saturation), lightness: Number(lightness)
            }));
        assert.equal(colors.length, 2);
        return colors;
    };
    const [background, pattern] = getColors('uid-1');
    assert.notDeepEqual(getColors('uid-1'), getColors('uid-2'));
    assert.equal(pattern.hue, background.hue);
    assert.equal(pattern.saturation, Math.min(100, background.saturation + 8));
    assert.equal(pattern.lightness, background.lightness - 12);
    assert.ok(background.saturation >= 55 && background.saturation <= 70);
    assert.ok(background.lightness >= 84 && background.lightness <= 91);
});
