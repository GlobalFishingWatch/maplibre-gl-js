import assert from 'assert';
export function indexTouches(touches, points) {
    assert(touches.length === points.length);
    const obj = {};
    for (let i = 0; i < touches.length; i++) {
        obj[touches[i].identifier] = points[i];
    }
    return obj;
}
//# sourceMappingURL=handler_util.js.map