import Point from '@mapbox/point-geometry';
import assert from 'assert';
export default class DOM {
    static testProp(props) {
        if (!DOM.docStyle)
            return props[0];
        for (let i = 0; i < props.length; i++) {
            if (props[i] in DOM.docStyle) {
                return props[i];
            }
        }
        return props[0];
    }
    static create(tagName, className, container) {
        const el = window.document.createElement(tagName);
        if (className !== undefined)
            el.className = className;
        if (container)
            container.appendChild(el);
        return el;
    }
    static createNS(namespaceURI, tagName) {
        const el = window.document.createElementNS(namespaceURI, tagName);
        return el;
    }
    static disableDrag() {
        if (DOM.docStyle && DOM.selectProp) {
            DOM.userSelect = DOM.docStyle[DOM.selectProp];
            DOM.docStyle[DOM.selectProp] = 'none';
        }
    }
    static enableDrag() {
        if (DOM.docStyle && DOM.selectProp) {
            DOM.docStyle[DOM.selectProp] = DOM.userSelect;
        }
    }
    static setTransform(el, value) {
        el.style[DOM.transformProp] = value;
    }
    static addEventListener(target, type, callback, options = {}) {
        if ('passive' in options) {
            target.addEventListener(type, callback, options);
        }
        else {
            target.addEventListener(type, callback, options.capture);
        }
    }
    static removeEventListener(target, type, callback, options = {}) {
        if ('passive' in options) {
            target.removeEventListener(type, callback, options);
        }
        else {
            target.removeEventListener(type, callback, options.capture);
        }
    }
    // Suppress the next click, but only if it's immediate.
    static suppressClickInternal(e) {
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('click', DOM.suppressClickInternal, true);
    }
    static suppressClick() {
        window.addEventListener('click', DOM.suppressClickInternal, true);
        window.setTimeout(() => {
            window.removeEventListener('click', DOM.suppressClickInternal, true);
        }, 0);
    }
    static mousePos(el, e) {
        const rect = el.getBoundingClientRect();
        return new Point(e.clientX - rect.left - el.clientLeft, e.clientY - rect.top - el.clientTop);
    }
    static touchPos(el, touches) {
        const rect = el.getBoundingClientRect();
        const points = [];
        for (let i = 0; i < touches.length; i++) {
            points.push(new Point(touches[i].clientX - rect.left - el.clientLeft, touches[i].clientY - rect.top - el.clientTop));
        }
        return points;
    }
    static mouseButton(e) {
        assert(e.type === 'mousedown' || e.type === 'mouseup');
        return e.button;
    }
    static remove(node) {
        if (node.parentNode) {
            node.parentNode.removeChild(node);
        }
    }
}
DOM.docStyle = typeof window !== 'undefined' && window.document && window.document.documentElement.style;
DOM.selectProp = DOM.testProp(['userSelect', 'MozUserSelect', 'WebkitUserSelect', 'msUserSelect']);
DOM.transformProp = DOM.testProp(['transform', 'WebkitTransform']);
//# sourceMappingURL=dom.js.map